/**
 * Live work: agent presence, activity sessions and claim upkeep, for every
 * board of the project. Memory only: nothing here is written to disk, the
 * change feed or the history, and a restart starts empty.
 *
 * Agents are not sync peers, so the server publishes their presence into each
 * board's awareness itself: one entry per agent and session, `{ actor, agent }`
 * (see `Presence` in core). The session list reaches browsers the same way,
 * as one entry per board, `{ actor: SYSTEM_ACTOR, live: LiveSessions }`.
 * Awareness was chosen over a separate event stream because browsers already
 * hold an awareness connection per open board: no second channel, no second
 * set of origin checks, and the session list arrives with the presence it
 * explains.
 *
 * Each published entry belongs to a small private `Awareness` (a "puppet")
 * whose updates are applied to the board's awareness, so entries have their
 * own client ids and clocks and expire like any peer's if the server stops
 * renewing them.
 *
 * Activity text is untrusted and may be sensitive (paths, command lines):
 * control characters are stripped and lengths cut before anything is kept.
 */
import {
  ACTIVITY_LABEL_MAX,
  ACTIVITY_SUMMARY_MAX,
  type ActivityEvent,
  type Actor,
  AGENT_IDLE_MS,
  AGENT_PRESENCE_TTL_MS,
  type AgentPresence,
  type AgentStatus,
  type Claim,
  DEFAULT_SESSION,
  ENDED_SESSION_TTL_MS,
  LIVE_RECENT_MAX,
  LIVE_SESSIONS_MAX,
  type LiveSessions,
  OpenBoardError,
  PRESENCE_FOCUS_MAX,
  type Presence,
  SESSION_RECENT,
  SESSIONS_KEPT,
  type Session,
  SYSTEM_ACTOR,
} from '@openboard/core';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { errorMessage } from './fsutil.js';
import type { Room } from './room.js';

/** How often presence, sessions and claims are swept (real time). */
export const LIVE_SWEEP_MS = 5000;
/** Published entries are re-sent this often so peers do not time them out (real time). */
const RENEW_MS = 15_000;
const PUPPET_ORIGIN = 'openboard-server';

/** C0 and C1 control characters and the Unicode line and paragraph separators. */
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]+', 'g');

