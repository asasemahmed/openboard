import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** A short, URL-safe, lowercase id such as `n_k3x9a0bq2m`. */
export function newId(prefix: 'n' | 'e' | 'b' | 'a' | 'p' | 'c' | string): string {
  const bytes = randomBytes(10);
  let out = '';
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return `${prefix}_${out}`;
}

/** Turn a human name into an id-safe slug: "My Board!" -> "my-board". */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'board';
}
