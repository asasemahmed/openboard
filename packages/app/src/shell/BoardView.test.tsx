import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { registerBuiltinDecorations } from '../nodes/builtinDecorations.js';
import { createSession } from '../state/session.js';
import { createLocalTransport } from '../state/transport.js';
import { AGENT, ME, sampleDoc } from '../test/fixtures.js';
import { BoardView } from './BoardView.js';

beforeAll(() => registerBuiltinDecorations());

function mount() {
  const session = createSession({
    boardId: 'test-board',
    actor: ME,
    api: {
      listBoards: vi.fn(async () => []),
      createBoard: vi.fn(),
      layout: vi.fn(async () => ({ boardId: 'test-board', cursor: 1, moved: 3 })),
    },
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
    expect(card.getByText('risk')).toBeTruthy();
    expect(card.getByText('Double charge on retry')).toBeTruthy();
    expect(card.getByText('If the gateway times out we may retry twice.')).toBeTruthy();
    expect(card.getByText('In progress')).toBeTruthy();
    expect(card.getByText('payments')).toBeTruthy();
    expect(card.getByText('+1')).toBeTruthy();

    const task = within(container.querySelector('[data-id="task1"]') as HTMLElement);
    expect(task.getByText('task')).toBeTruthy();
    expect(task.getByText('Done')).toBeTruthy();

    const frame = within(container.querySelector('[data-id="outer"]') as HTMLElement);
    expect(frame.getByText('Release')).toBeTruthy();
    session.destroy();
  });

  it('shows the board name and the inspector for a selected node', () => {
    const { session } = mount();
    expect(screen.getByRole('button', { name: 'Checkout' })).toBeTruthy();
    act(() => session.store.select(['risk1']));
    const inspector = screen.getByRole('complementary', { name: 'Inspector' });
    expect(within(inspector).getByDisplayValue('Double charge on retry')).toBeTruthy();
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

  it('shows the empty state on an empty board', async () => {
    const { BoardDoc } = await import('@openboard/core');
    const session = createSession({
      boardId: 'empty',
      actor: ME,
      api: { listBoards: vi.fn(), createBoard: vi.fn(), layout: vi.fn() },
      transport: (ydoc) => createLocalTransport(ydoc),
      doc: BoardDoc.create({ id: 'empty', name: 'Empty' }),
    });
    render(<BoardView session={session} onlyRenderVisibleElements={false} />);
    expect(screen.getByText('This board is empty')).toBeTruthy();
    expect(screen.getByText(/Agents connected over MCP/)).toBeTruthy();
    session.destroy();
  });
});
