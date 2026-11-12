/**
 * Agents at work, as the browser sees them: the entries the server publishes
 * in a board's awareness (one per agent session, and one from the system
 * actor carrying the live session list), sorted out from people's own
 * entries; sessions grouped per agent; where an agent's pointer chip sits;
 * and the live session list as a tree.
 *
 * Everything that comes from awareness is untrusted and parsed defensively.
 */
import {
  type Actor,
  type AgentPresence,
  AgentPresenceSchema,
  type AgentStatus,
  type LiveSessions,
  type Session,
  type SessionStep,
} from '@openboard/core';
import { absoluteRect, type PlacementMap, type XY } from './geometry.js';
import { colorFor } from './identity.js';

export interface AgentSession {
  clientId: number;
  actor: Actor;
  color: string;
  /** `<actor id>/<session>`, unique per session. */
  key: string;
  session: string;
  status: AgentStatus;
  /** Untrusted one-liner (a tool and its argument). Plain text only. */
  detail?: string;
  focus: readonly string[];
  parent?: string;
  at: string;
}

export interface PresencePartition<P> {
  people: P[];
  agents: AgentSession[];
  live: LiveSessions | null;
}

function parseActor(raw: unknown): Actor | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const a = raw as Record<string, unknown>;
  if (typeof a.id !== 'string' || typeof a.name !== 'string') return null;
  const kind = a.kind === 'agent' || a.kind === 'system' ? a.kind : 'human';
  const actor: Actor = { id: a.id, name: a.name.slice(0, 80) || 'Someone', kind };
  if (typeof a.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(a.color)) actor.color = a.color;
  return actor;
}

const str = (v: unknown, max = 200): string | undefined =>
  typeof v === 'string' ? v.slice(0, max) : undefined;
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function parseStep(raw: unknown): SessionStep | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const at = str(r.at, 40);
  const tool = str(r.tool, 80);
  if (!at || tool === undefined) return null;
  const step: SessionStep = { at, tool, summary: str(r.summary) ?? '' };
  if (typeof r.ok === 'boolean') step.ok = r.ok;
  return step;
}

/** One session from the live list; null when it is not usable. */
export function parseSession(raw: unknown): Session | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id, 64);
  const actor = str(r.actor, 64);
  const status =
    r.status === 'active' || r.status === 'idle' || r.status === 'ended' ? r.status : null;
  const startedAt = str(r.startedAt, 40);
  const lastAt = str(r.lastAt, 40);
  if (!id || !actor || !status || !startedAt || !lastAt) return null;
  const counts = (r.counts ?? {}) as Record<string, unknown>;
  const session: Session = {
    id,
    actor,
    status,
    startedAt,
    lastAt,
    recent: Array.isArray(r.recent)
      ? r.recent.map(parseStep).filter((s): s is SessionStep => s !== null)
      : [],
    counts: { tools: num(counts.tools), errors: num(counts.errors) },
    children: Array.isArray(r.children)
      ? r.children.filter((c): c is string => typeof c === 'string')
      : [],
  };
  const parent = str(r.parent, 64);
  if (parent) session.parent = parent;
  const label = str(r.label, 80);
  if (label) session.label = label;
  const endedAt = str(r.endedAt, 40);
  if (endedAt) session.endedAt = endedAt;
  const current = r.current as Record<string, unknown> | undefined;
  const tool = str(current?.tool, 80);
  const since = str(current?.since, 40);
  if (current && tool !== undefined && since)
    session.current = { tool, summary: str(current.summary) ?? '', since };
  return session;
}

function parseLive(raw: unknown): LiveSessions | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.sessions)) return null;
  return {
    sessions: r.sessions
      .slice(0, 50)
      .map(parseSession)
      .filter((s): s is Session => s !== null),
    at: str(r.at, 40) ?? '',
  };
}

/**
 * Sort awareness entries into people (passed through `parsePerson`), agent
 * sessions, and the system's live session list. The system entry and agent
 * entries never count as people, so no pointer or avatar is drawn for them.
 */
export function partitionPresence<P>(
  entries: Iterable<[number, unknown]>,
  parsePerson: (clientId: number, raw: unknown) => P | null,
): PresencePartition<P> {
  const people: P[] = [];
  const agents: AgentSession[] = [];
  let live: LiveSessions | null = null;
  for (const [clientId, raw] of entries) {
    if (typeof raw !== 'object' || raw === null) continue;
    const state = raw as Record<string, unknown>;
    const actor = parseActor(state.actor);
    if (!actor) continue;
    if (actor.kind === 'system') {
      if (state.live !== undefined) live = parseLive(state.live) ?? live;
      continue;
    }
    // Agent sessions the server publishes carry `agent`; an agent without it is a
    // client of its own (with a pointer and a selection) and listed like a person.
    if (state.agent !== undefined) {
      const parsed = AgentPresenceSchema.safeParse(state.agent);
      if (!parsed.success) continue;
      const p: AgentPresence = parsed.data;
      const session = p.session ?? 'default';
      const entry: AgentSession = {
        clientId,
        actor: { ...actor, kind: 'agent' },
        color: colorFor({ ...actor, kind: 'agent' }),
        key: `${actor.id}/${session}`,
        session,
        status: p.status,
        focus: p.focus ?? [],
        at: p.at,
      };
      if (p.detail) entry.detail = p.detail;
      if (p.parent) entry.parent = p.parent;
      agents.push(entry);
      continue;
    }
    const person = parsePerson(clientId, raw);
    if (person) people.push(person);
  }
  agents.sort((a, b) => a.actor.name.localeCompare(b.actor.name) || a.key.localeCompare(b.key));
  return { people, agents, live };
}

