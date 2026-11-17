import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { access } from '../state/access.js';
import { SessionProvider } from '../state/context.js';
import { createSession } from '../state/session.js';
import { createLocalTransport } from '../state/transport.js';
import { fakeApi, ME, sampleDoc } from '../test/fixtures.js';
import { useBoardActions } from './actions.js';
import { SHORTCUTS, useShortcuts } from './useShortcuts.js';

vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  return {
    ...actual,
    useReactFlow: () => ({
      fitView: vi.fn(),
      zoomIn: vi.fn(),
      zoomOut: vi.fn(),
      zoomTo: vi.fn(),
      screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
    }),
  };
});

function Harness() {
  const actions = useBoardActions();
  useShortcuts(actions);
  return null;
}

function mount() {
  const session = createSession({
    boardId: 'test-board',
    actor: ME,
    api: fakeApi(),
    transport: (ydoc) => createLocalTransport(ydoc),
    doc: sampleDoc(),
  });
  render(
    <SessionProvider session={session}>
      <Harness />
    </SessionProvider>,
  );
  return session;
}

afterEach(() => {
  access.set({ status: 'loading' });
  document.body.innerHTML = '';
});

describe('useShortcuts D, Q and R', () => {
  it('lists D, Q and R in the shortcuts sheet', () => {
    expect(SHORTCUTS).toContainEqual({
      keys: ['d'],
      label: 'New decision at the pointer',
      group: 'Create',
    });
    expect(SHORTCUTS).toContainEqual({
      keys: ['q'],
      label: 'New question at the pointer',
      group: 'Create',
    });
    expect(SHORTCUTS).toContainEqual({
      keys: ['r'],
      label: 'New risk at the pointer',
      group: 'Create',
    });
  });

  it('creates decision, question and risk cards at the pointer', () => {
    const session = mount();
    session.ui.lastPointer = { x: 120, y: 240 };

    const countOf = (type: string) =>
      [...session.store.boardNodes().values()].filter((n) => n.type === type).length;
    const before = {
      decision: countOf('decision'),
      question: countOf('question'),
      risk: countOf('risk'),
    };

    act(() => {
      fireEvent.keyDown(window, { key: 'd' });
      fireEvent.keyDown(window, { key: 'q' });
      fireEvent.keyDown(window, { key: 'r' });
    });

    expect(countOf('decision')).toBe(before.decision + 1);
    expect(countOf('question')).toBe(before.question + 1);
    expect(countOf('risk')).toBe(before.risk + 1);
    session.destroy();
  });

  it('stays inert while typing and for viewers who may not edit', () => {
    const session = mount();
    const initialTotal = session.store.boardNodes().size;

    const input = document.createElement('input');
    document.body.append(input);
    act(() => {
      fireEvent.keyDown(input, { key: 'd' });
      fireEvent.keyDown(input, { key: 'q' });
      fireEvent.keyDown(input, { key: 'r' });
    });
    expect(session.store.boardNodes().size).toBe(initialTotal);

    access.set({
      status: 'ready',
      who: { actor: ME, role: 'viewer', shared: true, via: 'token' },
    });
    act(() => {
      fireEvent.keyDown(window, { key: 'd' });
      fireEvent.keyDown(window, { key: 'q' });
      fireEvent.keyDown(window, { key: 'r' });
    });
    expect(session.store.boardNodes().size).toBe(initialTotal);
    session.destroy();
  });
});
