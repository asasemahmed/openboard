const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
/** Largest multiple of the alphabet size below 256; bytes above it are rejected to avoid bias. */
const UNBIASED_LIMIT = 256 - (256 % ALPHABET.length);

/** A short, URL-safe, lowercase id such as `n_k3x9a0bq2m`. */
export function newId(prefix: 'n' | 'e' | 'b' | 'a' | 'p' | 'c' | string): string {
  let out = '';
  while (out.length < 10) {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    for (const byte of bytes) {
      if (byte >= UNBIASED_LIMIT) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === 10) break;
    }
  }
  return `${prefix}_${out}`;
}

/** Turn a human name into an id-safe slug: "My Board!" -> "my-board". */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    // Drop combining marks so "é" becomes "e" instead of splitting the word.
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'board';
}
