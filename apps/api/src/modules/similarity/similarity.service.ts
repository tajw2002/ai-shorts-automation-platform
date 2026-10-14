import { Injectable } from '@nestjs/common';
import {
  type ContentFingerprint,
  type SimilarityCheckResult,
  type SimilarityMatch,
} from '@shorts/contracts';
import { PrismaService } from '@/prisma/prisma.service';
import { AppConfig } from '@/config/app-config';
import {
  contentHash,
  hammingDistance,
  normalizeText,
  simhash64,
  textSimilarityLong,
  textSimilarityShort,
} from '@/common/utils/text';

/**
 * Anti-repetition layer.
 *
 * Three stages, cheapest first:
 *   1. **Exact hash** — a normalised SHA-256 match is a duplicate, full stop.
 *   2. **SimHash pre-filter** — narrows hundreds of stored fingerprints to the
 *      handful that are plausibly close, using Hamming distance on a 64-bit hash.
 *   3. **Precise comparison** — Jaccard over word shingles for long text,
 *      character-trigram cosine for short text such as titles.
 *
 * The model is *also* asked to avoid repetition, but this layer is what actually
 * enforces it: a generator cannot talk its way past arithmetic.
 */

/**
 * Hamming distance below which two SimHashes are worth comparing properly.
 * 16 of 64 bits is deliberately generous — this stage must not miss a candidate,
 * only reduce how many get the expensive treatment.
 */
const SIMHASH_CANDIDATE_DISTANCE = 16;

export type FingerprintKind =
  'IDEA_TITLE' | 'IDEA_PREMISE' | 'SCRIPT_NARRATION' | 'SCENE_PROMPT' | 'VIDEO_TITLE';

export interface SimilarityCheckRequest {
  title?: string;
  premise?: string;
  narration?: string;
  prompts?: string[];
  /**
   * The candidate's own lineage, whose fingerprints must be ignored.
   *
   * Re-checking content that has already been stored otherwise matches itself and
   * reports a duplicate. Note that *all three* ids matter, not just the video:
   * a video's title is derived from its idea's title, so the idea's fingerprint
   * is an exact hash match for the video and would be reported as a duplicate of
   * the very thing it produced.
   */
  exclude?: { videoId?: string | null; ideaId?: string | null; scriptId?: string | null };
}

