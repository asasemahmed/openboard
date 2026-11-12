import type { Batch, Session } from '@openboard/core';
import { act, render, screen, within } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import type { ReactNode } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ReplayBanner } from '../shell/ReplayView.js';
import { SessionProvider } from '../state/context.js';
import { REPLAY_OFF } from '../state/replay.js';
import { createSession } from '../state/session.js';
import { createLocalTransport } from '../state/transport.js';
import { AGENT, fakeApi, ME, sampleDoc } from '../test/fixtures.js';
import { registerTrust } from '../trust.js';
import { AgentsPanel } from './AgentsPanel.js';

beforeAll(() => registerTrust());

function setup() {
  const session = createSession({
    boardId: 'test-board',
    actor: ME,
    api: fakeApi(),
    transport: (ydoc) => createLocalTransport(ydoc),
    doc: sampleDoc(),
  });
  const wrap = (children: ReactNode) => (
    <SessionProvider session={session}>
      <ReactFlowProvider>{children}</ReactFlowProvider>
    </SessionProvider>
  );
  /** Put an entry into awareness as if the server had published it. */
  const publish = (clientId: number, state: Record<string, unknown>) =>
    act(() => {
      const awareness = session.presence.awareness;
      awareness.states.set(clientId, state);
      awareness.emit('change', [{ added: [clientId], updated: [], removed: [] }, 'remote']);
    });
  return { session, wrap, publish };
}

const now = new Date().toISOString();
const live = (sessions: Session[]) => ({
  actor: { id: 'system', kind: 'system', name: 'OpenBoard' },
  live: { sessions, at: now },
});
const base = (over: Partial<Session> & { id: string }): Session => ({
  actor: AGENT.id,
  status: 'active',
  startedAt: now,
  lastAt: now,
  recent: [],
  counts: { tools: 0, errors: 0 },
  children: [],
  ...over,
});

describe('agents panel', () => {
  it('teaches how to turn on the recorder when nobody is working', () => {
    const { session, wrap } = setup();
    render(wrap(<AgentsPanel />));
    expect(screen.getByText('No agents are working right now.')).toBeTruthy();
    expect(screen.getByText('openboard connect')).toBeTruthy();
    session.destroy();
  });

  it('shows sessions as a tree with what each is doing, as plain text', () => {
    const { session, wrap, publish } = setup();
    render(wrap(<AgentsPanel />));
    publish(
      901,
      live([
        base({
          id: 'main',
          label: 'Plan checkout',
          current: {
            tool: 'Bash',
            summary: 'pnpm test <b>now</b> [x](javascript:alert(1))',
            since: now,
          },
          counts: { tools: 12, errors: 1 },
          children: ['sub'],
          recent: [{ at: now, tool: 'Read', summary: 'src/app.ts', ok: true }],
        }),
        base({ id: 'sub', parent: 'main', label: 'Explore API' }),
      ]),
    );
    publish(902, {
      actor: { id: AGENT.id, kind: 'agent', name: AGENT.name },
      agent: { status: 'reading', focus: ['risk1'], session: 'main', at: now },
    });
    const rows = screen
      .getAllByRole('listitem')
      .filter((li) => li.classList.contains('session-row'));
    expect(rows).toHaveLength(2);
    const [main, sub] = rows as [HTMLElement, HTMLElement];
    expect(within(main).getByText('Plan checkout')).toBeTruthy();
    expect(within(main).getByText('Reading')).toBeTruthy();
    expect(within(main).getByText('Bash')).toBeTruthy();
    // Untrusted text stays text: no markup, no links.
    expect(within(main).getByText(/pnpm test <b>now<\/b>/)).toBeTruthy();
    expect(main.querySelector('a, b')).toBeNull();
    expect(within(main).getByText('12 tools')).toBeTruthy();
    expect(within(main).getByText('1 error')).toBeTruthy();
    expect(within(main).getByText('Recent steps (1)')).toBeTruthy();
    expect(within(main).getByText(/\d+ s$/)).toBeTruthy();
    expect(sub.classList.contains('is-child')).toBe(true);
    expect(within(sub).getByText('Explore API')).toBeTruthy();
    session.destroy();
  });

  it('lists what a session has claimed and points waiting agents at the review', () => {
    const { session, wrap, publish } = setup();
    const until = new Date(Date.now() + 600_000).toISOString();
    act(() =>
      session.doc.putClaim(
        { nodeId: 'risk1', by: AGENT.id, session: 'main', minutes: 10, at: now, until },
        session.doc.origin(AGENT.id, 'ops'),
      ),
    );
    render(wrap(<AgentsPanel />));
    publish(901, live([base({ id: 'main', status: 'idle' })]));
    publish(902, {
      actor: { id: AGENT.id, kind: 'agent', name: AGENT.name },
      agent: { status: 'waiting', session: 'main', at: now },
    });
    expect(screen.getByRole('button', { name: 'Double charge on retry' })).toBeTruthy();
    expect(screen.getByText('Waiting')).toBeTruthy();
    session.destroy();
  });
});

describe('replay banner', () => {
  it('says plainly that this is the past, when, and how to get back', () => {
    const { session, wrap } = setup();
    const batch: Batch = {
      id: 'b_1',
      cursor: 7,
      at: '2026-03-04T10:20:30.000Z',
      actor: AGENT.id,
      source: 'ops',
      summary: 'Added 2 nodes',
      nodeIds: [],
      edgeIds: [],
    };
    const onExit = vi.fn();
    render(
      wrap(
        <ReplayBanner
          state={{
            ...REPLAY_OFF,
            status: 'ready',
            ticks: [batch, { ...batch, id: 'b_2' }],
            index: 0,
          }}
          onExit={onExit}
        />,
      ),
    );
    const banner = screen.getByRole('status');
    expect(within(banner).getByText(/^Replay: the board on /)).toBeTruthy();
    expect(within(banner).getByText(/Step 1 of 2: planner, Added 2 nodes/)).toBeTruthy();
    expect(within(banner).getByText('This is the past. Nothing here can be edited.')).toBeTruthy();
    act(() => within(banner).getByRole('button', { name: 'Back to live' }).click());
    expect(onExit).toHaveBeenCalled();
    session.destroy();
  });
});
