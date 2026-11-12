/**
 * Work in progress, made visible: what agents are doing right now (presence
 * and activity sessions), which nodes an agent is working on (claims), and how
 * a board came to be (replay, see `BoardApi.snapshotAt`).
 *
 * Presence and sessions are memory only on the server and never reach the
 * board file, the change feed or the history. Claims live in the board
 * document (top-level map `claims`, keyed by node id) so every browser sees
 * them, but they are working state like proposals: not saved in the board
 * file and not part of the history.
 */
import { z } from 'zod';
import { IdSchema } from './schema.js';

// ── Timing and limits ────────────────────────────────────────────────────────

/** An agent with no activity for this long is shown as `idle` (or `waiting`). */
export const AGENT_IDLE_MS = 20_000;
/** An agent with no activity for this long disappears from presence. */
export const AGENT_PRESENCE_TTL_MS = 10 * 60_000;
/** Session used for agent calls that do not name one. */
export const DEFAULT_SESSION = 'default';
/** Sessions kept by the server (most recently active first). */
export const SESSIONS_KEPT = 200;
/** An ended session is dropped this long after it ended. */
export const ENDED_SESSION_TTL_MS = 30 * 60_000;
/** Entries of `Session.recent`. */
export const SESSION_RECENT = 20;
/** At most this many node ids in `AgentPresence.focus`. */
export const PRESENCE_FOCUS_MAX = 20;
export const CLAIM_DEFAULT_MINUTES = 15;
export const CLAIM_MAX_MINUTES = 120;
/** Longest `summary` and `detail` kept; longer text is cut. */
export const ACTIVITY_SUMMARY_MAX = 200;
/** Longest `label` and `tool` kept. */
export const ACTIVITY_LABEL_MAX = 80;

// ── Presence ─────────────────────────────────────────────────────────────────

export const AgentStatusSchema = z.enum(['idle', 'reading', 'writing', 'working', 'waiting']);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

/**
 * What an agent is doing on a board, as published by the server in the
 * board's awareness (`Presence.agent`). One awareness entry per agent and
 * session.
 *
 * `reading`  its last call read the board; `focus` holds the nodes it read.
 * `writing`  its last call changed the board; `focus` holds what it touched.
 * `working`  its session reports tool use (`detail` says what).
 * `waiting`  it waits for a person: a question it long-polls, or (after
 *            `AGENT_IDLE_MS` without activity) a pending proposal or open
 *            question of its own on this board.
 * `idle`     nothing for `AGENT_IDLE_MS`; removed after `AGENT_PRESENCE_TTL_MS`.
 */
export const AgentPresenceSchema = z.object({
  status: AgentStatusSchema,
  /** One line, untrusted (may name files or commands), at most `ACTIVITY_SUMMARY_MAX` characters. */
  detail: z.string().max(ACTIVITY_SUMMARY_MAX).optional(),
  focus: z.array(IdSchema).max(PRESENCE_FOCUS_MAX).optional(),
  session: z.string().optional(),
  /** The parent session, for a subagent. */
  parent: z.string().optional(),
  /** When the status last changed or the agent was last active. */
  at: z.iso.datetime(),
});
export type AgentPresence = z.infer<typeof AgentPresenceSchema>;

// ── Activity sessions ────────────────────────────────────────────────────────

export const ActivityKindSchema = z.enum([
  'session_start',
  'session_end',
  'prompt',
  'tool_start',
  'tool_end',
  'subagent_start',
  'subagent_end',
  'note',
]);
export type ActivityKind = z.infer<typeof ActivityKindSchema>;

/**
 * One thing an agent's tooling reports (for example from editor or CLI
 * hooks), whether or not it touches a board. Text fields are untrusted and may
 * be sensitive: the server strips control characters, cuts `summary` to
 * `ACTIVITY_SUMMARY_MAX` and `label`/`tool` to `ACTIVITY_LABEL_MAX`, and keeps
 * them in memory only.
 *
 * For `subagent_start` and `subagent_end`, `session` is the subagent's session
 * and `parent` the session that started it.
 */
