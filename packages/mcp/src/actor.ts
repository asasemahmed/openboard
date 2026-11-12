/**
 * Who an MCP session is. Everything a session does on a board is attributed
 * to this actor, so it is derived from what the client says about itself
 * (`clientInfo` at initialize), unless the environment names it explicitly.
 */
import { type Actor, IdSchema, slugify } from '@openboard/core';

/** What an MCP client reports about itself in `initialize`. */
export interface ClientInfo {
  name: string;
  version?: string;
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
