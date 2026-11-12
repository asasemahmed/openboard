import { type AccessGrant, can, type Role, type WhoAmI } from '@openboard/core';
import { act, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApiClient, onUnauthorized } from '../lib/api.js';
import { initialJoin, joinReducer, takeJoinToken } from '../lib/join.js';
import { CONTROL_GROUPS, disabledReason } from '../lib/roles.js';
import { grantStatus, INITIAL_SHARE, shareReducer, sortedGrants } from '../lib/share.js';
import { postComment } from '../panels/Threads.js';
import { BoardView } from '../shell/BoardView.js';
import { fakeApi, ME, sampleDoc } from '../test/fixtures.js';
import { registerTrust } from '../trust.js';
import { access, setWho, signedOut } from './access.js';
import { ConnectionStore } from './connection.js';
import { actorFor } from './identity.js';
import { createSession } from './session.js';
import { createLocalTransport, type Transport } from './transport.js';

beforeAll(() => registerTrust());
afterEach(() => {
  access.set({ status: 'loading' });
  onUnauthorized(null);
});

const who = (role: Role, via: WhoAmI['via'] = 'session'): WhoAmI => ({
  actor: { id: 'ada-k3x9a0', kind: 'human', name: 'Ada’s laptop' },
  role,
  shared: true,
  via,
  grantId: 'k3x9a0aaaaaaaaaa',
});

describe('roles drive the interface', () => {
  const expected: Record<keyof typeof CONTROL_GROUPS, Role[]> = {
    editCanvas: ['owner', 'editor'],
    addNodes: ['owner', 'editor'],
    tidy: ['owner', 'editor'],
    importInto: ['owner', 'editor'],
    inspectorEdit: ['owner', 'editor'],
    claimRelease: ['owner', 'editor'],
    refreshLinks: ['owner', 'editor'],
    undo: ['owner', 'editor'],
    decideProposals: ['owner', 'editor'],
    comment: ['owner', 'editor', 'commenter'],
    answerQuestions: ['owner', 'editor', 'commenter'],
    dismissQuestions: ['owner', 'editor', 'commenter'],
    policySettings: ['owner'],
    share: ['owner'],
    newBoard: ['owner', 'editor'],
    readAndExport: ['owner', 'editor', 'commenter', 'viewer'],
  };
  for (const [group, action] of Object.entries(CONTROL_GROUPS)) {
    it(`${group}: ${action}`, () => {
      const allowed = (['owner', 'editor', 'commenter', 'viewer'] as const).filter((r) =>
        can(r, action),
      );
      expect(allowed).toEqual(expected[group as keyof typeof CONTROL_GROUPS]);
    });
  }
  it('says why a control is off', () => {
    expect(disabledReason('viewer', 'board.edit')).toBe(
      'Your access (viewer) does not let you change this board. Editors and owners can.',
    );
    expect(disabledReason('editor', 'config.write')).toMatch(/Owners can\.$/);
  });
});

describe('joining from an invite link', () => {
  it('takes the token out of the address at once, and never redirects', () => {
    const replace = vi.fn();
    expect(takeJoinToken({ pathname: '/join', hash: '#ob_abc_xyz' }, replace)).toBe('ob_abc_xyz');
    expect(replace).toHaveBeenCalledWith('/join');
    expect(takeJoinToken({ pathname: '/join/', hash: '' }, vi.fn())).toBe('');
    const other = vi.fn();
    expect(takeJoinToken({ pathname: '/b/main', hash: '#ob_x' }, other)).toBeNull();
    expect(other).not.toHaveBeenCalled();
  });

  it('moves through joining, joined, and each failure', () => {
    expect(initialJoin(null)).toEqual({ step: 'no-token' });
    const joining = initialJoin('ob_t');
    expect(joinReducer(joining, { type: 'joined', who: who('editor') })).toMatchObject({
      step: 'joined',
    });
    const fail = (status: number, code: string, message = '', retryAfter: number | null = null) =>
      joinReducer(joining, { type: 'failed', status, code, message, retryAfter });
    expect(fail(401, 'unauthorized', 'this invite link is not valid')).toEqual({
      step: 'invalid',
      message: 'this invite link is not valid',
    });
    expect(fail(429, 'rate_limited', '', 42)).toEqual({ step: 'rate-limited', retryAfter: 42 });
    expect(fail(0, 'unreachable')).toEqual({ step: 'unreachable' });
    expect(fail(400, 'invalid_request', 'this server is not shared; no sign-in is needed')).toEqual(
      {
        step: 'not-shared',
      },
    );
    // Trying again after a rate limit starts over.
    expect(joinReducer({ step: 'rate-limited', retryAfter: 1 }, { type: 'start' })).toEqual({
      step: 'joining',
    });
  });
});

