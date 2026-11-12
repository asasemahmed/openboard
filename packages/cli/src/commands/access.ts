/**
 * Shared mode from the terminal: who you are to a server, and the access
 * grants of the project's server (people's invite links, agents' tokens).
 * Managing access runs against the local server as the owner at this machine,
 * or against `--url` with an owner's token.
 */
import {
  type AccessGrant,
  AGENT_ROLES,
  type GrantAccessInput,
  MAX_GRANT_HOURS,
  type Role,
  RoleSchema,
} from '@openboard/core';
import type { OpenBoardClient } from '@openboard/sdk';
import { CliError } from '../lib/errors.js';
import { type CliIo, println } from '../lib/io.js';
import { resolveRoot } from '../lib/project.js';
import { openSession, type Session } from '../lib/store.js';
import { printTable } from '../lib/table.js';

export interface AccessOptions {
  root?: string;
  json?: boolean;
}

async function server(
  io: CliIo,
  root: string | undefined,
  what: string,
): Promise<{ session: Session; client: OpenBoardClient }> {
  const dir = resolveRoot(io, root);
  const session = await openSession(io, dir);
  if (!session.client) {
    throw new CliError(
      `${what} needs the running server, and none is running for ${dir}; start it with \`openboard start --share\``,
    );
  }
  return { session, client: session.client };
}

// ── whoami ───────────────────────────────────────────────────────────────────

export async function whoamiCommand(io: CliIo, options: AccessOptions = {}): Promise<number> {
  const { client } = await server(io, options.root, 'whoami');
  const who = await client.whoami();
  if (options.json) {
    println(io.stdout, JSON.stringify(who, null, 2));
    return 0;
  }
  const via = {
    local: "trusted as the owner at the server's machine",
    token: 'with an access token',
    session: 'with a browser session',
  }[who.via];
  println(io.stdout, `${who.actor.name} (${who.actor.kind}, id ${who.actor.id})`);
  println(io.stdout, `Role: ${who.role}, ${via}`);
  println(
    io.stdout,
    `Server: ${who.shared ? 'shared mode' : 'local mode (only this machine can reach it)'}`,
  );
  if (who.grantId) {
    println(
      io.stdout,
      `Grant: ${who.grantId}${who.expiresAt ? `, expires ${who.expiresAt}` : ', does not expire'}`,
    );
  }
  return 0;
}

// ── access list ──────────────────────────────────────────────────────────────

function state(grant: AccessGrant, now = Date.now()): string {
  if (grant.revokedAt) return 'revoked';
  if (grant.expiresAt && Date.parse(grant.expiresAt) <= now) return 'expired';
  return 'active';
}

export async function accessListCommand(io: CliIo, options: AccessOptions = {}): Promise<number> {
  const { client } = await server(io, options.root, 'Listing access');
  const { grants } = await client.listAccess();
  if (options.json) {
    println(io.stdout, JSON.stringify(grants, null, 2));
    return 0;
  }
  if (grants.length === 0) {
    println(
      io.stdout,
      'No access grants yet. Invite someone with: openboard access invite [--agent]',
    );
    return 0;
  }
  printTable(io.stdout, grants, [
    { header: 'ID', value: (g) => g.id },
    { header: 'LABEL', value: (g) => g.label },
    { header: 'KIND', value: (g) => g.kind },
    { header: 'ROLE', value: (g) => g.role },
    { header: 'ACTOR', value: (g) => g.actorId },
    { header: 'STATE', value: (g) => state(g) },
    { header: 'EXPIRES', value: (g) => g.expiresAt ?? 'never' },
    { header: 'LAST USED', value: (g) => g.lastUsedAt ?? '-' },
  ]);
  return 0;
}

// ── access invite ────────────────────────────────────────────────────────────

export interface InviteOptions extends AccessOptions {
  role?: string;
  /** Invite an agent: a token for an MCP client instead of a link for a person. */
  agent?: boolean;
  label?: string;
  /** Hours until the grant expires; it never expires when omitted. */
  expires?: string;
}

function parseRole(value: string | undefined, agent: boolean): Role {
  const parsed = RoleSchema.safeParse(value ?? 'editor');
  if (!parsed.success) {
    throw new CliError(`unknown role "${value}" (choose one of: ${RoleSchema.options.join(', ')})`);
  }
  if (agent && !AGENT_ROLES.includes(parsed.data)) {
    throw new CliError(`an agent can be ${AGENT_ROLES.join(', ')}; owner is for people only`);
  }
  return parsed.data;
}

