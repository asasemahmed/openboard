/**
 * One card anatomy for every non-frame type (see assets/banner-*.svg):
 *   type label row   coloured dot + mono uppercase type
 *   title            one or two lines, as `defaultNodeSize` budgets
 *   body preview     two lines of plain text from the markdown
 *   meta row         status, tags, link count
 * The card never grows past its size; content is clamped to fit, because the
 * server-side layout assumes exactly these sizes.
 */
import { Handle, type NodeProps, Position } from '@xyflow/react';
import { memo, useMemo } from 'react';
import type { FlowNode } from '../lib/flow.js';
import { typeMeta } from '../lib/nodeTypes.js';
import { markdownToPlainText } from '../lib/plainText.js';
import { useSession } from '../state/context.js';
import { Icon } from '../ui/Icon.js';
import { NodeDecorations } from './NodeDecorations.js';
import { StatusPill } from './StatusPill.js';
import { TitleEditor, useIsEditing } from './TitleEditor.js';

const MAX_TAGS = 2;
const HANDLES = [Position.Top, Position.Right, Position.Bottom, Position.Left] as const;

/** Must agree with `defaultNodeSize` in core. */
export function titleLines(title: string): 1 | 2 {
  return title.length > 28 ? 2 : 1;
}

function CardNodeView({ id, data, selected }: NodeProps<FlowNode>) {
  const { node, ghost } = data;
  const { ui } = useSession();
  const meta = typeMeta(node.type);
  const lines = titleLines(node.title);
  const body = useMemo(() => (node.body ? markdownToPlainText(node.body) : ''), [node.body]);
  const editing = useIsEditing(id);
  const tags = node.tags ?? [];
  const links = node.links ?? [];
  const staleLinks = links.filter((l) => l.stale).length;
  const hasMeta = node.status !== undefined || tags.length > 0 || links.length > 0;
  const custom = meta.tone === 'custom';

  return (
    <article
      className={`card tone-${meta.tone}${selected ? ' is-selected' : ''}${ghost ? ' is-ghost' : ''}`}
      aria-label={`${meta.name}: ${node.title}`}
    >
      {!ghost &&
        HANDLES.map((position) => (
          <Handle
            key={position}
            id={position}
            type="source"
            position={position}
            className="card-handle"
          />
        ))}
      <div className="card-inner">
        <header className="card-head">
          <span className="type-dot" aria-hidden="true" />
          <span className={`type-label${custom ? ' type-label-custom' : ''}`}>{meta.label}</span>
          <span className="card-head-end">
            <NodeDecorations slot="header" node={node} ghost={ghost} />
          </span>
        </header>
        {editing ? (
          <TitleEditor
            id={id}
            title={node.title}
            lines={lines}
            className={`card-title lines-${lines}`}
          />
        ) : (
          <h3
            className={`card-title lines-${lines}`}
            onDoubleClick={(event) => {
              if (ghost) return;
              event.stopPropagation();
              ui.editing.set(id);
            }}
          >
            {node.title}
          </h3>
        )}
        {body && <p className="card-body">{body}</p>}
        {hasMeta && (
          <div className="card-meta">
            {node.status && <StatusPill status={node.status} />}
            {tags.slice(0, MAX_TAGS).map((tag) => (
              <span key={tag} className="tag">
                {tag}
              </span>
            ))}
            {tags.length > MAX_TAGS && (
              <span className="tag tag-more" title={tags.slice(MAX_TAGS).join(', ')}>
                +{tags.length - MAX_TAGS}
              </span>
            )}
            {links.length > 0 && (
              <span
                className={`link-count${staleLinks ? ' is-stale' : ''}`}
                title={
                  staleLinks
                    ? `${links.length} links, ${staleLinks} changed since linked`
                    : `${links.length} link${links.length === 1 ? '' : 's'}`
                }
              >
                <Icon name={staleLinks ? 'warning' : 'link'} size={12} />
                {links.length}
              </span>
            )}
          </div>
        )}
      </div>
      <NodeDecorations slot="overlay" node={node} ghost={ghost} />
    </article>
  );
}

export const CardNode = memo(
  CardNodeView,
  (a, b) =>
    a.data === b.data &&
    a.selected === b.selected &&
    a.width === b.width &&
    a.height === b.height &&
    a.dragging === b.dragging,
);
