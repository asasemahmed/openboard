import type { Op } from '@openboard/core';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { describe, expect, it, vi } from 'vitest';
import { ActionsProvider, type BoardActions } from '../canvas/actions.js';
import { BoardView } from '../shell/BoardView.js';
import { SessionProvider } from '../state/context.js';
import { createSession } from '../state/session.js';
import { createLocalTransport } from '../state/transport.js';
import { fakeApi, ME, sampleDoc } from '../test/fixtures.js';
import { NeedsAttention } from './NeedsAttention.js';

function newSession() {
  return createSession({
    boardId: 'test-board',
    actor: ME,
    api: fakeApi(),
    transport: (ydoc) => createLocalTransport(ydoc),
    doc: sampleDoc(),
  });
}

function setup() {
  const session = newSession();
  const jumpTo = vi.fn();
  const actions = { jumpTo } as unknown as BoardActions;
  render(
    <SessionProvider session={session}>
      <ReactFlowProvider>
        <ActionsProvider value={actions}>
          <NeedsAttention />
        </ActionsProvider>
      </ReactFlowProvider>
    </SessionProvider>,
  );
  const apply = (ops: Op[]) =>
    act(() => {
      const outcome = session.doc.apply(ops, { actor: ME });
      if (!outcome.ok) throw new Error(JSON.stringify(outcome.errors));
    });
  return { session, jumpTo, apply };
}

const question = (id: string, title: string): Op => ({
  op: 'add_node',
  id,
  node: { type: 'question', title },
});

describe('needs attention', () => {
  it('is not there at all when nothing needs attention', () => {
    const { session } = setup();
    // The sample board's risk is linked to a task, and it has no questions.
    expect(screen.queryByRole('heading', { name: 'Needs attention' })).toBeNull();
    expect(document.body.textContent).toBe('');
    session.destroy();
  });

  it('lists findings grouped by kind, as buttons with the reason', () => {
    const { session, apply } = setup();
    apply([
      question('q1', 'Which columns go into the export?'),
      { op: 'add_node', id: 'r2', node: { type: 'risk', title: 'Vendor lock-in' } },
      { op: 'update_node', id: 'task1', patch: { status: 'blocked' } },
    ]);
    expect(screen.getByRole('heading', { name: 'Needs attention' })).toBeTruthy();

    const questions = screen.getByRole('list', { name: /Open questions/ });
    const [ask] = within(questions).getAllByRole('button');
    expect(ask?.textContent).toContain('Which columns go into the export?');
    expect(ask?.textContent).toContain('No decision answers it');

    const risks = screen.getByRole('list', { name: /Risks without a plan/ });
    expect(within(risks).getByRole('button', { name: /Vendor lock-in/ })).toBeTruthy();

    // The sample risk (in progress) blocks the task: still in the way, so not listed.
    expect(screen.queryByRole('list', { name: /Blocked/ })).toBeNull();
    apply([{ op: 'update_node', id: 'risk1', patch: { status: 'done' } }]);
    const blocked = screen.getByRole('list', { name: /Blocked, but nothing in the way/ });
    expect(
      within(blocked).getByRole('button', {
        name: /Payment API.*Marked blocked, but “Double charge on retry” is done\./,
      }),
    ).toBeTruthy();
    session.destroy();
  });

  it('is a real button that brings the card into view', () => {
    const { session, jumpTo, apply } = setup();
    apply([question('q1', 'Who owns billing?')]);
    const button = screen.getByRole('button', { name: /Who owns billing\?/ });
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    fireEvent.click(button);
    expect(jumpTo).toHaveBeenCalledWith('q1');
    // A native button: the keyboard reaches it with Tab and presses it with Enter or Space.
    button.focus();
    expect(document.activeElement).toBe(button);
    session.destroy();
  });

  it('goes away once the last finding is resolved', () => {
    const { session, apply } = setup();
    apply([question('q1', 'Which columns?')]);
    expect(screen.getByRole('heading', { name: 'Needs attention' })).toBeTruthy();
    apply([
      { op: 'add_node', id: 'd1', node: { type: 'decision', title: 'Id, date and total' } },
      { op: 'add_edge', id: 'e9', edge: { type: 'relates_to', source: 'd1', target: 'q1' } },
    ]);
    expect(screen.queryByRole('heading', { name: 'Needs attention' })).toBeNull();
    session.destroy();
  });

  it('shows five per group, and the rest on request', () => {
    const { session, apply } = setup();
    apply(Array.from({ length: 7 }, (_, i) => question(`q${i}`, `Question ${i}`)));
    const list = () => screen.getByRole('list', { name: /Open questions/ });
    expect(within(list()).getAllByRole('button')).toHaveLength(5);
    const more = screen.getByRole('button', { name: 'Show all 7' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(within(list()).getAllByRole('button')).toHaveLength(7);
    fireEvent.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(within(list()).getAllByRole('button')).toHaveLength(5);
    session.destroy();
  });

  it('follows title changes', () => {
    const { session, apply } = setup();
    apply([question('q1', 'Old title')]);
    apply([{ op: 'update_node', id: 'q1', patch: { title: 'New title' } }]);
    expect(screen.getByRole('button', { name: /New title/ })).toBeTruthy();
    session.destroy();
  });
});

describe('board health in the store', () => {
  it('keeps the same findings while cards only move, and recomputes on a change of meaning', () => {
    const session = newSession();
    const { store, doc } = session;
    doc.apply([question('q1', 'Which columns?')], { actor: ME });
    const first = store.health();
    expect(first.map((f) => f.nodeIds[0])).toEqual(['q1']);
    expect(store.health()).toBe(first);

    doc.apply([{ op: 'move_node', id: 'q1', view: { x: 500, y: 500 } }], { actor: ME });
    expect(store.health()).toBe(first);

    doc.apply([{ op: 'update_node', id: 'q1', patch: { status: 'done' } }], { actor: ME });
    expect(store.health()).not.toBe(first);
    expect(store.health()).toEqual([]);
    session.destroy();
  });
});

describe('needs attention in the inspector', () => {
  it('shows when nothing is selected, and a click opens the card', () => {
    const session = newSession();
    session.doc.apply([question('q1', 'Who owns billing?')], { actor: ME });
    render(<BoardView session={session} onlyRenderVisibleElements={false} />);
    const inspector = screen.getByRole('complementary', { name: 'Inspector' });
    const button = within(inspector).getByRole('button', { name: /Who owns billing\?/ });
    fireEvent.click(button);
    expect(session.store.selection.nodeIds).toEqual(['q1']);
    // Focus moves to the card, so the keyboard carries on from there.
    expect(document.activeElement?.closest('[data-id="q1"]')).not.toBeNull();
    expect(within(inspector).queryByRole('heading', { name: 'Needs attention' })).toBeNull();
    session.destroy();
  });
});
