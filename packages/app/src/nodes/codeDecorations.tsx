/**
 * Decorations for code and git: a "Code changed" marker on cards whose linked
 * code moved on, and, in a compare view, what changed since the revision
 * (added, updated with its fields, moved).
 */

import { codeMarker } from '../lib/codeLinks.js';
import type { DiffMark } from '../lib/diffView.js';
import { useSession } from '../state/context.js';
import { useStoreValue } from '../state/emitter.js';
import { Icon } from '../ui/Icon.js';
import { type DecorationProps, registerNodeDecoration } from './decorations.js';

function CodeChanged({ node }: DecorationProps) {
  const { ui } = useSession();
  const marker = codeMarker(node);
  if (!marker || ui.readOnly) return null;
  return (
    <span className="code-marker" role="img" aria-label={marker.title} title={marker.title}>
      <Icon name="warning" size={11} />
      <span>{marker.label}</span>
    </span>
  );
}

function useDiffMark(nodeId: string): DiffMark | undefined {
  const { ui } = useSession();
  return useStoreValue(ui.diff, () => ui.diff.get()?.marks.get(nodeId));
}

const BADGE: Record<DiffMark['kind'], string> = { added: '+', updated: '~', moved: '↔' };
const WORD: Record<DiffMark['kind'], string> = {
  added: 'Added',
  updated: 'Changed',
  moved: 'Moved',
};

/** The changed field names in the label row, with old → new in the tooltip. */
function DiffFields({ node }: DecorationProps) {
  const mark = useDiffMark(node.id);
  if (!mark) return null;
  const lines = mark.changes.map((c) => `${c.name}: ${c.before} → ${c.after}`);
  if (mark.moved && mark.kind !== 'moved') lines.push('Also moved');
  const tooltip = `${WORD[mark.kind]} since the revision${lines.length ? `\n${lines.join('\n')}` : ''}`;
  return (
    <span className={`diff-chip diff-${mark.kind}`} role="img" aria-label={tooltip} title={tooltip}>
      <span className="diff-badge" aria-hidden="true">
        {BADGE[mark.kind]}
      </span>
      <span className="diff-chip-text">
        {mark.kind === 'updated' ? mark.fields.join(', ') : WORD[mark.kind]}
      </span>
    </span>
  );
}

function DiffOutline({ node }: DecorationProps) {
  const mark = useDiffMark(node.id);
  if (!mark) return null;
  return <div className={`diff-outline diff-${mark.kind}`} aria-hidden="true" />;
}

/** A removed node, drawn where it was: red, dashed, struck through. */
function DiffRemoved({ node }: DecorationProps) {
  const { ui } = useSession();
  const removed = useStoreValue(ui.diff, () => ui.diff.get()?.removed.has(node.id) ?? false);
  if (!removed) return null;
  return (
    <span className="diff-chip diff-removed" role="img" aria-label="Removed since the revision">
      <span className="diff-badge" aria-hidden="true">
        −
      </span>
      <span className="diff-chip-text">Removed</span>
    </span>
  );
}

let registered = false;

export function registerCodeDecorations(): void {
  if (registered) return;
  registered = true;
  registerNodeDecoration({
    id: 'code-changed',
    slot: 'header',
    order: 15,
    applies: (node, ghost) => !ghost && (node.links?.some((l) => l.stale) ?? false),
    Component: CodeChanged,
  });
  registerNodeDecoration({
    id: 'diff-fields',
    slot: 'header',
    order: 1,
    applies: (_node, ghost) => !ghost,
    Component: DiffFields,
  });
  registerNodeDecoration({
    id: 'diff-removed',
    slot: 'header',
    order: 1,
    applies: (_node, ghost) => ghost,
    Component: DiffRemoved,
  });
  registerNodeDecoration({
    id: 'diff-outline',
    slot: 'overlay',
    order: 0,
    applies: (_node, ghost) => !ghost,
    Component: DiffOutline,
  });
}
