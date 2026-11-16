import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { registerBuiltinDecorations } from '../nodes/builtinDecorations.js';
import { BoardView } from '../shell/BoardView.js';
import { createSession } from '../state/session.js';
import { createLocalTransport } from '../state/transport.js';
import { fakeApi, ME, sampleDoc } from '../test/fixtures.js';
import { readyToFit } from './initialFit.js';

beforeAll(() => registerBuiltinDecorations());

const WINDOW = { width: window.innerWidth, height: window.innerHeight };

function setWindowSize(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

afterEach(() => {
  setWindowSize(WINDOW.width, WINDOW.height);
  localStorage.clear();
});

async function mount() {
  const session = createSession({
    boardId: 'test-board',
    actor: ME,
    api: fakeApi(),
    transport: (ydoc) => createLocalTransport(ydoc),
    doc: sampleDoc(),
    lineage: 'l_test',
  });
  const view = render(<BoardView session={session} onlyRenderVisibleElements={false} />);
  await act(() => session.visit.idle());
  const viewport = view.container.querySelector('.react-flow__viewport') as HTMLElement;
  const transform = () => viewport.style.transform.replace(/\s+/g, '');
  return { session, transform };
}

const UNFITTED = 'translate(0px,0px)scale(1)';

describe('readyToFit', () => {
  it('waits for both the canvas and the window to have a size', () => {
    const size = { width: 1024, height: 716 };
    expect(readyToFit(size, { width: 1024, height: 768 })).toBe(true);
    expect(readyToFit({ width: 22, height: 500 }, { width: 0, height: 0 })).toBe(false);
    expect(readyToFit({ width: 0, height: 716 }, { width: 1024, height: 768 })).toBe(false);
    expect(readyToFit(size, { width: 1024, height: 0 })).toBe(false);
  });
});

describe('the first fit of a board', () => {
  it('fits the board when it opens', async () => {
    const { session, transform } = await mount();
    await waitFor(() => expect(transform()).not.toBe(UNFITTED));
    session.destroy();
  });

  it('waits for a window that opens with no size, then fits as it would have', async () => {
    const fitted = await mount();
    await waitFor(() => expect(fitted.transform()).not.toBe(UNFITTED));
    const expected = fitted.transform();
    fitted.session.destroy();

    setWindowSize(0, 0);
    const { session, transform } = await mount();
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(transform()).toBe(UNFITTED);

    setWindowSize(WINDOW.width, WINDOW.height);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    await waitFor(() => expect(transform()).toBe(expected));
    session.destroy();
  });
});