describe('signed out', () => {
  function respond(status: number, body: unknown) {
    return vi.fn(async (url: string) => ({
      ok: status < 400,
      status,
      url: new URL(url, 'http://localhost').href,
      text: async () => JSON.stringify(body),
      headers: new Headers(),
    }));
  }

  it('signs out on any 401, but not on a bad invite link', async () => {
    const handler = vi.fn();
    onUnauthorized(handler);
    const unauthorized = { error: { code: 'unauthorized', message: 'access ended' } };
    vi.stubGlobal('fetch', respond(401, unauthorized));
    const api = createApiClient(() => ME);
    await expect(api.listBoards()).rejects.toMatchObject({ status: 401 });
    expect(handler).toHaveBeenCalledWith('access ended');
    handler.mockClear();
    await expect(api.signIn('ob_bad')).rejects.toMatchObject({ status: 401 });
    expect(handler).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('remembers unsaved edits across reasons', () => {
    signedOut('revoked', '', true);
    signedOut('unauthorized', 'x');
    expect(access.get()).toMatchObject({
      status: 'signed-out',
      reason: 'unauthorized',
      lostEdits: true,
    });
  });

  it('reports a revoked connection, which stops reconnecting', () => {
    let revoked = false;
    let notify = () => {};
    const transport: Transport = {
      ...createLocalTransport(sampleDoc().ydoc),
      status: () => (revoked ? 'disconnected' : 'connected'),
      revoked: () => revoked,
      onChange: (listener) => {
        notify = listener;
        return () => {};
      },
    };
    const reconnect = vi.spyOn(transport, 'reconnect');
    const connection = new ConnectionStore(transport);
    revoked = true;
    notify();
    expect(connection.get()).toMatchObject({ revoked: true, status: 'offline' });
    expect(reconnect).not.toHaveBeenCalled();
  });
});

describe('identity from whoami', () => {
  it('uses the grant’s actor id in shared mode, and the local one at this machine', () => {
    const local = { id: 'a_local1', name: 'Sven', color: '#1D5FBF' };
    expect(actorFor(local, who('editor'))).toEqual({
      id: 'ada-k3x9a0',
      kind: 'human',
      name: 'Sven',
      color: '#1D5FBF',
    });
    expect(actorFor(local, who('owner', 'local')).id).toBe('a_local1');
    expect(actorFor(local, null).id).toBe('a_local1');
  });

  it('publishes the grant’s actor in presence', async () => {
    setWho(who('editor'));
    const { currentActor } = await import('./identity.js');
    const session = createSession({
      boardId: 'test-board',
      actor: currentActor(),
      api: fakeApi(),
      transport: (ydoc) => createLocalTransport(ydoc),
      doc: sampleDoc(),
    });
    expect(session.presence.localState().actor.id).toBe('ada-k3x9a0');
    session.destroy();
  });
});

describe('commenters comment through the API', () => {
  it('posts to the comments route and leaves the document alone', async () => {
    setWho(who('commenter'));
    const comment = vi.fn(async () => ({}) as never);
    const doc = sampleDoc();
    const session = createSession({
      boardId: 'test-board',
      actor: ME,
      api: fakeApi({ comment }),
      transport: (ydoc) => createLocalTransport(ydoc),
      doc,
    });
    expect(await postComment(session, ' Looks good ', ['planner'], { nodeId: 'risk1' })).toBe(true);
    expect(comment).toHaveBeenCalledWith('test-board', {
      body: 'Looks good',
      nodeId: 'risk1',
      mentions: ['planner'],
    });
    expect(doc.comments()).toHaveLength(0);
    session.destroy();
  });
});

describe('share dialog model', () => {
  const grant = (over: Partial<AccessGrant> = {}): AccessGrant => ({
    id: 'aaaaaaaaaaaaaaaa',
    label: 'Ada',
    role: 'editor',
    kind: 'human',
    actorId: 'ada-aaaaaa',
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'owner',
    ...over,
  });

  it('shows a new invite once, and forgets it when hidden or closed', () => {
    let s = shareReducer(INITIAL_SHARE, { type: 'loaded', grants: [] });
    s = shareReducer(s, { type: 'create', kind: 'human' });
    expect(s.busy).toBe('human');
    s = shareReducer(s, {
      type: 'created',
      kind: 'human',
      result: { grant: grant(), token: 'ob_secret', inviteUrl: 'https://b.example/join#ob_secret' },
    });
    expect(s.revealed).toMatchObject({ kind: 'human', secret: 'https://b.example/join#ob_secret' });
    expect(s.grants).toHaveLength(1);
    expect(shareReducer(s, { type: 'hide' }).revealed).toBeNull();
    expect(shareReducer(s, { type: 'closed' })).toEqual(INITIAL_SHARE);
    const agent = shareReducer(s, {
      type: 'created',
      kind: 'agent',
      result: { grant: grant({ id: 'bbbbbbbbbbbbbbbb', kind: 'agent' }), token: 'ob_agent' },
    });
    expect(agent.revealed).toMatchObject({ kind: 'agent', secret: 'ob_agent' });
  });

  it('marks revoked grants and sorts them out of the active list', () => {
    const active = grant();
    let s = shareReducer(INITIAL_SHARE, { type: 'loaded', grants: [active] });
    const revoked = { ...active, revokedAt: '2026-01-02T00:00:00.000Z' };
    s = shareReducer(s, { type: 'revoked', grant: revoked });
    expect(grantStatus(revoked, Date.now())).toBe('revoked');
    expect(grantStatus(grant({ expiresAt: '2000-01-01T00:00:00.000Z' }), Date.now())).toBe(
      'expired',
    );
    expect(sortedGrants(s.grants ?? [], Date.now())).toEqual({ active: [], ended: [revoked] });
  });
});

describe('a viewer’s board', () => {
  it('has no editing affordances on cards, in the top bar or in the inspector', async () => {
    setWho(who('viewer'));
    const session = createSession({
      boardId: 'test-board',
      actor: ME,
      api: fakeApi(),
      transport: (ydoc) => createLocalTransport(ydoc),
      doc: sampleDoc(),
      readOnly: true,
    });
    const view = render(<BoardView session={session} onlyRenderVisibleElements={false} />);
    expect(view.container.querySelector('.canvas-root.is-readonly')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(screen.getByRole('status', { name: /View only/ })).toBeTruthy();
    // No title editing, even from the keyboard.
    act(() => session.ui.editing.set('risk1'));
    expect(session.ui.editing.get()).toBeNull();
    act(() => session.store.select(['risk1']));
    const inspector = screen.getByRole('complementary', { name: 'Inspector' });
    const title = (await within(inspector).findByDisplayValue(
      'Double charge on retry',
    )) as HTMLTextAreaElement;
    expect(title.closest('fieldset')?.disabled).toBe(true);
    expect(within(inspector).getByRole('note').textContent).toMatch(
      /does not let you change this board/,
    );
    expect(within(inspector).queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(within(inspector).queryByRole('combobox', { name: /Comment on this card/ })).toBeNull();
    session.destroy();
  });
});
