import { createHash } from 'node:crypto';

/**
 * Text normalisation and similarity primitives.
 *
 * Everything here is a pure function of its inputs: no I/O, no clock, no config.
 * That is what makes the anti-repetition layer cheap to test exhaustively
 * and safe to run inside a database transaction.
 */

/**
 * Small closed-class stopword list. Kept deliberately short — aggressive stopword
 * removal makes short titles collide with each other, which would cause false
 * duplicate reports.
 */
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'from',
  'has',
  'he',
  'her',
  'his',
  'in',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'she',
  'that',
  'the',
  'their',
  'they',
  'this',
  'to',
  'was',
  'were',
  'will',
  'with',
]);

/**
 * Lowercase, strip diacritics and punctuation, collapse whitespace.
 * Emoji and other symbols are dropped: they carry no signal for duplicate
 * detection but do let a generator dodge the check by decorating a repeat title.
 */
export function normalizeText(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(input: string, removeStopwords = true): string[] {
  const tokens = normalizeText(input).split(' ').filter(Boolean);
  return removeStopwords ? tokens.filter((t) => !STOPWORDS.has(t)) : tokens;
}

/** Word k-grams. Short inputs fall back to the whole token list. */
export function shingles(input: string, size = 3): Set<string> {
  const tokens = tokenize(input);
  if (tokens.length === 0) return new Set();
  if (tokens.length <= size) return new Set([tokens.join(' ')]);

  const result = new Set<string>();
  for (let i = 0; i <= tokens.length - size; i += 1) {
    result.add(tokens.slice(i, i + size).join(' '));
  }
  return result;
}

/** Character trigrams, padded so short strings still produce useful features. */
export function charTrigrams(input: string): Map<string, number> {
  const normalized = `  ${normalizeText(input)} `;
  const counts = new Map<string, number>();
  if (normalized.trim().length === 0) return counts;

  for (let i = 0; i <= normalized.length - 3; i += 1) {
    const gram = normalized.slice(i, i + 3);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

/** |A ∩ B| / |A ∪ B|. Two empty inputs are treated as identical. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;

  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const item of small) {
    if (large.has(item)) intersection += 1;
  }
  return intersection / (a.size + b.size - intersection);
}

/** Cosine similarity over character-trigram frequency vectors. */
export function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;

  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [gram, count] of small) {
    const other = large.get(gram);
    if (other !== undefined) dot += count * other;
  }
  if (dot === 0) return 0;

  const magnitude = (m: Map<string, number>) =>
    Math.sqrt([...m.values()].reduce((sum, v) => sum + v * v, 0));
  return dot / (magnitude(a) * magnitude(b));
}

/** Convenience wrappers matching how the similarity service uses them. */
export function textSimilarityShort(a: string, b: string): number {
  return cosineSimilarity(charTrigrams(a), charTrigrams(b));
}

export function textSimilarityLong(a: string, b: string): number {
  return jaccard(shingles(a), shingles(b));
}

/**
 * 64-bit SimHash over token trigrams.
 *
 * Near-duplicate documents produce hashes with a small Hamming distance, which
 * lets the database narrow thousands of candidates down to a handful before the
 * expensive pairwise comparison runs.
 */
export function simhash64(input: string): bigint {
  const features = shingles(input, 2);
  if (features.size === 0) return 0n;

  const weights = new Array<number>(64).fill(0);
  for (const feature of features) {
    const digest = createHash('sha256').update(feature).digest();
    // Use the first 8 bytes as the feature's 64-bit hash.
    for (let bit = 0; bit < 64; bit += 1) {
      const byte = digest[bit >> 3] as number;
      const isSet = (byte >> (7 - (bit % 8))) & 1;
      weights[bit] = (weights[bit] as number) + (isSet ? 1 : -1);
    }
  }

  let hash = 0n;
  for (let bit = 0; bit < 64; bit += 1) {
    if ((weights[bit] as number) > 0) {
      hash |= 1n << BigInt(63 - bit);
    }
  }
  return BigInt.asIntN(64, hash);
}

/** Number of differing bits between two 64-bit hashes. 0 → identical. */
export function hammingDistance(a: bigint, b: bigint): number {
  let xor = BigInt.asUintN(64, a ^ b);
  let distance = 0;
  while (xor !== 0n) {
    xor &= xor - 1n;
    distance += 1;
  }
  return distance;
}

export function contentHash(input: string): string {
  return createHash('sha256').update(normalizeText(input)).digest('hex');
}

/** Truncates for logs and review UIs without splitting a word mid-way. */
export function truncate(input: string, maxLength: number): string {
  if (input.length <= maxLength) return input;
  const cut = input.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  return `${lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut}…`;
}

/** `#Cute_Baby!` → `cutebaby`. Empty results are dropped by the caller. */
export function normalizeHashtag(tag: string): string {
  return tag
    .replace(/^#+/, '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase();
}

export function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    result.push(item);
  }
  return result;
}
