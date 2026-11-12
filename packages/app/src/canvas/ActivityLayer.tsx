/**
 * What others are doing, drawn over the canvas: a pill per actor at the edge
 * of the view when their recent changes are out of sight, a small stack of
 * removal notices, follow mode, and a polite announcement for screen readers.
 */
import { useReactFlow, useStore } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { absoluteRect, boundsOf, type Rect } from '../lib/geometry.js';
import {
  type Located,
  type OffscreenGroup,
  offscreenGroups,
  type ViewSide,
} from '../lib/offscreen.js';
import {
  actorName,
  byActor,
  changeCountLabel,
  type Highlight,
  removalMessage,
} from '../state/activity.js';
import { useSession } from '../state/context.js';
import { useStoreValue } from '../state/emitter.js';
import type { BoardSession } from '../state/session.js';
import { IconButton } from '../ui/Button.js';
import { Icon, type IconName } from '../ui/Icon.js';
import { reducedMotion } from './actions.js';

const ARROWS: Record<ViewSide, IconName> = {
  top: 'arrowUp',
  bottom: 'arrowDown',
  left: 'arrowLeft',
  right: 'arrowRight',
};
const SIDES: ViewSide[] = ['top', 'right', 'bottom', 'left'];

/** Where a highlighted entry is on the canvas, and which nodes show it. */
export function locate(session: BoardSession, highlight: Highlight): Located | undefined {
  const map = session.store.placements();
  if (highlight.kind === 'node') {
    const rect = absoluteRect(highlight.id, map);
    return rect ? { rect, nodeIds: [highlight.id] } : undefined;
  }
  const edge = session.store.edge(highlight.id);
  if (!edge) return undefined;
  const rects = [absoluteRect(edge.source, map), absoluteRect(edge.target, map)].filter(
    (r): r is Rect => r !== undefined,
  );
  const rect = boundsOf(rects);
  return rect ? { rect, nodeIds: [edge.source, edge.target] } : undefined;
}

function useFitTo() {
  const flow = useReactFlow();
  return useCallback(
    (nodeIds: readonly string[]) => {
      if (nodeIds.length === 0) return;
      void flow.fitView({
        nodes: nodeIds.map((id) => ({ id })),
        duration: reducedMotion() ? 0 : 320,
        padding: 0.25,
        maxZoom: 1,
      });
    },
    [flow],
  );
}

function OffscreenPills() {
  const session = useSession();
  const { activity, store } = session;
  const state = useStoreValue(activity, activity.get);
  const transform = useStore((s) => s.transform);
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  // Positions change as nodes move; re-read them whenever the board does.
  const placements = useStoreValue(store, () => store.placements());
  const actors = useStoreValue(store, () => store.meta.actors);
  const fitTo = useFitTo();

  const groups = useMemo(() => {
    if (state.highlights.size === 0 || width === 0 || height === 0) return [];
    const [tx, ty, zoom] = transform;
    const view = { x: -tx / zoom, y: -ty / zoom, w: width / zoom, h: height / zoom };
    void placements;
    return offscreenGroups(state.highlights.values(), (h) => locate(session, h), view);
  }, [state.highlights, transform, width, height, placements, session]);

  if (groups.length === 0) return null;
  const bySide = new Map<ViewSide, OffscreenGroup[]>();
  for (const group of groups) bySide.set(group.side, [...(bySide.get(group.side) ?? []), group]);

  return (
    <>
      {SIDES.filter((side) => bySide.has(side)).map((side) => (
        <div key={side} className={`offscreen-stack offscreen-${side}`}>
          {(bySide.get(side) ?? []).map((group) => {
            const label = changeCountLabel(group.count, actorName(actors, group.actorId));
            return (
              <button
                key={group.actorId}
                type="button"
                className="offscreen-pill"
                title={`Show ${label.replace(/^(\d+) /, '$1 recent ')}`}
                onClick={() => fitTo(group.nodeIds)}
              >
                <Icon name={ARROWS[side]} size={14} />
                {label}
              </button>
            );
          })}
        </div>
      ))}
    </>
  );
}

function RemovalNotices() {
  const { activity, store } = useSession();
  const removals = useStoreValue(activity, () => activity.get().removals);
  const actors = useStoreValue(store, () => store.meta.actors);
  if (removals.length === 0) return null;
  return (
    <div className="removal-stack" role="status" aria-live="polite">
      {removals.map((notice) => (
        <div key={notice.id} className="removal-notice">
          <Icon name="trash" size={14} />
          <span className="removal-notice-text">
            {removalMessage(notice, actorName(actors, notice.actorId))}
          </span>
          <IconButton
            icon="close"
            label="Dismiss"
            size="sm"
            onClick={() => activity.dismissRemoval(notice.id)}
          />
        </div>
      ))}
    </div>
  );
}

/** One sentence per burst, for screen readers. */
function useAnnouncement(): string {
  const session = useSession();
  const [text, setText] = useState('');
  useEffect(
    () =>
      session.activity.onBurst((keys) => {
        const highlights = keys
          .map((key) => session.activity.get().highlights.get(key))
          .filter((h): h is Highlight => h !== undefined);
        const parts = [...byActor(highlights)].map(([actorId, list]) => {
          const name = actorName(session.store.meta.actors, actorId) ?? 'Someone';
          const added = list.filter((h) => h.verb === 'added').length;
          const updated = list.length - added;
          const what = [
            added ? `added ${added === 1 ? '1 item' : `${added} items`}` : '',
            updated ? `changed ${updated === 1 ? '1 item' : `${updated} items`}` : '',
          ]
            .filter(Boolean)
            .join(' and ');
          return `${name} ${what}.`;
        });
        setText(parts.join(' '));
      }),
    [session],
  );
  return text;
}

/** Follow mode: fit the view to each burst of changes while it is on. */
function useFollow() {
  const session = useSession();
  const fitTo = useFitTo();
  useEffect(
    () =>
      session.activity.onBurst((keys) => {
        if (session.ui.follow.get() !== 'on') return;
        const ids = new Set<string>();
        for (const key of keys) {
          const highlight = session.activity.get().highlights.get(key);
          const where = highlight ? locate(session, highlight) : undefined;
          for (const id of where?.nodeIds ?? []) ids.add(id);
        }
        fitTo([...ids]);
      }),
    [session, fitTo],
  );
}

export function ActivityLayer() {
  useFollow();
  const announcement = useAnnouncement();
  return (
    <>
      <OffscreenPills />
      <RemovalNotices />
      <div className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </div>
    </>
  );
}
