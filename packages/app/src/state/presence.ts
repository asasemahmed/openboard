/**
 * Presence over the y-websocket awareness channel, in the `Presence` shape
 * from core. The local selection is published on every change, including
 * when it becomes empty: the server answers "what is the human pointing at?"
 * from it, so it must never be stale.
 */
import type { Actor, LiveSessions, Presence } from '@openboard/core';
import type { Awareness } from 'y-protocols/awareness';
import { type AgentSession, partitionPresence } from '../lib/agents.js';
import { colorFor } from '../lib/identity.js';
import { Emitter } from './emitter.js';

export interface XY {
  x: number;
  y: number;
}

export interface Peer {
  clientId: number;
  actor: Actor;
  color: string;
  cursor?: XY;
  nodeIds: readonly string[];
  edgeIds: readonly string[];
}

export function selectionPayload(
  nodeIds: readonly string[],
  edgeIds: readonly string[],
  now: Date = new Date(),
): NonNullable<Presence['selection']> {
  return { nodeIds: [...nodeIds].sort(), edgeIds: [...edgeIds].sort(), at: now.toISOString() };
}

export function presenceState(
  actor: Actor,
  cursor: XY | null,
  selection: NonNullable<Presence['selection']>,
): Presence {
  const state: Presence = { actor: { ...actor }, selection };
  if (cursor) state.cursor = { x: Math.round(cursor.x), y: Math.round(cursor.y) };
  return state;
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string');

/** Read a peer's awareness state defensively: any client can publish anything. */
export function parsePeer(clientId: number, raw: unknown): Peer | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const state = raw as Record<string, unknown>;
  const actor = state.actor as Record<string, unknown> | undefined;
  if (!actor || typeof actor.id !== 'string' || typeof actor.name !== 'string') return null;
  const kind = actor.kind === 'agent' || actor.kind === 'system' ? actor.kind : 'human';
  const parsedActor: Actor = {
    id: actor.id,
    name: actor.name.slice(0, 80) || 'Someone',
    kind,
    ...(typeof actor.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(actor.color)
      ? { color: actor.color }
      : {}),
  };
  const peer: Peer = {
    clientId,
    actor: parsedActor,
    color: colorFor(parsedActor),
    nodeIds: [],
    edgeIds: [],
  };
  const cursor = state.cursor as Record<string, unknown> | undefined;
  if (
    cursor &&
    typeof cursor.x === 'number' &&
    typeof cursor.y === 'number' &&
    Number.isFinite(cursor.x) &&
    Number.isFinite(cursor.y)
  ) {
    peer.cursor = { x: cursor.x, y: cursor.y };
  }
  const selection = state.selection as Record<string, unknown> | undefined;
  if (selection) {
    if (isStringArray(selection.nodeIds)) peer.nodeIds = selection.nodeIds.slice(0, 500);
    if (isStringArray(selection.edgeIds)) peer.edgeIds = selection.edgeIds.slice(0, 500);
  }
  return peer;
}

const CURSOR_INTERVAL_MS = 50;

export class PresenceStore extends Emitter {
  readonly awareness: Awareness;
  private actor: Actor;
  private cursor: XY | null = null;
  private selection: NonNullable<Presence['selection']>;
  private cursorTimer: ReturnType<typeof setTimeout> | null = null;
  private lastCursorSent = 0;

  /** Other participants, one entry per connected client. */
  peers: readonly Peer[] = [];
  /** Participants deduplicated by actor (someone with two tabs open appears once). */
  participants: readonly Peer[] = [];
  private participantsKey = '';
  private byNode = new Map<string, string>();
  /** Agent sessions the server publishes for this board. */
  agents: readonly AgentSession[] = [];
  private agentsKey = '';
  /** The live session list the server publishes, or null before it has. */
  live: LiveSessions | null = null;
  private liveKey = '';
  private agentsByNode = new Map<string, string>();

  private readonly onChange = () => this.refresh();

  constructor(awareness: Awareness, actor: Actor) {
    super();
    this.awareness = awareness;
    this.actor = actor;
    this.selection = selectionPayload([], []);
    awareness.on('change', this.onChange);
    this.publish();
    this.refresh();
  }