/** Strip control characters, collapse whitespace and cut to `max` characters. */
export function cleanText(text: string, max: number): string {
  const flat = text.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 3))}...`;
}

/** One awareness entry the server owns. */
class Puppet {
  private readonly ydoc = new Y.Doc();
  private readonly awareness = new Awareness(this.ydoc);
  private renewedAt = 0;

  constructor(private readonly target: Awareness) {}

  set(state: Record<string, unknown> | null): void {
    this.awareness.setLocalState(state);
    applyAwarenessUpdate(
      this.target,
      encodeAwarenessUpdate(this.awareness, [this.awareness.clientID]),
      PUPPET_ORIGIN,
    );
    this.renewedAt = Date.now();
  }

  renewIfDue(): void {
    const state = this.awareness.getLocalState();
    if (state && Date.now() - this.renewedAt >= RENEW_MS) this.set({ ...state });
  }

  destroy(): void {
    try {
      this.set(null);
    } catch {
      // The board's awareness may already be gone.
    }
    this.awareness.destroy();
    this.ydoc.destroy();
  }
}

interface PresenceEntry {
  actor: Actor;
  session: string;
  parent?: string;
  status: AgentStatus;
  detail?: string;
  focus?: string[];
  /** Clock time of the last activity. */
  last: number;
  /** Clock time of the last status change, published as `at`. */
  since: number;
  puppet: Puppet;
}

interface SessionState extends Session {
  last: number;
  ended?: number;
}

export interface LiveOptions {
  clock: () => number;
  rooms: () => Room[];
  log?: (line: string) => void;
}

export class LiveHub {
  private readonly presence = new Map<Room, Map<string, PresenceEntry>>();
  private readonly sessionPuppets = new Map<Room, Puppet>();
  private readonly sessions = new Map<string, SessionState>();
  /** Boards each actor touched through the API since the server started. */
  private readonly touched = new Map<string, Set<Room>>();
  /** Actors seen by this hub, for labels. */
  private readonly seenActors = new Map<string, Actor>();
  private readonly timer: NodeJS.Timeout;
  private publishQueued = false;
  private closed = false;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: LiveOptions) {
    this.log = opts.log ?? (() => {});
    this.timer = setInterval(() => {
      try {
        this.sweep();
      } catch (error) {
        this.log(`live sweep: ${errorMessage(error)}`);
      }
    }, LIVE_SWEEP_MS);
    this.timer.unref();
  }

  private now(): number {
    return this.opts.clock();
  }

  private iso(ms: number): string {
    return new Date(ms).toISOString();
  }

  // ── Presence ───────────────────────────────────────────────────────────────

  /**
   * Record an agent's API call on a board: its status, what it focused on, and
   * that it is active (which also renews its claims there). Non-agents are
   * ignored.
   */
  mark(
    room: Room,
    actor: Actor,
    session: string | undefined,
    status: Exclude<AgentStatus, 'idle'>,
    focus?: readonly string[],
  ): void {
    if (actor.kind !== 'agent' || this.closed) return;
    this.seenActors.set(actor.id, actor);
    let rooms = this.touched.get(actor.id);
    if (!rooms) {
      rooms = new Set();
      this.touched.set(actor.id, rooms);
    }
    rooms.add(room);
    const entry = this.entry(room, actor, session ?? DEFAULT_SESSION);
    const now = this.now();
    if (entry.status !== status) entry.since = now;
    entry.status = status;
    entry.last = now;
    if (status !== 'working') delete entry.detail;
    if (focus !== undefined) {
      const ids = [...new Set(focus)].slice(0, PRESENCE_FOCUS_MAX);
      if (ids.length > 0) entry.focus = ids;
      else delete entry.focus;
    }
    this.publish(room, entry);
    this.renewClaims(room, actor.id);
  }

  /** The presence entries of a board, as published; for tests and diagnostics. */
  presenceOf(room: Room): Array<{ actor: Actor; agent: AgentPresence }> {
    return [...(this.presence.get(room)?.values() ?? [])].map((entry) => ({
      actor: entry.actor,
      agent: this.agentState(entry),
    }));
  }

  private entry(room: Room, actor: Actor, session: string): PresenceEntry {
    let entries = this.presence.get(room);
    if (!entries) {
      entries = new Map();
      this.presence.set(room, entries);
    }
    const key = `${actor.id}\u0000${session}`;
    let entry = entries.get(key);
    if (!entry) {
      const now = this.now();
      entry = {
        actor,
        session,
        status: 'idle',
        last: now,
        since: now,
        puppet: new Puppet(room.awareness),
      };
      const parent = this.sessions.get(session)?.parent;
      if (parent) entry.parent = parent;
      entries.set(key, entry);
    }
    entry.actor = actor;
    return entry;
  }

  private agentState(entry: PresenceEntry): AgentPresence {
    const agent: AgentPresence = {
      status: entry.status,
      session: entry.session,
      at: this.iso(entry.since),
    };
    if (entry.detail) agent.detail = entry.detail;
    if (entry.focus) agent.focus = entry.focus;
    if (entry.parent) agent.parent = entry.parent;
    return agent;
  }

  private publish(_room: Room, entry: PresenceEntry): void {
    const state: Presence = { actor: entry.actor, agent: this.agentState(entry) };
    entry.puppet.set(state as unknown as Record<string, unknown>);
  }

  private removeEntry(room: Room, key: string): void {
    const entries = this.presence.get(room);
    const entry = entries?.get(key);
    if (!entry) return;
    entries?.delete(key);
    entry.puppet.destroy();
  }

  private waitsOnSomeone(room: Room, actorId: string): boolean {
    return (
      room.doc.proposals().some((p) => p.author === actorId && p.status === 'pending') ||
      room.doc.asks().some((a) => a.author === actorId && a.status === 'open')
    );
  }

  // ── Claims ─────────────────────────────────────────────────────────────────

  /** Claims on a board that are still in force at the current clock time, by node id. */
  activeClaims(room: Room): Map<string, Claim> {
    const now = this.now();
    const out = new Map<string, Claim>();
    for (const claim of room.doc.claims()) {
      if (Date.parse(claim.until) > now && room.doc.getNode(claim.nodeId)) {
        out.set(claim.nodeId, claim);
      }
    }
    return out;
  }

  /** Extend the holder's claims that are past half their length. */
  private renewClaims(room: Room, actorId: string): void {
    const now = this.now();
    for (const claim of this.activeClaims(room).values()) {
      if (claim.by !== actorId) continue;
      const length = claim.minutes * 60_000;
      if (Date.parse(claim.until) - now >= length / 2) continue;
      room.doc.putClaim(
        { ...claim, until: this.iso(now + length) },
        room.doc.origin(actorId, 'ops'),
      );
    }
  }

  // ── Sessions ───────────────────────────────────────────────────────────────

  /** Record an activity event (already validated) by `actor`. Returns the session as it is now. */
  report(actor: Actor, event: ActivityEvent): Session {
    if (this.closed) throw new OpenBoardError('unavailable', 'the server is shutting down');
    this.seenActors.set(actor.id, actor);
    const now = this.now();
    const at = event.at ?? this.iso(now);
    const existing = this.sessions.get(event.session);
    if (existing && existing.actor !== actor.id) {
      throw new OpenBoardError(
        'forbidden',
        `session "${event.session}" belongs to another actor (${existing.actor})`,
      );
    }
    const session = existing ?? this.newSession(event, actor, at, now);
    if (event.parent && !session.parent && event.parent !== session.id) {
      session.parent = event.parent;
    }
    if (session.parent) {
      const parent = this.sessions.get(session.parent);
      if (parent && parent.actor === actor.id && !parent.children.includes(session.id)) {
        parent.children.push(session.id);
      }
    }
    if (event.label) session.label = cleanText(event.label, ACTIVITY_LABEL_MAX);
    const tool = event.tool ? cleanText(event.tool, ACTIVITY_LABEL_MAX) : undefined;
    const summary = cleanText(event.summary ?? '', ACTIVITY_SUMMARY_MAX);
    const step = (name: string, ok?: boolean, into: Session = session, text = summary) => {
      const entry: Session['recent'][number] = { at, tool: name, summary: text };
      if (ok !== undefined) entry.ok = ok;
      into.recent.push(entry);
      if (into.recent.length > SESSION_RECENT) into.recent.shift();
    };
    // A subagent's start and end are steps of the session that started it.
    const parentOf = () => {
      const parent = session.parent ? this.sessions.get(session.parent) : undefined;
      return parent && parent.actor === actor.id ? parent : undefined;
    };
    session.last = now;
    session.lastAt = at;
    if (
      session.status === 'ended' &&
      event.kind !== 'session_end' &&
      event.kind !== 'subagent_end'
    ) {
      // Activity after the end: the session is alive again.
      session.status = 'active';
      delete session.endedAt;
      delete session.ended;
    }

    let detail: string | undefined;
    let ended = false;
    switch (event.kind) {
      case 'session_start':
      case 'subagent_start':
        detail = session.label ? `started ${session.label}` : 'started';
        if (event.kind === 'subagent_start') {
          const parent = parentOf();
          if (parent) step('subagent', undefined, parent, `started ${session.label ?? session.id}`);
        }
        break;
      case 'session_end':
      case 'subagent_end':
        ended = true;
        delete session.current;
        session.status = 'ended';
        session.endedAt = at;
        session.ended = now;
        if (event.kind === 'subagent_end') {
          const parent = parentOf();
          if (parent) step('subagent', event.ok, parent, `finished ${session.label ?? session.id}`);
        }
        break;
      case 'prompt':
        step('prompt');
        detail = 'working on a request';
        break;
      case 'tool_start':
        session.current = { tool: tool ?? 'tool', summary, since: at };
        detail = summary ? `${tool ?? 'tool'}: ${summary}` : (tool ?? 'tool');
        break;
      case 'tool_end':
        delete session.current;
        session.counts.tools++;
        if (event.ok === false) session.counts.errors++;
        step(tool ?? 'tool', event.ok);
        detail = summary ? `${tool ?? 'tool'}: ${summary}` : (tool ?? 'tool');
        break;
      case 'note':
        step('note');
        detail = summary || undefined;
        break;
    }

    this.updateWorking(actor, session, ended ? null : (detail ?? 'working'));
    this.trimSessions();
    this.queueSessionsPublish();
    return this.view(session);
  }

  private newSession(event: ActivityEvent, actor: Actor, at: string, now: number): SessionState {
    const session: SessionState = {
      id: event.session,
      actor: actor.id,
      status: 'active',
      startedAt: at,
      lastAt: at,
      recent: [],
      counts: { tools: 0, errors: 0 },
      children: [],
      last: now,
    };
    if (event.parent && event.parent !== event.session) session.parent = event.parent;
    this.sessions.set(session.id, session);
    return session;
  }

  /** Show the session as `working` on the boards the actor touched and the boards open in a browser. */
  private updateWorking(actor: Actor, session: SessionState, detail: string | null): void {
    const rooms = new Set(this.touched.get(actor.id) ?? []);
    for (const room of this.opts.rooms()) if (room.viewers > 0) rooms.add(room);
    const key = `${actor.id}\u0000${session.id}`;
    for (const room of rooms) {
      if (!this.opts.rooms().includes(room)) continue;
      if (detail === null) {
        this.removeEntry(room, key);
        continue;
      }
      const entry = this.entry(room, actor, session.id);
      if (session.parent) entry.parent = session.parent;
      const now = this.now();
      if (entry.status !== 'working') entry.since = now;
      entry.status = 'working';
      entry.detail = cleanText(detail, ACTIVITY_SUMMARY_MAX);
      entry.last = now;
      this.publish(room, entry);
    }
  }

  private statusOf(session: SessionState, now: number): Session['status'] {
    if (session.status === 'ended') return 'ended';
    if (session.current || now - session.last < AGENT_IDLE_MS) return 'active';
    return 'idle';
  }

  private view(session: SessionState, recent = SESSION_RECENT): Session {
    const { last: _last, ended: _ended, ...rest } = session;
    const out: Session = structuredClone(rest);
    out.status = this.statusOf(session, this.now());
    out.recent = out.recent.slice(-recent);
    return out;
  }

  /** Actors that reported activity or were marked present, by id. */
  actors(): Record<string, Actor> {
    return Object.fromEntries(this.seenActors);
  }

  /** Sessions, most recently active first. */
  list(includeEnded = false): Session[] {
    return [...this.sessions.values()]
      .filter((s) => includeEnded || s.status !== 'ended')
      .sort((a, b) => b.last - a.last || (a.id < b.id ? -1 : 1))
      .map((s) => this.view(s));
  }

  private trimSessions(): void {
    const now = this.now();
    for (const [id, session] of this.sessions) {
      if (session.ended !== undefined && now - session.ended > ENDED_SESSION_TTL_MS) {
        this.sessions.delete(id);
      }
    }
    if (this.sessions.size <= SESSIONS_KEPT) return;
    // Drop ended sessions first, then the least recently active.
    const order = [...this.sessions.values()].sort(
      (a, b) => Number(b.status === 'ended') - Number(a.status === 'ended') || a.last - b.last,
    );
    for (const session of order.slice(0, this.sessions.size - SESSIONS_KEPT)) {
      this.sessions.delete(session.id);
    }
  }

  /** The live session list as browsers see it. */
  liveSessions(): LiveSessions {
    return {
      sessions: this.list(false)
        .slice(0, LIVE_SESSIONS_MAX)
        .map((s) => ({ ...s, recent: s.recent.slice(-LIVE_RECENT_MAX) })),
      at: this.iso(this.now()),
    };
  }

  private queueSessionsPublish(): void {
    if (this.publishQueued) return;
    this.publishQueued = true;
    queueMicrotask(() => {
      this.publishQueued = false;
      if (!this.closed) this.publishSessions();
    });
  }

  /** Publish the session list on every open board. */
  publishSessions(): void {
    const live = this.liveSessions();
    for (const room of this.opts.rooms()) this.publishSessionsTo(room, live);
  }

  /** Call when a board opens, so its awareness carries the session list from the start. */
  roomOpened(room: Room): void {
    if (!this.closed) this.publishSessionsTo(room, this.liveSessions());
  }

  private publishSessionsTo(room: Room, live: LiveSessions): void {
    let puppet = this.sessionPuppets.get(room);
    if (!puppet) {
      puppet = new Puppet(room.awareness);
      this.sessionPuppets.set(room, puppet);
    }
    const state: Presence = { actor: SYSTEM_ACTOR, live };
    puppet.set(state as unknown as Record<string, unknown>);
  }

  // ── Sweeping ───────────────────────────────────────────────────────────────

  /**
   * Move quiet agents to `idle` (or `waiting`), drop long-quiet ones, drop old
   * sessions, delete expired claims, and re-send published entries. Runs on a
   * timer; tests with an injected clock call it directly.
   */
  sweep(): void {
    if (this.closed) return;
    const now = this.now();
    const open = new Set(this.opts.rooms());
    for (const [room, entries] of this.presence) {
      if (!open.has(room)) {
        for (const entry of entries.values()) entry.puppet.destroy();
        this.presence.delete(room);
        continue;
      }
      for (const [key, entry] of entries) {
        const quiet = now - entry.last;
        if (quiet > AGENT_PRESENCE_TTL_MS) {
          this.removeEntry(room, key);
          continue;
        }
        if (quiet > AGENT_IDLE_MS && entry.status !== 'idle' && entry.status !== 'waiting') {
          entry.status = this.waitsOnSomeone(room, entry.actor.id) ? 'waiting' : 'idle';
          entry.since = now;
          delete entry.detail;
          this.publish(room, entry);
        } else if (
          entry.status === 'waiting' &&
          quiet > AGENT_IDLE_MS &&
          !this.waitsOnSomeone(room, entry.actor.id)
        ) {
          entry.status = 'idle';
          entry.since = now;
          this.publish(room, entry);
        } else entry.puppet.renewIfDue();
      }
    }

    const before = JSON.stringify(this.list(true).map((s) => [s.id, s.status]));
    this.trimSessions();
    const after = JSON.stringify(this.list(true).map((s) => [s.id, s.status]));
    if (before !== after) this.publishSessions();
    else for (const puppet of this.sessionPuppets.values()) puppet.renewIfDue();

    for (const room of open) {
      const expired = room.doc
        .claims()
        .filter((c) => Date.parse(c.until) <= now || !room.doc.storedNode(c.nodeId))
        .map((c) => c.nodeId);
      if (expired.length > 0) room.doc.deleteClaims(expired, room.doc.origin('system', 'ops'));
    }
  }

  /** Forget a board that closed. */
  roomClosed(room: Room): void {
    for (const entry of this.presence.get(room)?.values() ?? []) entry.puppet.destroy();
    this.presence.delete(room);
    this.sessionPuppets.get(room)?.destroy();
    this.sessionPuppets.delete(room);
    for (const rooms of this.touched.values()) rooms.delete(room);
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    for (const room of [...this.presence.keys(), ...this.sessionPuppets.keys()])
      this.roomClosed(room);
  }
}
