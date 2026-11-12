import { type Ask, BoardDoc, MENTION_AGENTS } from '@openboard/core';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import type { ReactNode } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { AskCard } from '../canvas/AskStack.js';
import type { ApiClient } from '../lib/api.js';
import { BoardView } from '../shell/BoardView.js';
import { SessionProvider } from '../state/context.js';
import { createSession } from '../state/session.js';
import { createLocalTransport } from '../state/transport.js';
import { AGENT, fakeApi, ME, propose, sampleDoc } from '../test/fixtures.js';
import { registerTrust } from '../trust.js';
import { ReviewPanel } from './ReviewPanel.js';
import { Composer, postComment } from './Threads.js';

beforeAll(() => registerTrust());

function setup(api: Partial<ApiClient> = {}, doc: BoardDoc = sampleDoc()) {
  const session = createSession({
    boardId: 'test-board',
    actor: ME,
    api: fakeApi(api),
    transport: (ydoc) => createLocalTransport(ydoc),
    doc,
  });
  const wrap = (children: ReactNode) => (
    <SessionProvider session={session}>
      <ReactFlowProvider>{children}</ReactFlowProvider>
    </SessionProvider>
  );
  return { session, doc, wrap };
}

describe('review panel', () => {
  function withProposal(decide = vi.fn()) {
    const doc = sampleDoc();
    const proposal = propose(
      doc,
      [
        { op: 'add_node', ref: 'a', node: { type: 'task', title: 'Charge' } },
        { op: 'add_edge', edge: { type: 'blocks', source: '$a', target: 'task1' } },
        { op: 'update_node', id: 'risk1', patch: { status: 'done' } },
      ],
      ['free', 'free', 'review'],
      { reason: 'Split the payment work' },
    );
    const ctx = setup(
      {
        decideProposal: decide.mockImplementation(async () => ({
          ...proposal,
          status: 'partly_accepted',
          items: proposal.items.map((item) =>
            item.index === 2 ? { ...item, status: 'accepted' } : { ...item, status: 'pending' },
          ),
        })),
      },
      doc,
    );
    return { ...ctx, proposal, decide };
  }

  it('lists the items and sends the selected ones with a note', async () => {
    const { wrap, proposal, decide, session } = withProposal();
    render(wrap(<ReviewPanel />));
    expect(screen.getByText('Split the payment work')).toBeTruthy();
    const charge = screen.getByRole('checkbox', { name: /Add task "Charge"/ });
    const edge = screen.getByRole('checkbox', { name: /Connect "Charge" blocks/ });
    const update = screen.getByRole('checkbox', { name: /Update "Double charge on retry"/ });
    expect([charge, edge, update].every((c) => (c as HTMLInputElement).checked)).toBe(true);

    // Unchecking the node unchecks the edge that needs it.
    fireEvent.click(charge);
    expect((edge as HTMLInputElement).checked).toBe(false);
    expect((update as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /Add a note/ }));
    fireEvent.change(screen.getByLabelText(/Note for/), {
      target: { value: 'Keep the task for later' },
    });
    expect(screen.getByText(/will see this note/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Accept selected (1)' }));
    });
    expect(decide).toHaveBeenCalledWith('test-board', proposal.id, {
      action: 'accept',
      items: [2],
      note: 'Keep the task for later',
    });
    expect(await screen.findByText('Accepted 1 item.')).toBeTruthy();
    session.destroy();
  });

  it('rejects everything with R from the keyboard', async () => {
    const { wrap, proposal, decide, session } = withProposal();
    render(wrap(<ReviewPanel />));
    const first = screen.getByRole('checkbox', { name: /Add task "Charge"/ });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: /Connect/ }));
    await act(async () => {
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'r' });
    });
    expect(decide).toHaveBeenCalledWith('test-board', proposal.id, { action: 'reject' });
    session.destroy();
  });

  it('shows conflicts that cannot be accepted, and teaches when empty', () => {
    const { wrap, proposal, doc, session } = withProposal();
    doc.putProposal(
      {
        ...proposal,
        items: proposal.items.map((item) =>
          item.index === 2
            ? { ...item, status: 'conflict', conflict: 'it was changed by Ada' }
            : item,
        ),
      },
      doc.origin('system', 'ops'),
    );
    const view = render(wrap(<ReviewPanel />));
    expect(screen.queryByRole('checkbox', { name: /Update/ })).toBeNull();
    expect(screen.getByText(/Can’t be accepted: it was changed by Ada/)).toBeTruthy();
    view.unmount();
    session.destroy();

    const empty = setup();
    render(empty.wrap(<ReviewPanel />));
    expect(screen.getByText(/Nothing to review/)).toBeTruthy();
    empty.session.destroy();
  });

  it('draws the proposal on the board, opens the panel and decides inline', async () => {
    const { session, proposal, decide } = withProposal();
    const view = render(<BoardView session={session} onlyRenderVisibleElements={false} />);
    const ghost = view.container.querySelector('.card.is-ghost') as HTMLElement;
    expect(ghost.getAttribute('aria-label')).toBe('Proposed task: Charge. Open the review');
    const risk = view.container.querySelector('[data-id="risk1"]') as HTMLElement;
    expect(within(risk).getByText('Edit proposed')).toBeTruthy();
    // The review panel opened on its own, without taking focus.
    expect(session.ui.rightPanel.get()).toBe('review');
    const inline = screen.getByRole('region', { name: `Decide on the proposal by ${AGENT.name}` });
    await act(async () => {
      fireEvent.click(within(inline).getByRole('button', { name: 'Accept' }));
    });
    expect(decide).toHaveBeenCalledWith('test-board', proposal.id, { action: 'accept' });
    session.destroy();
  });
});

