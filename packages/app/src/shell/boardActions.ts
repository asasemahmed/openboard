/** Board-wide actions from the board menu: export, copy as text. */
import { calmMessage } from '../lib/api.js';
import { saveBlob } from '../lib/download.js';
import type { ExportChoice } from '../lib/exportChoices.js';
import type { BoardSession } from '../state/session.js';
import { toasts } from '../state/toasts.js';

/** Download an export as the server renders it, so it holds the board as the server has it. */
export async function exportBoard(session: BoardSession, choice: ExportChoice): Promise<void> {
  try {
    const file = await session.api.exportBoard(session.boardId, {
      format: choice.format,
      ...(choice.theme ? { theme: choice.theme } : {}),
    });
    saveBlob(file.blob, file.filename);
  } catch (error) {
    toasts.show(`Export failed: ${calmMessage(error)}`, { tone: 'error' });
  }
}

/** Copy the board as Mermaid or Markdown, rendered here at once. */
export async function copyBoardAs(
  session: BoardSession,
  format: 'mermaid' | 'markdown',
): Promise<void> {
  try {
    const { boardAsText } = await import('../lib/interopCopy.js');
    await navigator.clipboard.writeText(boardAsText(session.doc.toJSON(), format));
    toasts.show(
      format === 'mermaid' ? 'Copied the board as Mermaid.' : 'Copied the board as Markdown.',
    );
  } catch {
    toasts.show('Copying is blocked in this browser. Export the file instead.', { tone: 'error' });
  }
}
