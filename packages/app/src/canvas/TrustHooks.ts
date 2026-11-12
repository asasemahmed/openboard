/** Session-wide reactions to agents' work that are not tied to one component. */
import { useEffect } from 'react';
import { actorName, MAX_AGE_MS } from '../state/activity.js';
import { useSession } from '../state/context.js';
import { COMMENTS_PANEL, REVIEW_PANEL } from '../state/review.js';
import { toasts } from '../state/toasts.js';

/**
 * The first time this session sees a pending proposal, show the review
 * panel. It never takes focus, and it leaves the panel alone while the person
 * is working in it.
 */
export function useReviewAutoOpen(): void {
  const session = useSession();
  useEffect(() => {
    const { store, ui } = session;
    let done = false;
    const check = () => {
      if (done || store.review().pending.length === 0) return;
      done = true;
      const active = document.activeElement;
      if (active?.closest('.panel-right') && ui.inspectorOpen.get()) return;
      ui.rightPanel.set(REVIEW_PANEL);
      ui.inspectorOpen.set(true);
    };
    check();
    return done ? undefined : store.subscribe(check);
  }, [session]);
}

/** A new board-level comment by someone else has no card to highlight, so it gets a short notice. */
export function useBoardCommentNotices(): void {
  const session = useSession();
  useEffect(
    () =>
      session.doc.observe((event) => {
        if (!event.comments || !session.connection.get().synced) return;
        const me = session.actor().id;
        for (const id of event.comments) {
          const state = event.states?.comments[id];
          const comment = state?.after;
          if (!state || state.before !== null || !comment || comment.nodeId !== undefined) continue;
          if (comment.author === me) continue;
          if (Date.now() - Date.parse(comment.createdAt) > MAX_AGE_MS) continue;
          const name = actorName(session.store.meta.actors, comment.author) ?? 'Someone';
          toasts.show(`${name} commented on the board.`, {
            action: { label: 'Show', run: () => session.ui.showRightPanel(COMMENTS_PANEL) },
            ms: 6000,
          });
        }
      }),
    [session],
  );
}