describe('ask card', () => {
  const ask: Ask = {
    id: 'a_q1',
    author: AGENT.id,
    kind: 'approval',
    question: 'May I delete the old frame?',
    status: 'open',
    createdAt: new Date().toISOString(),
    nodeIds: ['outer'],
  };

  it('answers with an option and the text that goes with it', async () => {
    const answerAsk = vi.fn(async () => ({ ...ask, status: 'answered' as const }));
    const { wrap, session } = setup({ answerAsk });
    const onAnswered = vi.fn();
    render(wrap(<AskCard ask={ask} onAnswered={onAnswered} />));
    const approve = screen.getByRole('button', { name: 'Approve' });
    expect(approve.className).toContain('pill-accept');
    expect(screen.getByRole('button', { name: 'Decline' }).className).toContain('pill-reject');
    const field = screen.getByPlaceholderText('Answer…');
    expect(document.activeElement).not.toBe(field);
    fireEvent.change(field, { target: { value: 'Only after Friday' } });
    await act(async () => {
      fireEvent.click(approve);
    });
    expect(answerAsk).toHaveBeenCalledWith('test-board', 'a_q1', {
      option: 'Approve',
      text: 'Only after Friday',
    });
    expect(onAnswered).toHaveBeenCalledWith(`Answer sent to ${AGENT.name}`);
    expect(screen.getByRole('button', { name: /Point/ })).toBeTruthy();
    session.destroy();
  });

  it('answers in text alone and reports a calm error', async () => {
    const { ApiError } = await import('../lib/api.js');
    const answerAsk = vi.fn(async () => {
      throw new ApiError('conflict', 'question "a_q1" is already answered', 409);
    });
    const { wrap, session } = setup({ answerAsk });
    render(wrap(<AskCard ask={{ ...ask, kind: 'question', options: undefined }} />));
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('Answer…'), { target: { value: 'Blue' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    });
    expect(answerAsk).toHaveBeenCalledWith('test-board', 'a_q1', { text: 'Blue' });
    expect(screen.getByRole('alert').textContent).toBe(
      'This question was already answered or withdrawn.',
    );
    session.destroy();
  });
});

describe('comment composer', () => {
  it('writes a valid comment with mentions into the board document', async () => {
    const doc = sampleDoc();
    const { wrap, session } = setup({}, doc);
    render(
      wrap(
        <Composer
          label="New comment"
          onSubmit={(body, mentions) => postComment(session, body, mentions, { nodeId: 'risk1' })}
        />,
      ),
    );
    const box = screen.getByRole('combobox', { name: 'New comment' }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'Please check @pla', selectionStart: 17 } });
    const option = screen.getByRole('option', { name: `@${AGENT.name}` });
    fireEvent.pointerDown(option);
    expect(box.value).toBe(`Please check @${AGENT.name} `);
    fireEvent.change(box, {
      target: { value: `${box.value}and @All`, selectionStart: box.value.length + 8 },
    });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(box.value).toBe(`Please check @${AGENT.name} and @All agents `);
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    });

    const [comment] = doc.comments();
    expect(comment).toMatchObject({
      author: ME.id,
      nodeId: 'risk1',
      body: `Please check @${AGENT.name} and @All agents`,
      mentions: [AGENT.id, MENTION_AGENTS],
    });
    expect(comment?.thread).toBe(comment?.id);
    expect(doc.toJSON().actors[ME.id]?.name).toBe(ME.name);
    expect(doc.issues()).toEqual([]);
    expect(box.value).toBe('');
    session.destroy();
  });

  it('works without a server: nothing goes over the network', () => {
    const doc = BoardDoc.create({ id: 'b', name: 'B' });
    const { session } = setup({}, doc);
    expect(postComment(session, 'Board note', [], {})).toBe(true);
    expect(doc.comments()[0]?.nodeId).toBeUndefined();
    session.destroy();
  });
});
