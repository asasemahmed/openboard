/**
 * Who an MCP session is. Everything a session does on a board is attributed
 * to this actor, so it is derived from what the client says about itself
 * (`clientInfo` at initialize), unless the environment names it explicitly.
 */
import { type AccessVia, type Actor, IdSchema, type Role, slugify } from '@openboard/core';

/** What an MCP client reports about itself in `initialize`. */
export interface ClientInfo {
  name: string;
  version?: string;
}

/**
 * Who opened an MCP session over HTTP, as the board server established it
 * (the `caller` a mounted handler receives). For a `token` or `session` caller
 * the identity comes from its access grant; a `local` caller is the owner at
 * the server's machine.
 */
export interface McpCaller {
  actor: Actor;
  role: Role;
  via: AccessVia;
  grantId?: string;
}

/** What `resolveApi` gets: the client, and the agent session this MCP session is. */
export interface SessionInfo extends ClientInfo {
  /** Over HTTP behind a board server: who opened the session. */
  caller?: McpCaller;
  /**
   * Stable for the life of the MCP session (one per stdio process, the MCP
   * session id over HTTP). Pass it to the `BoardApi` (`connect({ session })`,
   * `server.api(actor, { session })`) so the board shows one presence entry
   * per agent session, merged with what that session's hooks report.
   */
  session: string;
}

const SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

/** `OPENBOARD_SESSION` when it is a valid session id, else undefined. */
export function sessionFromEnv(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const value = env.OPENBOARD_SESSION?.trim();
  return value && SESSION_PATTERN.test(value) ? value : undefined;
}

const FALLBACK_ID = 'agent';
const FALLBACK_NAME = 'Agent';

/** `claude-code` -> `Claude Code`; a name that already reads well is kept. */
function readableName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') return FALLBACK_NAME;
  if (/\s/.test(trimmed) || /[A-Z]/.test(trimmed)) return trimmed;
  const words = trimmed.split(/[-_.]+/).filter(Boolean);
  if (words.length === 0) return trimmed;
  return words.map((word) => word[0]?.toUpperCase() + word.slice(1)).join(' ');
}

/** A slug for an id, or null when the name has nothing to slug. */
function slugOf(name: string): string | null {
  const plain = name.normalize('NFKD').replace(/\p{M}+/gu, '');
  if (!/[a-z0-9]/i.test(plain)) return null;
  return slugify(name);
}

/**
 * The actor for an MCP client. `OPENBOARD_AGENT_ID` and `OPENBOARD_AGENT_NAME`
 * override what is derived from `clientInfo.name`.
 */
export function actorForClient(
  clientInfo: ClientInfo | undefined,
  env: Record<string, string | undefined> = process.env,
): Actor {
  const clientName = clientInfo?.name ?? '';
  const envId = env.OPENBOARD_AGENT_ID?.trim();
  const id =
    envId && IdSchema.safeParse(envId).success ? envId : (slugOf(clientName) ?? FALLBACK_ID);
  const envName = env.OPENBOARD_AGENT_NAME?.trim();
  const name = (envName || readableName(clientName)).slice(0, 80);
  return { id, kind: 'agent', name };
}

/**
 * The actor an MCP session acts as. A caller with credentials is who its grant
 * says, whatever the client calls itself; otherwise the actor is derived from
 * the client, as for a local session.
 */
export function actorForSession(
  client: SessionInfo,
  env: Record<string, string | undefined> = process.env,
): Actor {
  if (client.caller && client.caller.via !== 'local') return client.caller.actor;
  return actorForClient(client, env);
}
