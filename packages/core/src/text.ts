/**
 * A deliberately simple token estimate (about four characters per token). It is
 * only used to keep reads within a budget, so being roughly right is enough and
 * being the same everywhere matters more.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