// ── Grouping ─────────────────────────────────────────────────────────────────

const STATUS_RANK: Record<AgentStatus, number> = {
  writing: 4,
  reading: 3,
  working: 2,
  waiting: 1,
  idle: 0,
};

export const STATUS_LABEL: Record<AgentStatus, string> = {
  writing: 'writing',
  reading: 'reading',
  working: 'working',
  waiting: 'waiting',
  idle: 'idle',
};

export function busier(a: AgentStatus, b: AgentStatus): AgentStatus {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

export interface AgentGroup {
  actor: Actor;
  color: string;
  sessions: AgentSession[];
  /** The busiest status among its sessions. */
  status: AgentStatus;
}

/** Sessions of the same agent under one entry, busiest agents first. */
export function groupByAgent(sessions: readonly AgentSession[]): AgentGroup[] {
  const groups = new Map<string, AgentGroup>();
  for (const s of sessions) {
    const group = groups.get(s.actor.id);
    if (group) {
      group.sessions.push(s);
      group.status = busier(group.status, s.status);
    } else
      groups.set(s.actor.id, { actor: s.actor, color: s.color, sessions: [s], status: s.status });
  }
  return [...groups.values()].sort(
    (a, b) =>
      STATUS_RANK[b.status] - STATUS_RANK[a.status] || a.actor.name.localeCompare(b.actor.name),
  );
}

/** An agent session is working right now (not idle, not just waiting). */
export function isBusy(status: AgentStatus): boolean {
  return status === 'reading' || status === 'writing' || status === 'working';
}

/** How many agent sessions are working: busy presence entries and active live sessions, each once. */
export function workingCount(agents: readonly AgentSession[], live: LiveSessions | null): number {
  const keys = new Set<string>();
  for (const a of agents) if (isBusy(a.status)) keys.add(`${a.actor.id}/${a.session}`);
  for (const s of live?.sessions ?? []) if (s.status === 'active') keys.add(`${s.actor}/${s.id}`);
  return keys.size;
}

/**
 * Where an agent's pointer chip sits: the top-right corner of the first
 * focused node that is on the board, in canvas coordinates. Null when none is.
 */
export function cursorAnchor(focus: readonly string[], map: PlacementMap): XY | null {
  for (const id of focus) {
    const rect = absoluteRect(id, map);
    if (rect) return { x: rect.x + rect.w, y: rect.y };
  }
  return null;
}

// ── Session tree ─────────────────────────────────────────────────────────────

export interface SessionNode {
  session: Session;
  children: SessionNode[];
  /** Its parent is not in the list (ended and dropped, or never reported). */
  orphan: boolean;
  depth: number;
}

/**
 * The flat live list as a tree: subagents under their parent, in start
 * order; sessions whose parent is missing become roots marked `orphan`.
 * Ended sessions are left out unless a live subagent still hangs under them.
 * Roots keep the list's order (most recently active first).
 */
export function sessionTree(sessions: readonly Session[]): SessionNode[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const kids = new Map<string, Session[]>();
  for (const s of sessions) {
    if (!s.parent || !byId.has(s.parent) || s.parent === s.id) continue;
    kids.set(s.parent, [...(kids.get(s.parent) ?? []), s]);
  }
  const liveBelow = (s: Session, seen: Set<string>): boolean => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    if (s.status !== 'ended') return true;
    return (kids.get(s.id) ?? []).some((k) => liveBelow(k, seen));
  };
  const build = (s: Session, depth: number, orphan: boolean, path: Set<string>): SessionNode => {
    const next = new Set(path).add(s.id);
    const children = (kids.get(s.id) ?? [])
      .filter((k) => !next.has(k.id) && liveBelow(k, new Set()))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .map((k) => build(k, depth + 1, false, next));
    return { session: s, children, orphan, depth };
  };
  return sessions
    .filter((s) => !s.parent || !byId.has(s.parent) || s.parent === s.id)
    .filter((s) => liveBelow(s, new Set()))
    .map((s) => build(s, 0, Boolean(s.parent && s.parent !== s.id), new Set()));
}

/** Flatten a tree for rendering, depth first. */
export function flattenTree(nodes: readonly SessionNode[]): SessionNode[] {
  const out: SessionNode[] = [];
  const walk = (list: readonly SessionNode[]) => {
    for (const n of list) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** "12 s", "3 min 05 s", "1 h 02 min": how long something has been running. */
export function elapsed(sinceIso: string, now: number): string {
  const ms = Math.max(0, now - Date.parse(sinceIso));
  if (!Number.isFinite(ms)) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** Untrusted one-line text from agents' tools, cut to fit and with control characters gone. */
export function plainLine(text: string | undefined, max = 120): string {
  if (!text) return '';
  const clean = text
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
