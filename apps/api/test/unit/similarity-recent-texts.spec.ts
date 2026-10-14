import { SimilarityService } from '@/modules/similarity/similarity.service';
import { AppConfig } from '@/config/app-config';
import { envSchema } from '@/config/env.schema';
import { normalizeText } from '@/common/utils/text';

/**
 * The "avoid these" lists must show the model original text.
 *
 * Found by running the real LLM for the first time: the prompt was fed the
 * *normalised* fingerprint text, so the model copied that style and returned
 * `baby leo and the a shy music box attic` — lowercase, unpunctuated, ungrammatical.
 * For narration the damage is worse, because the voice provider reads that text aloud.
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

interface Owners {
  ideaId?: string | null;
  scriptId?: string | null;
  videoId?: string | null;
}

function fingerprint(text: string, owners: Owners) {
  return {
    normalized: normalizeText(text),
    ideaId: owners.ideaId ?? null,
    scriptId: owners.scriptId ?? null,
    videoId: owners.videoId ?? null,
  };
}

function makeService(sources: {
  fingerprints: ReturnType<typeof fingerprint>[];
  ideas?: Array<{ id: string; title: string; premise: string }>;
  scripts?: Array<{ id: string; narration: string }>;
  videos?: Array<{ id: string; title: string | null }>;
}) {
  const prisma = {
    contentFingerprint: { findMany: jest.fn().mockResolvedValue(sources.fingerprints) },
    contentIdea: { findMany: jest.fn().mockResolvedValue(sources.ideas ?? []) },
    script: { findMany: jest.fn().mockResolvedValue(sources.scripts ?? []) },
    video: { findMany: jest.fn().mockResolvedValue(sources.videos ?? []) },
  };
  return new SimilarityService(prisma as never, makeConfig());
}

describe('SimilarityService.recentTexts', () => {
  it('returns the original title, not the lowercased normal form', async () => {
    const title = 'Ducky and the Runaway Balloon!';
    const service = makeService({
      fingerprints: [fingerprint(title, { ideaId: 'i1' })],
      ideas: [{ id: 'i1', title, premise: 'unused' }],
    });

    const [result] = await service.recentTexts('IDEA_TITLE');

    expect(result).toBe(title);
    expect(result).not.toBe(normalizeText(title));
  });

  it('returns the original premise for IDEA_PREMISE, not the title', async () => {
    const premise = 'Baby Leo finds a music box, and together they make it sing.';
    const service = makeService({
      fingerprints: [fingerprint(premise, { ideaId: 'i1' })],
      ideas: [{ id: 'i1', title: 'A Different Title', premise }],
    });

    expect(await service.recentTexts('IDEA_PREMISE')).toEqual([premise]);
  });

  it('keeps narration punctuation, which the voice provider uses for prosody', async () => {
    const narration = 'Leo giggled. "Again!" he said, and Ducky waddled closer.';
    const service = makeService({
      fingerprints: [fingerprint(narration, { scriptId: 's1' })],
      scripts: [{ id: 's1', narration }],
    });

    expect(await service.recentTexts('SCRIPT_NARRATION')).toEqual([narration]);
  });

  it('returns the original video title', async () => {
    const title = 'The Very Loud Hiccup';
    const service = makeService({
      fingerprints: [fingerprint(title, { videoId: 'v1' })],
      videos: [{ id: 'v1', title }],
    });

    expect(await service.recentTexts('VIDEO_TITLE')).toEqual([title]);
  });

  it('falls back to the normal form when the source row is gone', async () => {
    const title = 'A Deleted Idea';
    const service = makeService({
      fingerprints: [fingerprint(title, { ideaId: 'gone' })],
      ideas: [],
    });

    expect(await service.recentTexts('IDEA_TITLE')).toEqual([normalizeText(title)]);
  });

  it('falls back when a video has no title yet', async () => {
    const service = makeService({
      fingerprints: [fingerprint('Untitled Draft', { videoId: 'v1' })],
      videos: [{ id: 'v1', title: null }],
    });

    expect(await service.recentTexts('VIDEO_TITLE')).toEqual([normalizeText('Untitled Draft')]);
  });

  it('preserves recency order across a mix of found and missing rows', async () => {
    const service = makeService({
      fingerprints: [
        fingerprint('Newest One', { ideaId: 'a' }),
        fingerprint('Orphaned', { ideaId: 'missing' }),
        fingerprint('Oldest One', { ideaId: 'c' }),
      ],
      ideas: [
        { id: 'c', title: 'Oldest One', premise: '' },
        { id: 'a', title: 'Newest One', premise: '' },
      ],
    });

    expect(await service.recentTexts('IDEA_TITLE')).toEqual([
      'Newest One',
      normalizeText('Orphaned'),
      'Oldest One',
    ]);
  });

  it('does not query unrelated tables', async () => {
    const service = makeService({
      fingerprints: [fingerprint('x y', { ideaId: 'i1' })],
      ideas: [{ id: 'i1', title: 'X Y', premise: '' }],
    });
    const prisma = (service as unknown as { prisma: { script: { findMany: jest.Mock } } }).prisma;

    await service.recentTexts('IDEA_TITLE');

    expect(prisma.script.findMany).not.toHaveBeenCalled();
  });
});
