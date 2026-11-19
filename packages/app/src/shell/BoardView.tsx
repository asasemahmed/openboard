/**
 * An open board: top bar, optional left panel, canvas, inspector, and the
 * board's dialogs. Takes a ready session, so it can be rendered with an
 * in-memory board in tests.
 */
import { ReactFlowProvider } from '@xyflow/react';
import { useEffect, useRef } from 'react';
import { ActionsProvider, useBoardActions } from '../canvas/actions.js';
import { Canvas } from '../canvas/Canvas.js';
import { useBoardCommentNotices, useReviewAutoOpen } from '../canvas/TrustHooks.js';
import { useShortcuts } from '../canvas/useShortcuts.js';
import { isTypingTarget } from '../lib/shortcuts.js';
import { LeftPanel, RightPanel } from '../panels/PanelSlot.js';
import { canNow } from '../state/access.js';
import { SessionProvider, useMeta, useSession } from '../state/context.js';
import { useStoreValue } from '../state/emitter.js';
import { currentActor, identity } from '../state/identity.js';
import type { BoardSession } from '../state/session.js';
import { CompareView } from './CompareView.js';
import { ConfirmHost } from './ConfirmHost.js';
import { LazyDialogs } from './LazyDialogs.js';
import { ReplayView } from './ReplayView.js';
import { TopBar } from './TopBar.js';

function Workspace({
  onlyRenderVisibleElements,
  initialCardId,
}: {
  onlyRenderVisibleElements: boolean;
  initialCardId?: string;
}) {
  const session = useSession();
  const actions = useBoardActions();
  const { meta } = useMeta();
  useShortcuts(actions);
  useReviewAutoOpen();
  useBoardCommentNotices();

  const lastCardId = useRef(initialCardId);
  useEffect(() => {
    if (initialCardId === lastCardId.current) return;
    lastCardId.current = initialCardId;
    if (initialCardId && session.store.node(initialCardId)) {
      actions.jumpTo(initialCardId);
    }
  }, [actions, initialCardId, session.store]);

  useEffect(() => {
    document.title = `${meta.name} · OpenBoard`;
    return () => {
      document.title = 'OpenBoard';
    };
  }, [meta.name]);

  // Keep the published name and colour in step with the profile.
  useEffect(
    () =>
      identity.subscribe(() => {
        session.setActor(currentActor());
      }),
    [session],
  );

  // Paste plain text lines onto the canvas to create one card per line.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (event.defaultPrevented || session.replay.active || session.ui.compare.get() !== null)
        return;
      if (isTypingTarget(event.target) || session.ui.modalOpen()) return;
      if (!canNow('board.edit')) return;
      const text = event.clipboardData?.getData('text/plain');
      if (!text) return;
      event.preventDefault();
      actions.pasteLines(text);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [actions, session]);

  const replaying = useStoreValue(session.replay, () => session.replay.active);
  const comparing = useStoreValue(session.ui.compare, () => session.ui.compare.get() !== null);
  const away = replaying || comparing;

  return (
    <ActionsProvider value={actions}>
      {replaying && <ReplayView />}
      {comparing && !replaying && <CompareView />}
      <div className="workspace" inert={away || undefined}>
        <TopBar />
        <div className="workspace-body">
          <LeftPanel />
          <main className="canvas-area" aria-label="Board canvas">
            <Canvas
              actions={actions}
              onlyRenderVisibleElements={onlyRenderVisibleElements}
              {...(initialCardId ? { initialCardId } : {})}
            />
          </main>
          <RightPanel />
        </div>
      </div>
      <LazyDialogs />
      <ConfirmHost />
    </ActionsProvider>
  );
}

export function BoardView({
  session,
  onlyRenderVisibleElements = true,
  initialCardId,
}: {
  session: BoardSession;
  onlyRenderVisibleElements?: boolean;
  initialCardId?: string;
}) {
  return (
    <SessionProvider session={session}>
      <ReactFlowProvider>
        <Workspace
          onlyRenderVisibleElements={onlyRenderVisibleElements}
          {...(initialCardId ? { initialCardId } : {})}
        />
      </ReactFlowProvider>
    </SessionProvider>
  );
}
