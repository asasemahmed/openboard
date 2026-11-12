/**
 * The people-in-control features, registered into the app's extension
 * points: the review, comments and activity panels, and the decorations on
 * cards. Call once at startup, before the board mounts.
 */
import { registerBuiltinDecorations } from './nodes/builtinDecorations.js';
import { registerTrustDecorations } from './nodes/trustDecorations.js';
import { ActivityPanel } from './panels/ActivityPanel.js';
import { CommentsPanel } from './panels/CommentsPanel.js';
import { ReviewPanel } from './panels/ReviewPanel.js';
import { registerPanel } from './panels/registry.js';
import { ACTIVITY_PANEL, COMMENTS_PANEL, REVIEW_PANEL } from './state/review.js';

let registered = false;

export function registerTrust(): void {
  registerBuiltinDecorations();
  registerTrustDecorations();
  if (registered) return;
  registered = true;
  registerPanel({
    id: REVIEW_PANEL,
    side: 'right',
    title: 'Review',
    icon: 'review',
    order: 10,
    badge: (session) => session.store.review().pending.length,
    Component: ReviewPanel,
  });
  registerPanel({
    id: COMMENTS_PANEL,
    side: 'right',
    title: 'Comments',
    icon: 'comment',
    order: 20,
    badge: (session) => session.store.comments().open,
    Component: CommentsPanel,
  });
  registerPanel({
    id: ACTIVITY_PANEL,
    side: 'left',
    title: 'Activity',
    icon: 'history',
    order: 10,
    Component: ActivityPanel,
  });
}
