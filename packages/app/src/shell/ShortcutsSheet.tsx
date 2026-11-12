import { SHORTCUTS, type ShortcutDef } from '../canvas/useShortcuts.js';
import { IS_MAC } from '../lib/shortcuts.js';
import { useSession } from '../state/context.js';
import { useValue } from '../state/emitter.js';
import { Kbd } from '../ui/Button.js';
import { Dialog } from '../ui/Dialog.js';

const GROUPS: ShortcutDef['group'][] = ['Create', 'Edit', 'Select', 'View'];

export function ShortcutsSheet() {
  const { ui } = useSession();
  const open = useValue(ui.shortcuts);
  return (
    <Dialog
      open={open}
      onClose={() => ui.shortcuts.set(false)}
      title="Keyboard shortcuts"
      size="md"
      description="They work whenever you are not typing in a field."
    >
      <div className="shortcuts-grid">
        {GROUPS.map((group) => (
          <section key={group}>
            <h3>{group}</h3>
            <dl>
              {SHORTCUTS.filter((s) => s.group === group).map((s) => (
                <div key={s.label} className="shortcut-row">
                  <dt>{s.label}</dt>
                  <dd>
                    {s.keys.map((key) => (
                      <Kbd key={key} shortcut={key} />
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
        <section>
          <h3>Canvas</h3>
          <dl>
            <div className="shortcut-row">
              <dt>Add a note</dt>
              <dd className="muted">Double-click</dd>
            </div>
            <div className="shortcut-row">
              <dt>Select an area</dt>
              <dd className="muted">Drag on empty canvas</dd>
            </div>
            <div className="shortcut-row">
              <dt>Pan</dt>
              <dd className="muted">Scroll, or hold Space and drag</dd>
            </div>
            <div className="shortcut-row">
              <dt>Zoom</dt>
              <dd className="muted">Pinch, or scroll with {IS_MAC ? '⌘' : 'Ctrl'} held</dd>
            </div>
          </dl>
        </section>
      </div>
    </Dialog>
  );
}
