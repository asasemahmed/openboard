import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { registerBuiltinDecorations } from '../nodes/builtinDecorations.js';
import { createSession } from '../state/session.js';
import { createLocalTransport } from '../state/transport.js';
import { AGENT, fakeApi, ME, sampleDoc } from '../test/fixtures.js';
import { BoardView } from './BoardView.js';

beforeAll(() => registerBuiltinDecorations());

function mount() {
  const session = createSession({
    boardId: 'test-board',
    actor: ME,
    api: fakeApi({ layout: vi.fn(async () => ({ boardId: 'test-board', cursor: 1, moved: 3 })) }),
    transport: (ydoc) => createLocalTransport(ydoc),
    doc: sampleDoc(),
  });
  const view = render(<BoardView session={session} onlyRenderVisibleElements={false} />);
  return { session, ...view };
}

describe('BoardView', () => {
  it('renders cards with type, title, body preview and status', () => {
    const { container, session } = mount();
    const risk = container.querySelector('[data-id="risk1"]') as HTMLElement;
    expect(risk).not.toBeNull();
    const card = within(risk);
    expect(card.getByText('Risk')).toBeTruthy();
    expect(card.getByText('Double charge on retry')).toBeTruthy();
    expect(card.getByText('If the gateway times out we may retry twice.')).toBeTruthy();
    expect(card.getByText('In progress')).toBeTruthy();
    expect(card.getByText('payments')).toBeTruthy();
    expect(card.getByText('+1')).toBeTruthy();

    const task = within(container.querySelector('[data-id="task1"]') as HTMLElement);
    expect(task.getByText('Task')).toBeTruthy();
    expect(task.getByText('Done')).toBeTruthy();

    const frame = within(container.querySelector('[data-id="outer"]') as HTMLElement);
    expect(frame.getByText('Release')).toBeTruthy();
    session.destroy();
  });

  it("keeps an agent's connections out of sight until their card is selected", () => {
    const { container, session } = mount();
    const drawn = () => container.querySelectorAll('path.board-edge').length;
    // Both sample edges were made by the agent.
    expect(drawn()).toBe(0);
    const risk = within(container.querySelector('[data-id="risk1"]') as HTMLElement);
    expect(risk.getByRole('img', { name: /2 connections made by an agent/ })).toBeTruthy();

    act(() => session.store.select(['task1']));
    expect(drawn()).toBe(1);
    act(() => session.store.select(['risk1']));
    expect(drawn()).toBe(2);
    act(() => session.store.clearSelection());
    expect(drawn()).toBe(0);

    act(() => session.ui.hoverNode.set('note1'));
    expect(drawn()).toBe(1);
    act(() => session.ui.hoverNode.set(null));

    act(() => session.ui.connections.set('all'));
    expect(drawn()).toBe(2);
    expect(risk.queryByRole('img', { name: /connections made by an agent/ })).toBeNull();
    act(() => session.ui.connections.set('quiet'));
    session.destroy();
  });

  it('always draws a connection a person made', () => {
    const { container, session } = mount();
    act(() => {
      session.doc.apply(
        [
          {
            op: 'add_edge',
            id: 'e3',
            edge: { type: 'depends_on', source: 'task1', target: 'note1' },
          },
        ],
        { actor: ME },
      );
    });
    expect(container.querySelectorAll('path.board-edge')).toHaveLength(1);
    session.destroy();
  });

  it('shows the board name and the inspector for a selected node', async () => {
    const { session } = mount();
    expect(screen.getByRole('button', { name: 'Checkout' })).toBeTruthy();
    act(() => session.store.select(['risk1']));
    const inspector = screen.getByRole('complementary', { name: 'Inspector' });
    expect(await within(inspector).findByDisplayValue('Double charge on retry')).toBeTruthy();
    expect(within(inspector).getByText('risk1')).toBeTruthy();
    expect(within(inspector).getByText(/Created by/)).toBeTruthy();
    session.destroy();
  });

  it('reflects remote edits without a reload', () => {
    const { container, session } = mount();
    act(() => {
      session.doc.apply([{ op: 'update_node', id: 'task1', patch: { status: 'blocked' } }], {
        actor: AGENT,
      });
    });
    const task = within(container.querySelector('[data-id="task1"]') as HTMLElement);
    expect(task.getByText('Blocked')).toBeTruthy();
    session.destroy();
  });

  it('adds a note with the N key', () => {
    const { session } = mount();
    const before = session.store.nodeCount;
    act(() => {
      fireEvent.keyDown(window, { key: 'n' });
    });
    expect(session.store.nodeCount).toBe(before + 1);
    expect(session.store.selection.nodeIds).toHaveLength(1);
    expect(session.presence.localState().selection?.nodeIds).toEqual(
      session.store.selection.nodeIds,
    );
    session.destroy();
  });

  it('toggles every connection with C without changing the board', () => {
    const { container, session } = mount();
    act(() => session.ui.connections.set('quiet'));
    const before = session.store.nodeCount;
    expect(container.querySelectorAll('path.board-edge')).toHaveLength(0);
    fireEvent.keyDown(window, { key: 'c' });
    expect(session.ui.connections.get()).toBe('all');
    expect(container.querySelectorAll('path.board-edge')).toHaveLength(2);
    fireEvent.keyDown(window, { key: 'c' });
    expect(session.ui.connections.get()).toBe('quiet');
    expect(container.querySelectorAll('path.board-edge')).toHaveLength(0);
    expect(session.store.nodeCount).toBe(before);
    session.destroy();
  });

  it('keeps C inert while typing, composing, or a modal is open', () => {
    const { container, session } = mount();
    act(() => session.ui.connections.set('quiet'));
    const input = document.createElement('input');
    container.append(input);
    fireEvent.keyDown(input, { key: 'c' });
    expect(session.ui.connections.get()).toBe('quiet');
    fireEvent.keyDown(window, { key: 'c', isComposing: true });
    expect(session.ui.connections.get()).toBe('quiet');
    fireEvent.keyDown(window, { key: 'c', ctrlKey: true });
    expect(session.ui.connections.get()).toBe('quiet');
    act(() => session.ui.shortcuts.set(true));
    fireEvent.keyDown(window, { key: 'c' });
    expect(session.ui.connections.get()).toBe('quiet');
    session.destroy();
  });

  it('marks nodes an agent created, and leaves people’s nodes unmarked', () => {
    const { container, session } = mount();
    act(() => {
      session.store.apply(
        [
          {
            op: 'add_node',
            id: 'mine',
            node: { type: 'note', title: 'By hand', view: { x: 0, y: 400 } },
          },
        ],
        ME,
      );
    });
    const risk = container.querySelector('[data-id="risk1"]') as HTMLElement;
    expect(within(risk).getByRole('img', { name: 'Created by planner' })).toBeTruthy();
    const mine = container.querySelector('[data-id="mine"]') as HTMLElement;
    expect(mine).not.toBeNull();
    expect(within(mine).queryByRole('img', { name: /Created by/ })).toBeNull();
    session.destroy();
  });

  it('highlights what someone else just changed, with their name', () => {
    const { container, session } = mount();
    act(() => {
      session.doc.apply([{ op: 'update_node', id: 'note1', patch: { title: 'Edited' } }], {
        actor: AGENT,
      });
    });
    const note = container.querySelector('[data-id="note1"]') as HTMLElement;
    expect(within(note).getByText('planner · updated')).toBeTruthy();
    act(() => {
      session.store.apply([{ op: 'update_node', id: 'risk1', patch: { title: 'Mine' } }], ME);
    });
    const risk = container.querySelector('[data-id="risk1"]') as HTMLElement;
    expect(risk.querySelector('.recent-outline')).toBeNull();
    session.destroy();
  });

  it('moves between cards with Tab in reading order and edits with Enter', () => {
    const { container, session } = mount();
    const card = (id: string) =>
      container.querySelector(`[data-id="${id}"] [data-node-focus]`) as HTMLElement;
    // One tab stop for the whole canvas: the first node in reading order.
    const stops = container.querySelectorAll('[data-node-focus][tabindex="0"]');
    expect(stops).toHaveLength(1);
    expect(card('note1').tabIndex).toBe(0);
    act(() => card('note1').focus());
    act(() => {
      fireEvent.keyDown(card('note1'), { key: 'Tab' });
    });
    expect(session.store.selection.nodeIds).toEqual(['outer']);
    expect(document.activeElement).toBe(card('outer'));
    act(() => {
      fireEvent.keyDown(card('outer'), { key: 'Enter' });
    });
    expect(session.ui.editing.get()).toBe('outer');
    session.destroy();
  });

  it('shows the empty state on an empty board', async () => {
    const { BoardDoc } = await import('@openboard/core');
    const session = createSession({
      boardId: 'empty',
      actor: ME,
      api: fakeApi(),
      transport: (ydoc) => createLocalTransport(ydoc),
      doc: BoardDoc.create({ id: 'empty', name: 'Empty' }),
    });
    render(<BoardView session={session} onlyRenderVisibleElements={false} />);
    expect(screen.getByText('This board is empty')).toBeTruthy();
    expect(screen.getByText(/Agents connected over MCP/)).toBeTruthy();
    session.destroy();
  });
});
