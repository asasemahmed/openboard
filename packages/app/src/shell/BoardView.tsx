/**
 * An open board: top bar, optional left panel, canvas, inspector, and the
 * board's dialogs. Takes a ready session, so it can be rendered with an
 * in-memory board in tests.
 */
import { ReactFlowProvider } from '@xyflow/react';
import { useEffect } from 'react';
import { ActionsProvider, useBoardActions } from '../canvas/actions.js';
import { Canvas } from '../canvas/Canvas.js';
import { useShortcuts } from '../canvas/useShortcuts.js';
import { toActor } from '../lib/identity.js';
import { LeftPanel, RightPanel } from '../panels/PanelSlot.js';
import { SessionProvider, useMeta, useSession } from '../state/context.js';
import { useValue } from '../state/emitter.js';
import { identity } from '../state/identity.js';
import type { BoardSession } from '../state/session.js';
import { CommandPalette } from './CommandPalette.js';
import { ConfirmHost } from './ConfirmHost.js';
import { NewBoardDialog } from './NewBoardDialog.js';
import { ShortcutsSheet } from './ShortcutsSheet.js';
import { TopBar } from './TopBar.js';

function Workspace({ onlyRenderVisibleElements }: { onlyRenderVisibleElements: boolean }) {
  const session = useSession();
  const actions = useBoardActions();
  const newBoard = useValue(session.ui.newBoard);
  const { meta } = useMeta();
  useShortcuts(actions);

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
        session.setActor(toActor(identity.get()));
      }),
    [session],
  );

  return (
    <ActionsProvider value={actions}>
      <div className="workspace">
        <TopBar />
        <div className="workspace-body">
          <LeftPanel />
          <main className="canvas-area" aria-label="Board canvas">
            <Canvas actions={actions} onlyRenderVisibleElements={onlyRenderVisibleElements} />
          </main>
          <RightPanel />
        </div>
      </div>
      <CommandPalette />
      <ShortcutsSheet />
      <ConfirmHost />
      <NewBoardDialog open={newBoard} onClose={() => session.ui.newBoard.set(false)} />
    </ActionsProvider>
  );
}

export function BoardView({
  session,
  onlyRenderVisibleElements = true,
}: {
  session: BoardSession;
  onlyRenderVisibleElements?: boolean;
}) {
  return (
    <SessionProvider session={session}>
      <ReactFlowProvider>
        <Workspace onlyRenderVisibleElements={onlyRenderVisibleElements} />
      </ReactFlowProvider>
    </SessionProvider>
  );
}
