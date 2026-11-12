import type { Link } from '@openboard/core';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import type { ReactNode } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../lib/api.js';
import { CompareBanner } from '../shell/CompareView.js';
import { serverInfo } from '../state/boards.js';
import { SessionProvider } from '../state/context.js';
import { createSession } from '../state/session.js';
import { createLocalTransport } from '../state/transport.js';
import { fakeApi, ME, sampleDoc } from '../test/fixtures.js';
import { registerTrust } from '../trust.js';
import { LinksEditor } from './LinksEditor.js';

beforeAll(() => registerTrust());

function setup(api: Partial<ApiClient> = {}) {
  const session = createSession({
    boardId: 'test-board',
    actor: ME,
    api: fakeApi(api),
    transport: (ydoc) => createLocalTransport(ydoc),
    doc: sampleDoc(),
  });
  const wrap = (children: ReactNode) => (
    <SessionProvider session={session}>
      <ReactFlowProvider>{children}</ReactFlowProvider>
    </SessionProvider>
  );
  return { session, wrap };
}

const stale: Link = {
  kind: 'file',
  target: 'src/retry.ts',
  line: 3,
  endLine: 5,
  hash: 'sha256:a',
  stale: true,
};
const fresh: Link = { kind: 'file', target: 'src/pay.ts', hash: 'sha256:b' };
const web: Link = { kind: 'url', target: 'https://example.com/spec' };
const bad: Link = { kind: 'url', target: 'javascript:alert(1)' };

describe('inspector links', () => {
  it('shows each link with its state and the server’s detail, and marks it up to date', async () => {
    const refreshLinks = vi.fn(async () => ({ status: 'proposed' as const, cursor: 2, refs: {} }));
    const links = vi.fn(async () => ({
      boardId: 'test-board',
      cursor: 1,
      links: [
        {
          nodeId: 'risk1',
          title: 'Double charge on retry',
          index: 0,
          link: stale,
          state: 'stale' as const,
          detail: 'content changed at lines 3–5',
        },
      ],
      text: '',
      tokens: 0,
      truncated: false,
    }));
    const { wrap, session } = setup({ links, refreshLinks });
    act(() => serverInfo.set({ version: '', root: '/work/shop', projectName: 'shop', url: '' }));
    render(
      wrap(<LinksEditor nodeId="risk1" links={[stale, fresh, web, bad]} onChange={() => {}} />),
    );
    expect(await screen.findByText('Content changed at lines 3–5')).toBeTruthy();
    expect(links).toHaveBeenCalledWith('test-board', { stale: true });
    expect(screen.getByText('Up to date')).toBeTruthy();
    expect(screen.getByText(':3–5')).toBeTruthy();
    // Only http(s) addresses are links, and they open in a new tab without an opener.
    const anchor = screen.getByRole('link', { name: 'https://example.com/spec' });
    expect(anchor.getAttribute('rel')).toBe('noopener noreferrer');
    expect(anchor.getAttribute('target')).toBe('_blank');
    expect(screen.queryByRole('link', { name: /javascript/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open src/retry.ts in the editor' })).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Mark as up to date' }));
    });
    expect(refreshLinks).toHaveBeenCalledWith('test-board', { nodeIds: ['risk1'] });
    expect(screen.getByText(/Sent for review/)).toBeTruthy();
    session.destroy();
  });

  it('adds a file link with a line range and refuses paths outside the project', () => {
    const onChange = vi.fn();
    const { wrap, session } = setup();
    render(wrap(<LinksEditor nodeId="risk1" links={[]} onChange={onChange} />));
    fireEvent.click(screen.getByRole('button', { name: 'Add link' }));
    const path = screen.getByLabelText('File path');
    fireEvent.change(path, { target: { value: '../outside.ts' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add link' }));
    expect(screen.getByRole('alert').textContent).toMatch(/climbs out/);
    fireEvent.change(path, { target: { value: 'src/retry.ts' } });
    fireEvent.change(screen.getByLabelText('Lines'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('To line'), { target: { value: '14' } });
    expect(screen.getByText('/work/shop')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add link' }));
    expect(onChange).toHaveBeenCalledWith([
      { kind: 'file', target: 'src/retry.ts', line: 10, endLine: 14 },
    ]);
    session.destroy();
  });
});

describe('compare banner', () => {
  it('names the revision, sums up the changes and leads back to live', () => {
    const { wrap, session } = setup();
    const onExit = vi.fn();
    render(
      wrap(
        <CompareBanner
          target={{ rev: 'abcdef1234', short: 'abcdef1', subject: 'Plan the refunds' }}
          view={{
            marks: new Map(),
            edgeMarks: new Map(),
            ghostNodes: [],
            ghostEdges: [],
            removed: new Set(),
            counts: { added: 2, updated: 1, moved: 0, removed: 3 },
            entries: [],
            touched: new Set(),
          }}
          onExit={onExit}
        />,
      ),
    );
    const banner = screen.getByRole('status');
    expect(within(banner).getByText('Comparing with abcdef1 — Plan the refunds')).toBeTruthy();
    expect(within(banner).getByText('Since then: 2 added, 1 updated, 3 removed.')).toBeTruthy();
    fireEvent.click(within(banner).getByRole('button', { name: 'Back to live' }));
    expect(onExit).toHaveBeenCalled();
    session.destroy();
  });
});
