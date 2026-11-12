/**
 * Dialogs that are not needed to show a board load on first use: the
 * command palette, the shortcuts sheet and "Connect an agent". Each stays
 * mounted once it has been opened.
 */
import { lazy, type ReactNode, Suspense, useState } from 'react';
import { useSession } from '../state/context.js';
import { type Emitter, useStoreValue } from '../state/emitter.js';
// The home screen needs this one anyway, so it is not split out.
import { NewBoardDialog } from './NewBoardDialog.js';

const CommandPalette = lazy(() =>
  import('./CommandPalette.js').then((m) => ({ default: m.CommandPalette })),
);
const ShortcutsSheet = lazy(() =>
  import('./ShortcutsSheet.js').then((m) => ({ default: m.ShortcutsSheet })),
);
const SettingsDialog = lazy(() =>
  import('./SettingsDialog.js').then((m) => ({ default: m.SettingsDialog })),
);
const ImportDialog = lazy(() =>
  import('./ImportDialog.js').then((m) => ({ default: m.ImportDialog })),
);
const TemplateDialog = lazy(() =>
  import('./TemplateDialog.js').then((m) => ({ default: m.TemplateDialog })),
);
const ComparePicker = lazy(() =>
  import('./ComparePicker.js').then((m) => ({ default: m.ComparePicker })),
);
const ConnectAgentDialog = lazy(() =>
  import('./ConnectAgentDialog.js').then((m) => ({ default: m.ConnectAgentDialog })),
);

/** Render `children` from the first time `isOpen` is true. */
function OnceOpened({
  store,
  isOpen,
  children,
}: {
  store: Emitter;
  isOpen: () => boolean;
  children: ReactNode;
}) {
  const open = useStoreValue(store, isOpen);
  const [seen, setSeen] = useState(open);
  if (open && !seen) setSeen(true);
  if (!seen && !open) return null;
  return <Suspense fallback={null}>{children}</Suspense>;
}

function NewBoard() {
  const { ui } = useSession();
  const open = useStoreValue(ui.newBoard, ui.newBoard.get);
  return <NewBoardDialog open={open} onClose={() => ui.newBoard.set(false)} />;
}

export function LazyDialogs() {
  const { ui } = useSession();
  return (
    <>
      <OnceOpened store={ui.palette} isOpen={() => ui.palette.get().open}>
        <CommandPalette />
      </OnceOpened>
      <OnceOpened store={ui.shortcuts} isOpen={ui.shortcuts.get}>
        <ShortcutsSheet />
      </OnceOpened>
      <OnceOpened store={ui.connectAgent} isOpen={ui.connectAgent.get}>
        <ConnectAgentDialog />
      </OnceOpened>
      <OnceOpened store={ui.settings} isOpen={ui.settings.get}>
        <SettingsDialog />
      </OnceOpened>
      <OnceOpened store={ui.importDialog} isOpen={() => ui.importDialog.get() !== null}>
        <ImportDialog />
      </OnceOpened>
      <OnceOpened store={ui.templateDialog} isOpen={() => ui.templateDialog.get() !== null}>
        <TemplateDialog />
      </OnceOpened>
      <OnceOpened store={ui.comparePicker} isOpen={ui.comparePicker.get}>
        <ComparePicker />
      </OnceOpened>
      <OnceOpened store={ui.newBoard} isOpen={ui.newBoard.get}>
        <NewBoard />
      </OnceOpened>
    </>
  );
}
