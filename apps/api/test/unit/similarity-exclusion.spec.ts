import { SimilarityService } from '@/modules/similarity/similarity.service';
import { AppConfig } from '@/config/app-config';
import { envSchema } from '@/config/env.schema';
import { contentHash, normalizeText, simhash64 } from '@/common/utils/text';

/**
 * Self-match exclusion.
 *
 * Two false positives were found by running the real pipeline, and both are
 * pinned here:
 *
 *  1. Quality control re-checks a title that the assembly step has already
 *     fingerprinted, so the video matched itself.
 *  2. A video's title is derived from its *idea's* title, so the idea's
 *     fingerprint is an exact hash match for the video it produced — excluding
 *     only the video id is not enough.
 *
 * Both looked exactly like the anti-repetition layer working correctly, which is
 * what made them worth a regression test.
 */

function makeConfig(): AppConfig {
  return new AppConfig(
    envSchema.parse({
      DATABASE_URL: 'postgresql://test/test',
      SESSION_SECRET: Buffer.alloc(32, 1).toString('base64'),
      ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64'),
      INTERNAL_API_KEY: 'internal-key-for-tests',
    }),
  );
}

interface Row {
  id: string;
  normalized: string;
  simhash: bigint;
  contentHash: string;
  videoId: string | null;
  ideaId: string | null;
  scriptId: string | null;
}

function row(id: string, text: string, owners: Partial<Row> = {}): Row {
  return {
    id,
    normalized: normalizeText(text),
    simhash: simhash64(text),
    contentHash: contentHash(text),
    videoId: null,
    ideaId: null,
    scriptId: null,
    ...owners,
  };
}

/**
 * A Prisma double that actually evaluates the `where` clause the service builds.
 *
 * A mock that ignored the filter would let the bug through, which is the whole
 * point of the test — so the exclusion logic is genuinely executed here.
 */
function makePrisma(rows: Row[]) {
  const matches = (candidate: Row, where: Record<string, unknown>): boolean => {
    if (where.contentHash !== undefined && candidate.contentHash !== where.contentHash) {
      return false;
    }

    const and = where.AND as Array<Record<string, unknown>> | undefined;
    if (!and) return true;

    return and.every((clause) => {
      const or = clause.OR as Array<Record<string, unknown>>;
      return or.some((condition) => {
        const [field, expected] = Object.entries(condition)[0] as [keyof Row, unknown];
        const actual = candidate[field];
        if (expected === null) return actual === null;
        const notValue = (expected as { not?: string }).not;
        return notValue !== undefined ? actual !== notValue : actual === expected;
      });
    });
  };

  return {
    contentFingerprint: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const found = rows.find((candidate) => matches(candidate, where));
        return found ? { id: found.id, normalized: found.normalized } : null;
      }),
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        rows
          .filter((candidate) => matches(candidate, { ...where, contentHash: undefined }))
          .map((candidate) => ({
            id: candidate.id,
            normalized: candidate.normalized,
            simhash: candidate.simhash,
          })),
      ),
      createMany: jest.fn(),
    },
  };
}

const TITLE = 'Ducky and the Runaway Balloon';

describe('SimilarityService self-exclusion', () => {
  it('reports a duplicate when the candidate matches its own stored fingerprint', async () => {
    const rows = [row('fp-video', TITLE, { videoId: 'video-1' })];
    const service = new SimilarityService(makePrisma(rows) as never, makeConfig());

    const result = await service.check({ title: TITLE });

    // Without exclusion this is the (wrong) behaviour that reached production.
    expect(result.passed).toBe(false);
  });

  it('ignores the video’s own fingerprint when it is excluded', async () => {
    const rows = [row('fp-video', TITLE, { videoId: 'video-1' })];
    const service = new SimilarityService(makePrisma(rows) as never, makeConfig());

    const result = await service.check({ title: TITLE, exclude: { videoId: 'video-1' } });

    expect(result.passed).toBe(true);
    expect(result.matches).toEqual([]);
  });

  it('ignores the originating idea, whose title the video inherited', async () => {
    // The exact production failure: the idea fingerprint has videoId = null, so a
    // videoId-only exclusion leaves it in play and it hash-matches perfectly.
    const rows = [
      row('fp-idea', TITLE, { ideaId: 'idea-1' }),
      row('fp-video', TITLE, { videoId: 'video-1' }),
    ];
    const service = new SimilarityService(makePrisma(rows) as never, makeConfig());

    const videoOnly = await service.check({ title: TITLE, exclude: { videoId: 'video-1' } });
    expect(videoOnly.passed).toBe(false);

    const wholeLineage = await service.check({
      title: TITLE,
      exclude: { videoId: 'video-1', ideaId: 'idea-1', scriptId: 'script-1' },
    });
    expect(wholeLineage.passed).toBe(true);
  });

  it('still catches a genuine duplicate from another video', async () => {
    const rows = [
      row('fp-own', TITLE, { videoId: 'video-1', ideaId: 'idea-1' }),
      row('fp-other', TITLE, { videoId: 'video-2', ideaId: 'idea-2' }),
    ];
    const service = new SimilarityService(makePrisma(rows) as never, makeConfig());

    const result = await service.check({
      title: TITLE,
      exclude: { videoId: 'video-1', ideaId: 'idea-1' },
    });

    expect(result.passed).toBe(false);
    expect(result.matches[0]?.recordId).toBe('fp-other');
  });

  it('does not flag genuinely different titles', async () => {
    const rows = [
      row('fp-a', 'Baby Leo and the Upside-Down Puddle', { videoId: 'video-2' }),
      row('fp-b', 'The Very Loud Hiccup', { videoId: 'video-3' }),
    ];
    const service = new SimilarityService(makePrisma(rows) as never, makeConfig());

    const result = await service.check({ title: TITLE, exclude: { videoId: 'video-1' } });

    expect(result.passed).toBe(true);
    expect(result.worstScore).toBeLessThan(0.75);
  });

  it('computes a fingerprint that round-trips through the database types', () => {
    const service = new SimilarityService(makePrisma([]) as never, makeConfig());
    const fingerprint = service.fingerprint(TITLE);

    expect(fingerprint.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(() => BigInt(fingerprint.simhash)).not.toThrow();
    // normalizeText lowercases and strips punctuation but keeps stopwords;
    // only tokenize() removes them, and only for the shingle comparison.
    expect(fingerprint.normalized).toBe('ducky and the runaway balloon');
  });
});
