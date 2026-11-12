/**
 * Access grants, browser sessions and sync tickets for shared mode (see
 * "Shared mode" in docs/ARCHITECTURE.md).
 *
 * - Grants live in `.openboard/.local/access.json` (mode 0600, written
 *   atomically). A token is `ob_<grant id>_<secret>`; only the SHA-256 of the
 *   secret is stored, and the token is returned once, when the grant is made.
 * - Sessions are what a browser holds after trading an invite token for a
 *   cookie. The cookie carries a random session id; `sessions.json` (0600)
 *   keeps only its hash, so a restart does not log everyone out and a copy of
 *   the file does not log anyone in.
 * - Tickets are short-lived, single-use stand-ins for a token on a WebSocket
 *   URL, for clients that cannot set headers on the upgrade. Memory only.
 *
 * Every check compares hashes in constant time, and a wrong grant id costs the
 * same as a wrong secret.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  type AccessGrant,
  type Actor,
  type GrantAccessInput,
  GrantAccessInputSchema,
  OpenBoardError,
  type StoredGrant,
  StoredGrantSchema,
  slugify,
  TOKEN_PATTERN,
} from '@openboard/core';
import { z } from 'zod';
import { errorMessage, readIfExists, writeFileAtomic } from './fsutil.js';
import { Mutex } from './mutex.js';

export const ACCESS_FILE = 'access.json';
export const SESSIONS_FILE = 'sessions.json';

/** A session not used for this long ends. */
export const SESSION_IDLE_MS = 30 * 24 * 60 * 60_000;
/** A ticket must be used within this time, once. */
export const TICKET_TTL_MS = 60_000;
/** Sessions per grant; making one more ends the least recently used. */
export const SESSIONS_PER_GRANT = 50;
/** Outstanding tickets per grant, and in all. */
export const TICKETS_PER_GRANT = 20;
const TICKETS_MAX = 10_000;
/** Grants a project may hold, revoked ones included. */
export const GRANTS_MAX = 1000;
/** `lastUsedAt` is written to disk at most this often per grant or session. */
const TOUCH_PERSIST_MS = 10 * 60_000;
const SAVE_DELAY_MS = 1000;

const SECRET_BYTES = 32;
const FILE_MODE = 0o600;
/** Compared against when a token names no grant, so a wrong id costs the same as a wrong secret. */
const DUMMY_HASH = Buffer.alloc(32);

const AccessFileSchema = z.object({
  version: z.literal(1),
  grants: z.array(StoredGrantSchema),
});

const SessionRecordSchema = z.object({
  /** Hex SHA-256 of the session id in the cookie. */
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  grantId: z.string(),
  name: z.string().min(1).max(80).optional(),
  createdAt: z.string(),
  lastUsedAt: z.string(),
});
type SessionRecord = z.infer<typeof SessionRecordSchema>;

const SessionsFileSchema = z.object({
  version: z.literal(1),
  sessions: z.array(SessionRecordSchema),
});

interface Ticket {
  grantId: string;
  name?: string;
  /** The session it was issued to, so ending the session ends its sockets too. */
  sessionHash?: string;
  via: 'token' | 'session';
  expiresAt: number;
}

/** What ended: a whole grant (revoked) or one browser session (logout). */
export type AccessEnd =
  | { grantId: string; sessionHash?: undefined }
  | { grantId: string; sessionHash: string };

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function grantId(): string {
  let out = '';
  while (out.length < 16) {
    for (const byte of randomBytes(32)) {
      // 252 is the largest multiple of 36 below 256; higher bytes would bias the id.
      if (byte >= 252) continue;
      out += ID_ALPHABET[byte % 36];
      if (out.length === 16) break;
    }
  }
  return out;
}

export function secret(): string {
  return randomBytes(SECRET_BYTES).toString('base64url');
}

