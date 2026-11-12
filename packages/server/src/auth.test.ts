import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { Actor } from '@openboard/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccessStore, hashSecret, SESSION_IDLE_MS, TICKET_TTL_MS } from './access.js';
import {
  AuthThrottle,
  clientKey,
  isLocalOwnerRequest,
  readCookie,
  scrubSecrets,
  sessionCookie,
} from './auth.js';
import { readIfExists } from './fsutil.js';
import { removeRoot, tempRoot } from './testing.js';

const PORT = 4747;
const none = () => undefined;

describe('isLocalOwnerRequest', () => {
  const local = (over: Partial<Parameters<typeof isLocalOwnerRequest>[0]> = {}) =>
    isLocalOwnerRequest({
      remoteAddress: '127.0.0.1',
      host: `127.0.0.1:${PORT}`,
      port: PORT,
      header: none,
      ...over,
    });

  it('trusts a loopback peer that names a loopback host on our port', () => {
    expect(local()).toBe(true);
    expect(local({ host: `localhost:${PORT}` })).toBe(true);
    expect(local({ host: `LOCALHOST:${PORT}` })).toBe(true);
    expect(local({ host: `[::1]:${PORT}`, remoteAddress: '::1' })).toBe(true);
    expect(local({ remoteAddress: '::ffff:127.0.0.1' })).toBe(true);
    expect(local({ remoteAddress: '127.8.9.10' })).toBe(true);
  });

  it('refuses a peer that is not loopback, whatever the headers say', () => {
    for (const remoteAddress of [
      '10.0.0.5',
      '192.168.1.20',
      '::ffff:10.0.0.5',
      '2001:db8::1',
      '',
      undefined,
    ]) {
      expect(local({ remoteAddress })).toBe(false);
    }
    expect(local({ remoteAddress: '127.0.0.1.evil' })).toBe(false);
  });

  it('refuses a public or wrong Host even from loopback: a tunnel keeps the public Host', () => {
    expect(local({ host: 'board.example.com' })).toBe(false);
    expect(local({ host: `board.example.com:${PORT}` })).toBe(false);
    expect(local({ host: '127.0.0.1' })).toBe(false);
    expect(local({ host: '127.0.0.1:5173' })).toBe(false);
    expect(local({ host: `127.0.0.2:${PORT}` })).toBe(false);
    expect(local({ host: undefined })).toBe(false);
  });

  it('refuses any request a proxy or tunnel relayed', () => {
    for (const name of [
      'forwarded',
      'x-forwarded-for',
      'x-forwarded-host',
      'x-forwarded-proto',
      'x-real-ip',
      'cf-connecting-ip',
      'via',
    ]) {
      expect(local({ header: (h) => (h === name ? '203.0.113.7' : undefined) })).toBe(false);
    }
    // Even an empty value counts: the header is there.
    expect(local({ header: (h) => (h === 'x-forwarded-for' ? '' : undefined) })).toBe(false);
  });
});

describe('clientKey', () => {
  it('uses the peer, or behind a local relay the address it appended last', () => {
    expect(clientKey('10.0.0.5', () => '1.1.1.1')).toBe('10.0.0.5');
    expect(clientKey('127.0.0.1', none)).toBe('127.0.0.1');
    expect(clientKey('127.0.0.1', () => 'spoofed, 203.0.113.9')).toBe('127.0.0.1>203.0.113.9');
  });
});

describe('AuthThrottle', () => {
  it('blocks a key after the limit within the window, and lets it go after', () => {
    let now = 0;
    const throttle = new AuthThrottle(() => now, 3, 60_000);
    for (let i = 0; i < 3; i++) {
      expect(throttle.retryAfter('a')).toBe(0);
      throttle.fail('a');
      now += 1000;
    }
    expect(throttle.retryAfter('a')).toBe(57);
    expect(throttle.retryAfter('b')).toBe(0);
    now = 60_001;
    expect(throttle.retryAfter('a')).toBe(0);
  });
});

describe('cookies and secrets', () => {
  it('formats the session cookie with every attribute', () => {
    expect(sessionCookie('n', 'v', { secure: true, maxAgeSeconds: 10.7 })).toBe(
      'n=v; Path=/; HttpOnly; SameSite=Strict; Max-Age=10; Secure',
    );
    expect(sessionCookie('n', '', { secure: false, maxAgeSeconds: 0 })).toBe(
      'n=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0',
    );
    expect(readCookie('a=1; openboard_session=xyz; b=2', 'openboard_session')).toBe('xyz');
    expect(readCookie('xopenboard_session=1', 'openboard_session')).toBeUndefined();
  });

  it('scrubs tokens, tickets, cookies and bearer values from text', () => {
    const token = `ob_abcdefghij012345_${'x'.repeat(43)}`;
    const text = scrubSecrets(
      `bad ${token} at /sync/plan?lineage=l&ticket=SECRET1 cookie openboard_session=SECRET2; Authorization: Bearer SECRET3`,
    );
    expect(text).not.toContain('x'.repeat(43));
    expect(text).not.toMatch(/SECRET\d/);
    expect(text).toContain('ob_<redacted>');
    expect(text).toContain('lineage=l');
  });
});

const OWNER: Actor = { id: 'owner', kind: 'human', name: 'Owner' };

