/** The right-hand inspector: whatever is selected, or the board itself. */
import { LIMITS } from '@openboard/core';
import { useBoardEdge, useBoardNode, useMeta, useSelection, useSession } from '../state/context.js';
import { useStoreValue } from '../state/emitter.js';
import { toasts } from '../state/toasts.js';
import { Kbd } from '../ui/Button.js';
import { EdgeInspector } from './EdgeInspector.js';
import { Field, Section } from './fields.js';
import { MultiInspector } from './MultiInspector.js';
import { NodeInspector } from './NodeInspector.js';
import { useDraft } from './useDraft.js';

function BoardInfo() {
  const session = useSession();
  const { meta } = useMeta();
  const counts = useStoreValue(
    session.store,
    () => `${session.store.nodes.length},${session.store.edges.length}`,
  );
  const [nodes, edges] = counts.split(',');
  const description = useDraft(meta.description ?? '', (next) => {
    try {
      session.doc.setMeta({ description: next.trim() || null }, session.actor(), { source: 'ui' });
    } catch (error) {
      toasts.show(error instanceof Error ? error.message : 'Could not save the description.', {
        tone: 'error',
      });
    }
  });
  return (
    <div className="inspector-board">
      <Section>
        <p className="inspector-kicker">Board</p>
        <h2 className="inspector-board-name">{meta.name}</h2>
        <p className="muted">
          {nodes} node{nodes === '1' ? '' : 's'}, {edges} connection{edges === '1' ? '' : 's'}
        </p>
        <Field label="Description" hint="Agents read this first, so say what the board is for.">
          {(id) => (
            <textarea
              id={id}
              className="input"
              rows={4}
              maxLength={2000}
              value={description.draft}
              placeholder="What is this board for?"
              onChange={(event) => description.change(event.target.value.slice(0, LIMITS.body))}
              onBlur={() => description.save()}
            />
          )}
        </Field>
      </Section>
      <Section title="Nothing selected">
        <p className="muted">
          Click a card to see its details here. Press <Kbd shortcut="mod+k" /> to find anything, or{' '}
          <Kbd shortcut="?" /> for shortcuts.
        </p>
      </Section>
    </div>
  );
}

export function Inspector() {
  const selection = useSelection();
  const singleNode =
    selection.nodeIds.length === 1 && selection.edgeIds.length === 0
      ? selection.nodeIds[0]
      : undefined;
  const singleEdge =
    selection.nodeIds.length === 0 && selection.edgeIds.length === 1
      ? selection.edgeIds[0]
      : undefined;
  const node = useBoardNode(singleNode);
  const edge = useBoardEdge(singleEdge);

  if (node) return <NodeInspector key={node.id} node={node} />;
  if (edge) return <EdgeInspector key={edge.id} edge={edge} />;
  if (selection.nodeIds.length + selection.edgeIds.length > 1)
    return <MultiInspector selection={selection} />;
  return <BoardInfo />;
}