  destroy(): void {
    if (this.cursorTimer) clearTimeout(this.cursorTimer);
    this.awareness.off('change', this.onChange);
  }

  readonly getPeers = (): readonly Peer[] => this.peers;
  readonly getAgents = (): readonly AgentSession[] => this.agents;
  readonly getLive = (): LiveSessions | null => this.live;

  /** Agents reading or writing this node: "color|name|status" entries joined by newlines. */
  agentsOnNode(nodeId: string): string {
    return this.agentsByNode.get(nodeId) ?? '';
  }
  readonly getParticipants = (): readonly Peer[] => this.participants;

  /** A stable key for who has `nodeId` selected: "color|name" entries joined by newlines. */
  peersOnNode(nodeId: string): string {
    return this.byNode.get(nodeId) ?? '';
  }

  /** The state this client publishes. */
  localState(): Presence {
    return presenceState(this.actor, this.cursor, this.selection);
  }

  setActor(actor: Actor): void {
    this.actor = actor;
    this.publish();
  }

  setSelection(nodeIds: readonly string[], edgeIds: readonly string[]): void {
    this.selection = selectionPayload(nodeIds, edgeIds);
    this.publish();
  }

  /** Pointer position in canvas coordinates, or null when it left the canvas. Throttled. */
  setCursor(cursor: XY | null): void {
    this.cursor = cursor;
    if (cursor === null) {
      if (this.cursorTimer) clearTimeout(this.cursorTimer);
      this.cursorTimer = null;
      this.publish();
      return;
    }
    const wait = CURSOR_INTERVAL_MS - (Date.now() - this.lastCursorSent);
    if (wait <= 0) {
      this.publish();
      return;
    }
    if (!this.cursorTimer) {
      this.cursorTimer = setTimeout(() => {
        this.cursorTimer = null;
        this.publish();
      }, wait);
    }
  }

  private publish(): void {
    this.lastCursorSent = Date.now();
    this.awareness.setLocalState(this.localState());
  }

  private refresh(): void {
    const own = this.awareness.clientID;
    const entries = [...this.awareness.getStates()].filter(([clientId]) => clientId !== own);
    const split = partitionPresence(entries, parsePeer);
    const peers = split.people.filter((peer) => peer.actor.id !== this.actor.id);
    const agentsKey = split.agents
      .map(
        (a) =>
          `${a.key}|${a.actor.name}|${a.status}|${a.detail ?? ''}|${a.focus.join(',')}|${a.at}`,
      )
      .join('\n');
    if (agentsKey !== this.agentsKey) {
      this.agents = split.agents;
      this.agentsKey = agentsKey;
      const onNode = new Map<string, string[]>();
      for (const a of split.agents) {
        if (a.status !== 'reading' && a.status !== 'writing') continue;
        for (const id of a.focus) {
          const entry = `${a.color}|${a.actor.name}|${a.status}`;
          onNode.set(id, [...(onNode.get(id) ?? []), entry]);
        }
      }
      this.agentsByNode = new Map([...onNode].map(([id, list]) => [id, list.join('\n')]));
    }
    const liveKey = split.live ? `${split.live.at}|${split.live.sessions.length}` : '';
    if (liveKey !== this.liveKey) {
      this.live = split.live;
      this.liveKey = liveKey;
    }
    peers.sort((a, b) => a.actor.name.localeCompare(b.actor.name) || a.clientId - b.clientId);
    const seen = new Set<string>();
    const participants = peers.filter((p) => {
      if (seen.has(p.actor.id)) return false;
      seen.add(p.actor.id);
      return true;
    });
    const byNode = new Map<string, string[]>();
    for (const peer of participants) {
      for (const id of peer.nodeIds) {
        const list = byNode.get(id);
        const entry = `${peer.color}|${peer.actor.name}`;
        if (list) list.push(entry);
        else byNode.set(id, [entry]);
      }
    }
    this.peers = peers;
    const key = participants.map((p) => `${p.actor.id}|${p.actor.name}|${p.color}`).join('\n');
    if (key !== this.participantsKey) {
      this.participants = participants;
      this.participantsKey = key;
    }
    this.byNode = new Map([...byNode].map(([id, list]) => [id, list.join('\n')]));
    this.emit();
  }
}