@Injectable()
export class SimilarityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {}

  /** Computes the fingerprint stored alongside every piece of content. */
  fingerprint(text: string): ContentFingerprint {
    return {
      contentHash: contentHash(text),
      simhash: simhash64(text).toString(),
      normalized: normalizeText(text),
    };
  }

  /**
   * Checks a candidate against everything already stored.
   *
   * Returns the worst score seen and every match at or above its threshold, so
   * the caller can log precisely why a candidate was rejected.
   */
  async check(request: SimilarityCheckRequest): Promise<SimilarityCheckResult> {
    const thresholds = this.config.content.similarity;
    const matches: SimilarityMatch[] = [];
    let worstScore = 0;

    const compare = async (
      text: string | undefined,
      kinds: FingerprintKind[],
      threshold: number,
      field: SimilarityMatch['field'],
      comparator: (a: string, b: string) => number,
    ): Promise<void> => {
      if (!text || text.trim().length === 0) return;

      const candidates = await this.loadCandidates(text, kinds, request.exclude);
      for (const candidate of candidates) {
        const score = comparator(normalizeText(text), candidate.normalized);
        if (score > worstScore) worstScore = score;
        if (score >= threshold) {
          matches.push({ recordId: candidate.recordId, score, field });
        }
      }
    };

    await compare(
      request.title,
      ['IDEA_TITLE', 'VIDEO_TITLE'],
      thresholds.title,
      'title',
      textSimilarityShort,
    );
    await compare(
      request.premise,
      ['IDEA_PREMISE'],
      thresholds.script,
      'premise',
      textSimilarityLong,
    );
    await compare(
      request.narration,
      ['SCRIPT_NARRATION'],
      thresholds.script,
      'script',
      textSimilarityLong,
    );

    for (const prompt of request.prompts ?? []) {
      await compare(prompt, ['SCENE_PROMPT'], thresholds.prompt, 'prompt', textSimilarityLong);
    }

    return { passed: matches.length === 0, worstScore, matches };
  }

  /** Persists fingerprints for a newly accepted piece of content. */
  async store(
    entries: Array<{
      kind: FingerprintKind;
      text: string;
      ideaId?: string | null;
      scriptId?: string | null;
      videoId?: string | null;
    }>,
  ): Promise<void> {
    if (entries.length === 0) return;

    await this.prisma.contentFingerprint.createMany({
      data: entries.map((entry) => {
        const fingerprint = this.fingerprint(entry.text);
        return {
          kind: entry.kind,
          contentHash: fingerprint.contentHash,
          simhash: BigInt(fingerprint.simhash),
          normalized: fingerprint.normalized.slice(0, 8000),
          ideaId: entry.ideaId ?? null,
          scriptId: entry.scriptId ?? null,
          videoId: entry.videoId ?? null,
        };
      }),
    });
  }

  /**
   * Loads the stored fingerprints worth comparing against.
   *
   * An exact hash match short-circuits to a single, definitive candidate. Failing
   * that, the SimHash pre-filter is applied in memory over the configured lookback
   * window — a bounded scan, which keeps this predictable as the library grows.
   */
  private async loadCandidates(
    text: string,
    kinds: FingerprintKind[],
    exclude?: SimilarityCheckRequest['exclude'],
  ): Promise<Array<{ recordId: string; normalized: string }>> {
    const hash = contentHash(text);
    const notOwn = buildExclusion(exclude);

    const exact = await this.prisma.contentFingerprint.findFirst({
      where: { kind: { in: kinds }, contentHash: hash, ...notOwn },
      select: { id: true, normalized: true },
    });
    if (exact) return [{ recordId: exact.id, normalized: exact.normalized }];

    const stored = await this.prisma.contentFingerprint.findMany({
      where: { kind: { in: kinds }, ...notOwn },
      orderBy: { createdAt: 'desc' },
      take: this.config.content.similarity.lookback,
      select: { id: true, normalized: true, simhash: true },
    });

    const candidateHash = simhash64(text);
    return stored
      .filter((row) => hammingDistance(candidateHash, row.simhash) <= SIMHASH_CANDIDATE_DISTANCE)
      .map((row) => ({ recordId: row.id, normalized: row.normalized }));
  }

  /**
   * Recent titles/premises/narrations fed to the model as negative context.
   *
   * Returns the *original* text, not the normalised form a fingerprint stores
   * for matching. A model shown `ducky and the a runaway balloon` reproduces
   * that style in its own output — lowercase, no punctuation — and for
   * narration that output is exactly what the voice provider reads aloud.
   * The normalised text is only a fallback for a source row that no longer exists.
   */
  async recentTexts(kind: FingerprintKind, limit = 40): Promise<string[]> {
    const rows = await this.prisma.contentFingerprint.findMany({
      where: { kind },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { normalized: true, ideaId: true, scriptId: true, videoId: true },
    });
    const originals = await this.originalTexts(kind, rows);
    return rows.map((row, index) => originals[index] ?? row.normalized);
  }

  /** Original text for each fingerprint row, index-aligned; `null` when unknown. */
  private async originalTexts(
    kind: FingerprintKind,
    rows: FingerprintOwners[],
  ): Promise<Array<string | null>> {
    switch (kind) {
      case 'IDEA_TITLE':
      case 'IDEA_PREMISE': {
        const ids = ownerIds(rows, 'ideaId');
        const ideas = await this.prisma.contentIdea.findMany({
          where: { id: { in: ids } },
          select: { id: true, title: true, premise: true },
        });
        const field = kind === 'IDEA_TITLE' ? 'title' : 'premise';
        const byId = new Map<string, string>(ideas.map((idea) => [idea.id, idea[field]]));
        return rows.map((row) => (row.ideaId ? (byId.get(row.ideaId) ?? null) : null));
      }
      case 'SCRIPT_NARRATION': {
        const scripts = await this.prisma.script.findMany({
          where: { id: { in: ownerIds(rows, 'scriptId') } },
          select: { id: true, narration: true },
        });
        const byId = new Map<string, string>(scripts.map((s) => [s.id, s.narration]));
        return rows.map((row) => (row.scriptId ? (byId.get(row.scriptId) ?? null) : null));
      }
      case 'VIDEO_TITLE': {
        const videos = await this.prisma.video.findMany({
          where: { id: { in: ownerIds(rows, 'videoId') } },
          select: { id: true, title: true },
        });
        const byId = new Map<string, string>();
        for (const video of videos) if (video.title) byId.set(video.id, video.title);
        return rows.map((row) => (row.videoId ? (byId.get(row.videoId) ?? null) : null));
      }
      default:
        return rows.map(() => null);
    }
  }
}

interface FingerprintOwners {
  ideaId: string | null;
  scriptId: string | null;
  videoId: string | null;
}

function ownerIds(rows: FingerprintOwners[], key: keyof FingerprintOwners): string[] {
  return rows.map((row) => row[key]).filter((id): id is string => id !== null);
}

/**
 * Prisma `where` fragment excluding a record's own fingerprints.
 *
 * `not: id` alone would also exclude every row whose column is NULL, since SQL
 * comparisons against NULL are never true — so each clause explicitly keeps the
 * NULL rows, which belong to other records.
 */
function buildExclusion(exclude?: SimilarityCheckRequest['exclude']): Record<string, unknown> {
  if (!exclude) return {};

  const clauses: Array<Record<string, unknown>> = [];
  if (exclude.videoId) {
    clauses.push({ OR: [{ videoId: null }, { videoId: { not: exclude.videoId } }] });
  }
  if (exclude.ideaId) {
    clauses.push({ OR: [{ ideaId: null }, { ideaId: { not: exclude.ideaId } }] });
  }
  if (exclude.scriptId) {
    clauses.push({ OR: [{ scriptId: null }, { scriptId: { not: exclude.scriptId } }] });
  }

  return clauses.length > 0 ? { AND: clauses } : {};
}
