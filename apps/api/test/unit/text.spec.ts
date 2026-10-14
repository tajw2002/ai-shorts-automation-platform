import {
  charTrigrams,
  contentHash,
  cosineSimilarity,
  hammingDistance,
  jaccard,
  normalizeHashtag,
  normalizeText,
  shingles,
  simhash64,
  textSimilarityLong,
  textSimilarityShort,
  tokenize,
  truncate,
  uniqueBy,
} from '@/common/utils/text';

describe('normalizeText', () => {
  it('lowercases, strips punctuation and collapses whitespace', () => {
    expect(normalizeText('  Hello,   WORLD!!  ')).toBe('hello world');
  });

  it('strips diacritics so accented duplicates are still caught', () => {
    expect(normalizeText('Café Über')).toBe('cafe uber');
  });

  it('drops emoji, so decorating a repeat title cannot evade detection', () => {
    expect(normalizeText('Baby Leo 🥹 and Ducky 🦆')).toBe('baby leo and ducky');
  });

  it('returns an empty string for input with no letters or digits', () => {
    expect(normalizeText('!!! ??? ---')).toBe('');
  });
});

describe('tokenize', () => {
  it('removes stopwords by default', () => {
    expect(tokenize('the baby and the duck')).toEqual(['baby', 'duck']);
  });

  it('keeps stopwords when asked', () => {
    expect(tokenize('the baby', false)).toEqual(['the', 'baby']);
  });
});

describe('shingles', () => {
  it('produces word k-grams', () => {
    expect([...shingles('baby leo meets ducky today', 3)]).toEqual([
      'baby leo meets',
      'leo meets ducky',
      'meets ducky today',
    ]);
  });

  it('falls back to the whole token list when input is shorter than k', () => {
    expect([...shingles('baby leo', 3)]).toEqual(['baby leo']);
  });

  it('returns an empty set for empty input', () => {
    expect(shingles('').size).toBe(0);
  });
});

describe('jaccard', () => {
  it('treats two empty sets as identical', () => {
    expect(jaccard(new Set(), new Set())).toBe(1);
  });

  it('returns 0 when only one side is empty', () => {
    expect(jaccard(new Set(['a']), new Set())).toBe(0);
  });

  it('computes intersection over union', () => {
    expect(jaccard(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd']))).toBeCloseTo(2 / 4);
  });

  it('is symmetric', () => {
    const a = new Set(['a', 'b']);
    const b = new Set(['b', 'c', 'd']);
    expect(jaccard(a, b)).toBe(jaccard(b, a));
  });
});

describe('cosineSimilarity', () => {
  it('returns 1 for identical trigram vectors', () => {
    expect(cosineSimilarity(charTrigrams('baby leo'), charTrigrams('baby leo'))).toBeCloseTo(1);
  });

  it('returns 0 for disjoint vectors', () => {
    expect(cosineSimilarity(charTrigrams('abc'), charTrigrams('xyz'))).toBe(0);
  });
});

describe('textSimilarityShort (titles)', () => {
  it('scores near-identical titles very high', () => {
    const score = textSimilarityShort(
      'Baby Leo and the Missing Sock',
      'Baby Leo and the Missing Socks',
    );
    expect(score).toBeGreaterThan(0.9);
  });

  it('scores genuinely different titles low', () => {
    const score = textSimilarityShort(
      'Baby Leo and the Missing Sock',
      'Ducky Builds a Rainy Day Fort',
    );
    expect(score).toBeLessThan(0.5);
  });

  it('catches a title that only differs by punctuation and case', () => {
    expect(textSimilarityShort('Baby Leo!', 'baby leo')).toBeCloseTo(1);
  });
});

describe('textSimilarityLong (scripts)', () => {
  const original =
    'Baby Leo wakes up early and finds a tiny duckling hiding under the kitchen table. ' +
    'He giggles and offers it a crumb of toast, and they become friends by breakfast.';

  it('detects a lightly reworded duplicate', () => {
    const reworded =
      'Baby Leo wakes up early and finds a tiny duckling hiding under the kitchen table. ' +
      'He laughs and offers it a crumb of toast, and they become friends by breakfast.';
    expect(textSimilarityLong(original, reworded)).toBeGreaterThan(0.6);
  });

  it('does not flag an unrelated script', () => {
    const different =
      'Ducky discovers a puddle that reflects the sky upside down and spends the afternoon ' +
      'trying to convince a snail that the clouds have fallen into the garden.';
    expect(textSimilarityLong(original, different)).toBeLessThan(0.2);
  });
});

describe('simhash64', () => {
  it('is deterministic', () => {
    expect(simhash64('baby leo and ducky')).toBe(simhash64('baby leo and ducky'));
  });

  it('produces a small Hamming distance for near-duplicates', () => {
    const a = simhash64('Baby Leo finds a tiny duckling under the kitchen table at breakfast');
    const b = simhash64('Baby Leo finds a small duckling under the kitchen table at breakfast');
    expect(hammingDistance(a, b)).toBeLessThan(16);
  });

  it('produces a large Hamming distance for unrelated text', () => {
    const a = simhash64('Baby Leo finds a tiny duckling under the kitchen table at breakfast');
    const b = simhash64('A snail negotiates with a puddle about the location of the sky');
    expect(hammingDistance(a, b)).toBeGreaterThan(16);
  });

  it('fits in a signed 64-bit range so it round-trips through a Postgres BigInt', () => {
    const value = simhash64('some arbitrary content for hashing');
    expect(value).toBeGreaterThanOrEqual(-(2n ** 63n));
    expect(value).toBeLessThan(2n ** 63n);
  });

  it('returns 0n for text with no usable tokens', () => {
    expect(simhash64('!!!')).toBe(0n);
  });
});

describe('hammingDistance', () => {
  it('is 0 for identical values', () => {
    expect(hammingDistance(123n, 123n)).toBe(0);
  });

  it('counts differing bits', () => {
    expect(hammingDistance(0b1010n, 0b0110n)).toBe(2);
  });

  it('handles the sign bit without looping forever', () => {
    expect(hammingDistance(-1n, 0n)).toBe(64);
  });
});

describe('contentHash', () => {
  it('matches for texts that normalise identically', () => {
    expect(contentHash('Hello, World!')).toBe(contentHash('  hello   world  '));
  });

  it('differs for different content', () => {
    expect(contentHash('hello world')).not.toBe(contentHash('goodbye world'));
  });
});

describe('normalizeHashtag', () => {
  it('strips the hash, punctuation and case', () => {
    expect(normalizeHashtag('#Cute_Baby!')).toBe('cutebaby');
  });

  it('returns an empty string when nothing usable remains', () => {
    expect(normalizeHashtag('###')).toBe('');
  });
});

describe('truncate', () => {
  it('leaves short strings untouched', () => {
    expect(truncate('short', 20)).toBe('short');
  });

  it('cuts on a word boundary when there is a sensible one', () => {
    expect(truncate('the quick brown fox jumps', 15)).toBe('the quick brown…');
  });
});

describe('uniqueBy', () => {
  it('keeps the first occurrence of each key', () => {
    const items = [
      { id: 'a', n: 1 },
      { id: 'b', n: 2 },
      { id: 'a', n: 3 },
    ];
    expect(uniqueBy(items, (item) => item.id).map((i) => i.n)).toEqual([1, 2]);
  });
});