export const ActivityEventSchema = z.object({
  session: IdSchema,
  parent: IdSchema.optional(),
  kind: ActivityKindSchema,
  tool: z.string().max(1000).optional(),
  summary: z.string().max(10_000).optional(),
  ok: z.boolean().optional(),
  label: z.string().max(1000).optional(),
  at: z.iso.datetime().optional(),
});
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;

export interface SessionStep {
  at: string;
  /** The tool, or `prompt`, `note`, `subagent`. */
  tool: string;
  summary: string;
  ok?: boolean;
}

/** One agent session as the server knows it. */
export interface Session {
  id: string;
  parent?: string;
  /** Actor id of whoever reports it. */
  actor: string;
  label?: string;
  /** `active` while it reported something in the last `AGENT_IDLE_MS` or runs a tool. */
  status: 'active' | 'idle' | 'ended';
  startedAt: string;
  lastAt: string;
  endedAt?: string;
  /** The tool running now, if any. */
  current?: { tool: string; summary: string; since: string };
  /** The last `SESSION_RECENT` finished steps, oldest first. */
  recent: SessionStep[];
  counts: { tools: number; errors: number };
  /** Subagent session ids, in start order. */
  children: string[];
}

export const SessionsOptionsSchema = z.object({
  includeEnded: z.boolean().optional(),
  maxTokens: z.number().int().min(100).max(50_000).optional(),
});
export type SessionsOptions = z.infer<typeof SessionsOptionsSchema>;

export interface SessionsResult {
  /** Most recently active first. */
  sessions: Session[];
  text: string;
  tokens: number;
  truncated: boolean;
}

/**
 * The live session list as the server publishes it in each open board's
 * awareness (`Presence.live`, under the `SYSTEM_ACTOR`): sessions that have
 * not ended, most recently active first, at most `LIVE_SESSIONS_MAX`, each
 * with at most `LIVE_RECENT_MAX` recent steps. `GET /api/sessions` has the rest.
 */
export interface LiveSessions {
  sessions: Session[];
  at: string;
}
export const LIVE_SESSIONS_MAX = 50;
export const LIVE_RECENT_MAX = 5;

// ── Claims ───────────────────────────────────────────────────────────────────

/** "This agent is working on this node." Stored in the document map `claims` by node id. */
export const ClaimSchema = z.object({
  nodeId: IdSchema,
  /** The agent holding it. */
  by: IdSchema,
  session: z.string().max(64).optional(),
  note: z.string().max(200).optional(),
  /** Length of the claim, used when a later call by the holder renews it. */
  minutes: z.number().int().min(1).max(CLAIM_MAX_MINUTES),
  at: z.iso.datetime(),
  /** It counts until then; an expired claim is ignored and swept away. */
  until: z.iso.datetime(),
});
export type Claim = z.infer<typeof ClaimSchema>;

export const ClaimRequestSchema = z.object({
  nodeIds: z.array(IdSchema).min(1).max(100),
  note: z.string().max(200).optional(),
  /** Default `CLAIM_DEFAULT_MINUTES`, at most `CLAIM_MAX_MINUTES`. */
  minutes: z.number().int().min(1).max(CLAIM_MAX_MINUTES).optional(),
  /** Release these claims instead of taking them. */
  release: z.boolean().optional(),
  /** Claim what is free even if some nodes are claimed by others. Otherwise all or nothing. */
  partial: z.boolean().optional(),
});
export type ClaimRequest = z.infer<typeof ClaimRequestSchema>;

export interface ClaimResult {
  boardId: string;
  /** Every claim the caller holds on this board after the call. */
  claims: Claim[];
  /** Requested nodes held by someone else (nothing was claimed when there are any, unless `partial`). */
  conflicts: Array<{ nodeId: string; by: string; until: string }>;
  /** Nodes whose claim this call released. */
  released: string[];
  text: string;
}
