/**
 * One card anatomy for every non-frame type:
 *   type row         the type's glyph and name, in the type's colour
 *   title            one or two lines, as `defaultNodeSize` budgets
 *   body preview     two lines of plain text from the markdown
 *   meta row         status, tags, link count
 * The whole card is filled with a soft tint of its type's colour, so a board
 * reads by colour before anyone reads a word.
 * The card never grows past its size; content is clamped to fit, because the
 * server-side layout assumes exactly these sizes.
 */
import { Handle, type NodeProps, Position } from '@xyflow/react';
import { memo, useMemo } from 'react';
import { useNodeFocus } from '../canvas/nodeFocus.js';
import { CARD_FIELDS, cardModel } from '../lib/declaredTypes.js';
import { typeProblems } from '../lib/fieldForm.js';
import type { FlowNode } from '../lib/flow.js';
import { typeMeta } from '../lib/nodeTypes.js';
import { markdownToPlainText } from '../lib/plainText.js';
import { useSession } from '../state/context.js';
import { useNodeTypeDef } from '../state/schema.js';
import { Icon } from '../ui/Icon.js';
import { BuiltinTypeIcon, hasBuiltinTypeIcon, TypeIcon } from '../ui/TypeIcon.js';
import { NodeDecorations } from './NodeDecorations.js';
import { useDiffClass, useReviewClass } from './reviewClass.js';
import { StatusPill } from './StatusPill.js';
import { TitleEditor, useIsEditing } from './TitleEditor.js';

const MAX_TAGS = 2;
const HANDLES = [Position.Top, Position.Right, Position.Bottom, Position.Left] as const;

/** Must agree with `defaultNodeSize` in core. */
export function titleLines(title: string): 1 | 2 {
  return title.length > 28 ? 2 : 1;
}

/**
 * Whether a card of `height` has the two-line body area, as `defaultNodeSize`
 * budgets it: label row 40, title 24 per line, meta row 32, body 48.
 */
export function hasBodyRoom(height: number | undefined, lines: 1 | 2, hasMeta: boolean): boolean {
  if (height === undefined) return false;
  return height - (40 + lines * 24 + (hasMeta ? 32 : 0)) >= 48;
}

function CardNodeView({ id, data, selected, height }: NodeProps<FlowNode>) {
  const { node, ghost } = data;
  const { ui } = useSession();
  const meta = typeMeta(node.type);
  const def = useNodeTypeDef(node.type);
  // Built-in types read as their name ("Task"); an undeclared custom type keeps its raw id.
  const card = cardModel(node, def, {
    label: meta.tone === 'custom' ? meta.label : meta.name,
    tone: meta.tone,
  });
  const problems = useMemo(() => (def ? typeProblems(node, def) : []), [def, node]);
  const lines = titleLines(node.title);
  const body = useMemo(() => (node.body ? markdownToPlainText(node.body) : ''), [node.body]);
  const editing = useIsEditing(id);
  const tags = node.tags ?? [];
  const links = node.links ?? [];
  const staleLinks = links.filter((l) => l.stale).length;
  const hasMeta = node.status !== undefined || tags.length > 0 || links.length > 0;
  const custom = meta.tone === 'custom' && !card.declared;
  // Field values share the body area; a card laid out without one shows none.
  const fields =
    card.fields.length > 0 && (body || hasBodyRoom(height, lines, hasMeta)) ? card.fields : [];
  const name = card.declared ? card.label : meta.name;
  const focus = useNodeFocus(id, ghost);
  const review = useReviewClass(id, ghost) + useDiffClass(id, ghost);

  return (
    <article
      className={`card ${card.toneClass}${card.declared ? ' is-declared' : ''}${selected ? ' is-selected' : ''}${ghost ? ' is-ghost' : ''}${review}`}
      aria-label={
        ghost
          ? `Proposed ${name.toLowerCase()}: ${node.title}. Open the review`
          : `${name}: ${node.title}${problems.length > 0 ? '. Does not match its type' : ''}`
      }
      {...focus}
    >
      {/* Ghosts keep hidden anchors so proposed edges can attach to them; they cannot be connected. */}
      {HANDLES.map((position) => (
        <Handle
          key={position}
          id={position}
          type="source"
          position={position}
          isConnectable={!ghost}
          className={ghost ? 'frame-anchor' : 'card-handle'}
        />
      ))}
      <div className="card-inner">
        <header className="card-head">
          {card.icon ? (
            <span className="type-glyph" aria-hidden="true">
              <TypeIcon name={card.icon} size={14} />
            </span>
          ) : hasBuiltinTypeIcon(node.type) ? (
            <span className="type-glyph" aria-hidden="true">
              <BuiltinTypeIcon type={node.type} size={14} />
            </span>
          ) : (
            <span className="type-dot" aria-hidden="true" />
          )}
          <span className={`type-label${custom ? ' type-label-custom' : ''}`}>{card.label}</span>
          {problems.length > 0 && (
            <span
              className="type-mismatch"
              title={`Does not match its type: ${problems.join(' ')}`}
              aria-hidden="true"
            >
              <Icon name="warning" size={12} />
            </span>
          )}
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
        {fields.length > 0 ? (
          <div className="card-body card-fields">
            {fields.map((f) => (
              <p key={f.key} className="card-field">
                <span className="card-field-label">{f.label}:</span> {f.value}
              </p>
            ))}
            {body && fields.length < CARD_FIELDS && (
              <p className="card-field card-field-body">{body}</p>
            )}
          </div>
        ) : (
          body && <p className="card-body">{body}</p>
        )}
        {hasMeta && (
          <div className="card-meta">
            {node.status && card.hasStatus && <StatusPill status={node.status} />}
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
