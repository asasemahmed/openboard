import type { ChangeEntry, ChangesOptions } from '@openboard-dev/core';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerBuiltinDecorations } from '../nodes/builtinDecorations.js';
import { BoardView } from '../shell/BoardView.js';
import { visitKey } from '../state/lastVisit.js';
import { createSession } from '../state/session.js';
import { createLocalTransport } from '../state/transport.js';
import { AGENT, fakeApi, ME, sampleDoc } from '../test/fixtures.js';

beforeAll(() => registerBuiltinDecorations());
afterEach(() => localStorage.clear());

const KEY = `openboard.${visitKey('test-board')}`;

/** A feed at cursor 12 whose last two entries are the agent's. */
function feedApi() {
  const entries: ChangeEntry[] = [
    { seq: 11, at: '2026-11-15T10:00:00.000Z', actor: AGENT.id, kind: 'node_updated', id: 'risk1' },
    { seq: 12, at: '2026-11-15T10:00:01.000Z', actor: AGENT.id, kind: 'node_updated', id: 'task1' },
  ];
  return fakeApi({
    changes: vi.fn(async (boardId: string, opts: ChangesOptions) => ({
      boardId,
      since: opts.since,
      cursor: 12,
      changes: entries.filter((e) => e.seq > opts.since),
      resync: opts.since > 12,
      text: '',
      tokens: 0,
      truncated: false,
    })),
  });
}

async function mount() {
  const session = createSession({
    boardId: 'test-board',
    actor: ME,
    api: feedApi(),
    transport: (ydoc) => createLocalTransport(ydoc),
    doc: sampleDoc(),
    lineage: 'l_test',
  });
  const view = render(<BoardView session={session} onlyRenderVisibleElements={false} />);
  await act(() => session.visit.idle());
  return { session, ...view };
}

describe('the notice of changes since the last visit', () => {
  it('does not appear on the first visit', async () => {
    const { session } = await mount();
    expect(screen.queryByText(/since your last visit/)).toBeNull();
    expect(JSON.parse(localStorage.getItem(KEY) ?? 'null')).toMatchObject({
      lineage: 'l_test',
      cursor: 12,
    });
    session.destroy();
  });

  it('names who changed what, shows it on the cards, and remembers a dismissal', async () => {
    localStorage.setItem(KEY, JSON.stringify({ lineage: 'l_test', cursor: 10, seen: '' }));
    const { container, session } = await mount();
    const notice = screen.getByText('2 changes since your last visit: planner changed 2 cards.')
      .parentElement as HTMLElement;

    const risk = container.querySelector('[data-id="risk1"]') as HTMLElement;
    expect(risk.querySelector('.recent-outline')).toBeNull();
    fireEvent.click(within(notice).getByRole('button', { name: 'Show' }));
    expect(risk.querySelector('.recent-outline')).not.toBeNull();
    expect(within(risk).getByText('planner · updated')).toBeTruthy();
    const note = container.querySelector('[data-id="note1"]') as HTMLElement;
    expect(note.querySelector('.recent-outline')).toBeNull();

    fireEvent.click(within(notice).getByRole('button', { name: 'Dismiss' }));
    await act(() => session.visit.idle());
    expect(screen.queryByText(/since your last visit/)).toBeNull();
    expect(JSON.parse(localStorage.getItem(KEY) ?? 'null')).toMatchObject({ cursor: 12 });
    session.destroy();
  });

  it('says only that the board changed, with nothing to show, for another lineage', async () => {
    localStorage.setItem(KEY, JSON.stringify({ lineage: 'l_old', cursor: 10, seen: '' }));
    const { session } = await mount();
    const notice = screen.getByText('This board changed since your last visit.')
      .parentElement as HTMLElement;
    expect(within(notice).queryByRole('button', { name: 'Show' })).toBeNull();
    session.destroy();
  });
});
