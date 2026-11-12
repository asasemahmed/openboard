/** Markdown to plain text, without the markdown renderer (cards use it for previews). */

/**
 * Plain text of a markdown string for card previews. Cheap and forgiving: it
 * strips syntax rather than parsing, which is enough for a two-line preview.
 */
export function markdownToPlainText(source: string): string {
  return (
    source
      // fenced code: keep the code, drop the fences
      .replace(/^\s*(```|~~~)[^\n]*$/gm, '')
      // images and links: keep the text
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
      // html tags
      .replace(/<\/?[A-Za-z][^>]*>/g, '')
      // headings, quotes, list markers, task boxes, rules
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s{0,3}>\s?/gm, '')
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, '')
      .replace(/^\s*(?:[-*_]\s*){3,}$/gm, '')
      // emphasis, strike, inline code
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/(\*|_)(\S(?:.*?\S)?)\1/g, '$2')
      .replace(/~~(.+?)~~/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
  );
}