export function hashSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Constant-time comparison of two hex SHA-256 digests (or a digest and the dummy). */
function sameHash(expected: Buffer, actual: Buffer): boolean {
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** The grant without its secret hash, as listed to owners. */
export function publicGrant(grant: StoredGrant): AccessGrant {
  const { secretHash: _secret, ...rest } = grant;
  return rest;
}

/** A display name from a client: control characters out, at most 80 characters, or undefined. */
export function cleanName(name: string | undefined | null): string | undefined {
  if (typeof name !== 'string') return undefined;
  const flat = name.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
  if (flat === '') return undefined;
  return flat.slice(0, 80);
}

export interface AccessStoreOptions {
  clock?: () => number;
  log?: (line: string) => void;
  /** A file that does not parse stops the server instead of being treated as empty. */
  strict?: boolean;
}

export class AccessStore {
  private readonly grants = new Map<string, StoredGrant>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly tickets = new Map<string, Ticket>();
  /** When each grant's and session's `lastUsedAt` was last written. */
  private readonly persistedUse = new Map<string, number>();
  private readonly listeners = new Set<(end: AccessEnd) => void>();
  private readonly lock = new Mutex();
  private saveTimer: NodeJS.Timeout | null = null;
  private dirtyGrants = false;
  private dirtySessions = false;
  private readonly clock: () => number;
  private readonly log: (line: string) => void;
  readonly accessFile: string;
  readonly sessionsFile: string;

  constructor(
    localDir: string,
    private readonly opts: AccessStoreOptions = {},
  ) {
    this.clock = opts.clock ?? (() => Date.now());
    this.log = opts.log ?? (() => {});
    this.accessFile = path.join(localDir, ACCESS_FILE);
    this.sessionsFile = path.join(localDir, SESSIONS_FILE);
  }

  private now(): number {
    return this.clock();
  }

  private iso(ms = this.now()): string {
    return new Date(ms).toISOString();
  }

  // ── Loading and saving ─────────────────────────────────────────────────────

  async load(): Promise<void> {
    const grants = await this.readFile(this.accessFile, AccessFileSchema);
    for (const grant of grants?.grants ?? []) this.grants.set(grant.id, grant);
    const sessions = await this.readFile(this.sessionsFile, SessionsFileSchema);
    for (const session of sessions?.sessions ?? []) {
      if (this.sessionAlive(session)) this.sessions.set(session.hash, session);
    }
    if (sessions && this.sessions.size !== sessions.sessions.length) this.markDirty('sessions');
  }

  private async readFile<T>(file: string, schema: z.ZodType<T>): Promise<T | null> {
    const raw = await readIfExists(file);
    if (!raw) return null;
    try {
      const mode = (await stat(file)).mode & 0o777;
      if (mode & 0o077) {
        await chmod(file, FILE_MODE);
        this.log(`${path.basename(file)} was readable by others; its mode is now 0600`);
      }
    } catch {
      // A file that vanished between read and stat is read again next time.
    }
    let parsed: z.ZodSafeParseResult<T>;
    try {
      parsed = schema.safeParse(JSON.parse(raw.toString('utf8')));
    } catch (error) {
      return this.unreadable(file, errorMessage(error));
    }
    if (!parsed.success) return this.unreadable(file, parsed.error.issues[0]?.message ?? 'invalid');
    return parsed.data;
  }

  private unreadable(file: string, why: string): null {
    const message = `${path.basename(file)} does not parse (${why}); fix or delete ${file}`;
    if (this.opts.strict) throw new OpenBoardError('invalid_request', message);
    this.log(`${message}; ignoring it`);
    return null;
  }

  private markDirty(which: 'grants' | 'sessions'): void {
    if (which === 'grants') this.dirtyGrants = true;
    else this.dirtySessions = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush().catch((error: unknown) => this.log(`access: ${errorMessage(error)}`));
    }, SAVE_DELAY_MS);
    this.saveTimer.unref();
  }

  /** Write whatever changed. */
  flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    return this.lock.run(async () => {
      if (this.dirtyGrants) {
        this.dirtyGrants = false;
        const data = { version: 1, grants: [...this.grants.values()] };
        await writeFileAtomic(this.accessFile, `${JSON.stringify(data, null, 2)}\n`, {
          mode: FILE_MODE,
        });
      }
      if (this.dirtySessions) {
        this.dirtySessions = false;
        const data = { version: 1, sessions: [...this.sessions.values()] };
        await writeFileAtomic(this.sessionsFile, `${JSON.stringify(data, null, 2)}\n`, {
          mode: FILE_MODE,
        });
      }
    });
  }

  async close(): Promise<void> {
    await this.flush();
    this.listeners.clear();
  }

  /** Called when a grant is revoked or a session ends, so open sockets can be closed. */
  onEnd(listener: (end: AccessEnd) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(end: AccessEnd): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(end);
      } catch (error) {
        this.log(`access: ${errorMessage(error)}`);
      }
    }
  }

  // ── Grants ─────────────────────────────────────────────────────────────────

  list(): AccessGrant[] {
    return [...this.grants.values()]
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
      .map(publicGrant);
  }

  get(id: string): StoredGrant | undefined {
    return this.grants.get(id);
  }

  /** Not revoked and not expired. */
  isActive(grant: StoredGrant | undefined): grant is StoredGrant {
    if (!grant || grant.revokedAt !== undefined) return false;
    return grant.expiresAt === undefined || Date.parse(grant.expiresAt) > this.now();
  }

  /** Make a grant. Throws `invalid_request` (bad input, too many grants). */
  async grant(input: GrantAccessInput, by: Actor): Promise<{ grant: AccessGrant; token: string }> {
    const parsed = GrantAccessInputSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new OpenBoardError(
        'invalid_request',
        `invalid grant: ${issue ? `${issue.path.join('.') || 'input'}: ${issue.message}` : 'invalid'}`,
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    if (this.grants.size >= GRANTS_MAX) {
      throw new OpenBoardError(
        'invalid_request',
        `this project already has ${GRANTS_MAX} access grants; delete old ones from ${this.accessFile}`,
      );
    }
    const { label, role, kind, expiresInHours } = parsed.data;
    let id = grantId();
    while (this.grants.has(id)) id = grantId();
    const slug = slugify(label);
    const base = slug === 'board' && !label.toLowerCase().includes('board') ? kind : slug;
    const value = secret();
    const now = this.now();
    const grant: StoredGrant = {
      id,
      label,
      role,
      kind,
      actorId: `${base.slice(0, 40)}-${id.slice(0, 6)}`,
      secretHash: hashSecret(value),
      createdAt: this.iso(now),
      createdBy: by.id,
    };
    if (expiresInHours !== undefined) {
      grant.expiresAt = this.iso(now + Math.round(expiresInHours * 3_600_000));
    }
    this.grants.set(id, grant);
    this.dirtyGrants = true;
    await this.flush();
    return { grant: publicGrant(grant), token: `ob_${id}_${value}` };
  }

  /** Revoke a grant. Its sessions and tickets end at once. Throws `not_found`. */
  async revoke(id: string): Promise<AccessGrant> {
    const grant = this.grants.get(id);
    if (!grant) throw new OpenBoardError('not_found', `no access grant "${id}"`);
    if (grant.revokedAt === undefined) {
      grant.revokedAt = this.iso();
      for (const [hash, session] of this.sessions) {
        if (session.grantId === id) this.sessions.delete(hash);
      }
      for (const [hash, ticket] of this.tickets)
        if (ticket.grantId === id) this.tickets.delete(hash);
      this.dirtyGrants = true;
      this.dirtySessions = true;
      await this.flush();
      this.emit({ grantId: id });
    }
    return publicGrant(grant);
  }

  /**
   * The active grant a token names, or null. One constant-time comparison
   * either way, and the same null whether the id, the secret, or the grant's
   * state was wrong.
   */
  verifyToken(token: string): StoredGrant | null {
    const match = TOKEN_PATTERN.exec(token);
    const grant = match ? this.grants.get(match[1] as string) : undefined;
    const expected = grant ? Buffer.from(grant.secretHash, 'hex') : DUMMY_HASH;
    const actual = Buffer.from(hashSecret(match?.[2] ?? token), 'hex');
    const equal = sameHash(expected, actual);
    if (!match || !grant || !equal || !this.isActive(grant)) return null;
    this.touchGrant(grant);
    return grant;
  }

  private touchGrant(grant: StoredGrant): void {
    const now = this.now();
    grant.lastUsedAt = this.iso(now);
    const key = `g:${grant.id}`;
    if (now - (this.persistedUse.get(key) ?? 0) >= TOUCH_PERSIST_MS) {
      this.persistedUse.set(key, now);
      this.markDirty('grants');
    }
  }

  // ── Sessions ───────────────────────────────────────────────────────────────

  private sessionAlive(session: SessionRecord): boolean {
    if (!this.isActive(this.grants.get(session.grantId))) return false;
    return this.now() - Date.parse(session.lastUsedAt) < SESSION_IDLE_MS;
  }

  /** Start a browser session for an active grant. Returns the session id for the cookie, shown once. */
  async createSession(
    grant: StoredGrant,
    name: string | undefined,
  ): Promise<{ sessionId: string; hash: string }> {
    const sessionId = secret();
    const hash = hashSecret(sessionId);
    const at = this.iso();
    const record: SessionRecord = { hash, grantId: grant.id, createdAt: at, lastUsedAt: at };
    if (name !== undefined) record.name = name;
    this.sessions.set(hash, record);
    // Keep a grant's sessions bounded: the least recently used one goes first.
    const own = [...this.sessions.values()]
      .filter((s) => s.grantId === grant.id)
      .sort((a, b) => (a.lastUsedAt < b.lastUsedAt ? -1 : 1));
    for (const old of own.slice(0, Math.max(0, own.length - SESSIONS_PER_GRANT))) {
      this.sessions.delete(old.hash);
      this.emit({ grantId: grant.id, sessionHash: old.hash });
    }
    this.dirtySessions = true;
    await this.flush();
    return { sessionId, hash };
  }

  /** The live session and its grant for a cookie value, or null. Renews the idle timer. */
  session(sessionId: string): { hash: string; record: SessionRecord; grant: StoredGrant } | null {
    if (sessionId.length < 43 || sessionId.length > 128) return null;
    const hash = hashSecret(sessionId);
    const record = this.sessions.get(hash);
    if (!record) return null;
    const grant = this.grants.get(record.grantId);
    if (!this.sessionAlive(record) || !grant) {
      this.sessions.delete(hash);
      this.markDirty('sessions');
      return null;
    }
    const now = this.now();
    record.lastUsedAt = this.iso(now);
    const key = `s:${hash}`;
    if (now - (this.persistedUse.get(key) ?? 0) >= TOUCH_PERSIST_MS) {
      this.persistedUse.set(key, now);
      this.markDirty('sessions');
    }
    this.touchGrant(grant);
    return { hash, record, grant };
  }

  /** Whether the session with this hash is still alive (no renewal). */
  sessionActive(hash: string): boolean {
    const record = this.sessions.get(hash);
    return record !== undefined && this.sessionAlive(record);
  }

  /** End one session (logout). Its sockets close. */
  async endSession(hash: string): Promise<void> {
    const record = this.sessions.get(hash);
    if (!record) return;
    this.sessions.delete(hash);
    for (const [key, ticket] of this.tickets)
      if (ticket.sessionHash === hash) this.tickets.delete(key);
    this.dirtySessions = true;
    await this.flush();
    this.emit({ grantId: record.grantId, sessionHash: hash });
  }

  // ── Tickets ────────────────────────────────────────────────────────────────

  private sweepTickets(): void {
    const now = this.now();
    for (const [hash, ticket] of this.tickets)
      if (ticket.expiresAt <= now) this.tickets.delete(hash);
  }

  /** A single-use ticket for one WebSocket upgrade. Throws `rate_limited` when too many are outstanding. */
  issueTicket(owner: Omit<Ticket, 'expiresAt'>): { ticket: string; expiresAt: string } {
    this.sweepTickets();
    const outstanding = [...this.tickets.values()].filter((t) => t.grantId === owner.grantId);
    if (outstanding.length >= TICKETS_PER_GRANT || this.tickets.size >= TICKETS_MAX) {
      throw new OpenBoardError(
        'rate_limited',
        'too many unused sync tickets; use or let them expire first',
        { retryAfterSeconds: Math.ceil(TICKET_TTL_MS / 1000) },
      );
    }
    const ticket = secret();
    const expiresAt = this.now() + TICKET_TTL_MS;
    this.tickets.set(hashSecret(ticket), { ...owner, expiresAt });
    return { ticket, expiresAt: this.iso(expiresAt) };
  }

  /** Use a ticket up. Null when it is unknown, used, expired, or its grant or session ended. */
  consumeTicket(ticket: string): { ticket: Ticket; grant: StoredGrant } | null {
    if (ticket.length < 43 || ticket.length > 128) return null;
    const hash = hashSecret(ticket);
    const found = this.tickets.get(hash);
    if (!found) return null;
    this.tickets.delete(hash);
    const grant = this.grants.get(found.grantId);
    if (found.expiresAt <= this.now() || !this.isActive(grant)) return null;
    if (found.sessionHash !== undefined && !this.sessionActive(found.sessionHash)) return null;
    return { ticket: found, grant };
  }
}