describe('AccessStore', () => {
  let root: string;
  let now: number;
  const store = () => new AccessStore(root, { clock: () => now });

  beforeEach(async () => {
    root = await tempRoot();
    now = Date.parse('2026-11-12T10:00:00.000Z');
  });
  afterEach(async () => {
    await removeRoot(root);
  });

  it('stores only the hash of the secret, in a file only the owner can read', async () => {
    const access = store();
    const { grant, token } = await access.grant(
      { label: 'Ada', role: 'editor', kind: 'human' },
      OWNER,
    );
    expect(token).toMatch(new RegExp(`^ob_${grant.id}_[A-Za-z0-9_-]{43}$`));
    expect(grant).not.toHaveProperty('secretHash');
    expect(grant.actorId).toMatch(/^ada-[a-z0-9]{6}$/);
    const file = path.join(root, 'access.json');
    const text = (await readIfExists(file))?.toString('utf8') ?? '';
    const secretPart = token.split('_').slice(2).join('_');
    expect(text).not.toContain(secretPart);
    expect(text).toContain(hashSecret(secretPart));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(access.verifyToken(token)?.id).toBe(grant.id);
  });

  it('answers the same for a wrong id, a wrong secret and a malformed token', async () => {
    const access = store();
    const { grant, token } = await access.grant(
      { label: 'Ada', role: 'viewer', kind: 'human' },
      OWNER,
    );
    const secretPart = token.slice(`ob_${grant.id}_`.length);
    expect(access.verifyToken(`ob_${grant.id}_${'A'.repeat(43)}`)).toBeNull();
    expect(access.verifyToken(`ob_zzzzzzzzzzzzzzzz_${secretPart}`)).toBeNull();
    expect(access.verifyToken('nonsense')).toBeNull();
    expect(access.verifyToken('')).toBeNull();
  });

  it('expires and revokes grants, with their sessions and tickets', async () => {
    const access = store();
    const short = await access.grant(
      { label: 'Temp', role: 'viewer', kind: 'human', expiresInHours: 1 },
      OWNER,
    );
    expect(access.verifyToken(short.token)).not.toBeNull();
    now += 2 * 3_600_000;
    expect(access.verifyToken(short.token)).toBeNull();

    const kept = await access.grant({ label: 'Ada', role: 'editor', kind: 'human' }, OWNER);
    const grant = access.verifyToken(kept.token);
    if (!grant) throw new Error('no grant');
    const { sessionId, hash } = await access.createSession(grant, 'Ada');
    const { ticket } = access.issueTicket({ grantId: grant.id, via: 'token' });
    const ended: unknown[] = [];
    access.onEnd((end) => ended.push(end));
    await access.revoke(grant.id);
    expect(access.verifyToken(kept.token)).toBeNull();
    expect(access.session(sessionId)).toBeNull();
    expect(access.sessionActive(hash)).toBe(false);
    expect(access.consumeTicket(ticket)).toBeNull();
    expect(ended).toEqual([{ grantId: grant.id }]);
    expect(access.list().find((g) => g.id === grant.id)?.revokedAt).toBeDefined();
  });

  it('keeps sessions across a restart, hashed, and ends them after 30 idle days', async () => {
    const first = store();
    const { token } = await first.grant({ label: 'Ada', role: 'editor', kind: 'human' }, OWNER);
    const grant = first.verifyToken(token);
    if (!grant) throw new Error('no grant');
    const { sessionId } = await first.createSession(grant, 'Ada');
    await first.close();
    const text = (await readIfExists(path.join(root, 'sessions.json')))?.toString('utf8') ?? '';
    expect(text).not.toContain(sessionId);
    expect((await stat(path.join(root, 'sessions.json'))).mode & 0o777).toBe(0o600);

    const second = store();
    await second.load();
    expect(second.session(sessionId)?.record.name).toBe('Ada');
    now += SESSION_IDLE_MS - 1000;
    expect(second.session(sessionId)).not.toBeNull();
    now += SESSION_IDLE_MS + 1;
    expect(second.session(sessionId)).toBeNull();
  });

  it('uses a ticket once, and only before it expires', async () => {
    const access = store();
    const { token } = await access.grant({ label: 'Bot', role: 'viewer', kind: 'agent' }, OWNER);
    const grant = access.verifyToken(token);
    if (!grant) throw new Error('no grant');
    const once = access.issueTicket({ grantId: grant.id, via: 'token' });
    expect(access.consumeTicket(once.ticket)?.grant.id).toBe(grant.id);
    expect(access.consumeTicket(once.ticket)).toBeNull();
    const late = access.issueTicket({ grantId: grant.id, via: 'token' });
    now += TICKET_TTL_MS + 1;
    expect(access.consumeTicket(late.ticket)).toBeNull();
  });

  it('refuses an agent owner and tightens a file others could read', async () => {
    const access = store();
    await expect(
      access.grant({ label: 'Bot', role: 'owner', kind: 'agent' }, OWNER),
    ).rejects.toThrow(/agent grant/);
    await access.grant({ label: 'Ada', role: 'viewer', kind: 'human' }, OWNER);
    const { chmod } = await import('node:fs/promises');
    await chmod(path.join(root, 'access.json'), 0o644);
    const again = store();
    await again.load();
    expect((await stat(path.join(root, 'access.json'))).mode & 0o777).toBe(0o600);
    expect(again.list()).toHaveLength(1);
  });
});
