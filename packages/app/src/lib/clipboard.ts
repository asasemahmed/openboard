import { toasts } from '../state/toasts.js';
import { cardUrl } from './router.js';

/** Copy text to the clipboard. Resolves to false when the browser refused. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the selection-based copy (insecure origins, older browsers).
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Copy a direct link to one card on a board and show a toast. */
export async function copyCardLink(boardId: string, cardId: string): Promise<boolean> {
  const ok = await copyText(cardUrl(boardId, cardId));
  toasts.show(ok ? 'Link copied' : 'Could not copy the link', ok ? undefined : { tone: 'error' });
  return ok;
}