function parseHours(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_GRANT_HOURS) {
    throw new CliError(
      `--expires ${value}: give a number of hours, more than 0 and at most ${MAX_GRANT_HOURS}`,
    );
  }
  return hours;
}

/** The setup an agent's MCP client needs, with the token as an environment variable reference. */
export function remoteAgentSetup(publicUrl: string): string[] {
  const mcp = `${publicUrl.replace(/\/$/, '')}/mcp`;
  return [
    `MCP over HTTP: ${mcp}, with the header "Authorization: Bearer <token>".`,
    '  Claude Code:',
    `    claude mcp add --transport http openboard ${mcp} --header "Authorization: Bearer \${OPENBOARD_TOKEN}"`,
    '    (your shell fills in OPENBOARD_TOKEN; Claude Code keeps the header in its configuration)',
    '',
    "MCP over stdio, for clients that only start local commands (needs this CLI on the agent's machine):",
    `    OPENBOARD_TOKEN=<token> openboard mcp --url ${publicUrl.replace(/\/$/, '')}`,
    '',
    '`openboard connect --remote` prints the setup for each client.',
  ];
}

export async function accessInviteCommand(io: CliIo, options: InviteOptions = {}): Promise<number> {
  const agent = options.agent === true;
  const input: GrantAccessInput = {
    label: options.label ?? (agent ? 'Remote agent' : 'Guest'),
    role: parseRole(options.role, agent),
    kind: agent ? 'agent' : 'human',
  };
  const hours = parseHours(options.expires);
  if (hours !== undefined) input.expiresInHours = hours;

  const { session, client } = await server(io, options.root, 'Inviting');
  const who = await client.whoami();
  if (!who.shared) {
    throw new CliError(
      'the server is not in shared mode, so nobody else can sign in; restart it with `openboard start --share`',
    );
  }
  const result = await client.grantAccess(input);
  if (options.json) {
    println(io.stdout, JSON.stringify(result, null, 2));
    return 0;
  }
  const { grant } = result;
  const expiry = grant.expiresAt ? `until ${grant.expiresAt}` : 'until revoked';
  if (!agent) {
    println(io.stdout, `Invite link for "${grant.label}" (${grant.role}), valid ${expiry}:`);
    println(io.stdout);
    println(io.stdout, `  ${result.inviteUrl ?? `(no public URL; the token is ${result.token})`}`);
    println(io.stdout);
    println(io.stdout, 'Anyone with this link can sign in with this access, so send it privately.');
    println(io.stdout, `It is shown only now. Revoke it with: openboard access revoke ${grant.id}`);
    return 0;
  }
  const publicUrl =
    io.remoteUrl ?? session.server?.publicUrl ?? session.server?.url ?? result.inviteUrl ?? '';
  println(
    io.stdout,
    `Token for the agent "${grant.label}" (${grant.role}, actor ${grant.actorId}), valid ${expiry}:`,
  );
  println(io.stdout);
  println(io.stdout, `  ${result.token}`);
  println(io.stdout);
  println(
    io.stdout,
    'It is shown only now and cannot be recovered: store it where the agent runs (for example',
  );
  println(
    io.stdout,
    'in OPENBOARD_TOKEN, or a secret store). Anyone with it has this access until you revoke it:',
  );
  println(io.stdout, `  openboard access revoke ${grant.id}`);
  println(io.stdout);
  for (const line of remoteAgentSetup(publicUrl)) println(io.stdout, line);
  println(io.stdout);
  println(
    io.stdout,
    `The agent stays under the review policy; set its mode with: openboard policy set <mode> --agent ${grant.actorId}`,
  );
  return 0;
}

// ── access revoke ────────────────────────────────────────────────────────────

export async function accessRevokeCommand(
  io: CliIo,
  id: string,
  options: AccessOptions = {},
): Promise<number> {
  const { client } = await server(io, options.root, 'Revoking access');
  const grant = await client.revokeAccess(id);
  if (options.json) println(io.stdout, JSON.stringify(grant, null, 2));
  else {
    println(
      io.stdout,
      `Revoked "${grant.label}" (${grant.kind}, ${grant.role}). Its requests, sessions and open connections end now.`,
    );
  }
  return 0;
}
