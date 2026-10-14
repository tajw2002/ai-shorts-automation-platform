import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  type SafetyAssessment,
  type SafetyFinding,
  type SafetySurface,
  type SafetyVerdict,
} from '@shorts/contracts';
import { AppConfig } from '@/config/app-config';
import { LLM_PROVIDER } from '@/providers/provider.tokens';
import { type LLMProvider } from '@/providers/llm/llm-provider.interface';
import { truncate } from '@/common/utils/text';
import { describeError } from '@/common/errors';
import { SAFETY_RULES, type SafetyRule } from './safety-rules';

/**
 * Content safety layer.
 *
 * Two evaluators, combined conservatively:
 *   1. Deterministic rules — always run, cannot be argued with.
 *   2. An optional model reviewer — a second opinion, off by default.
 *
 * The combination rule is "worst verdict wins". A BLOCK from either evaluator
 * blocks. Anything uncertain — including the reviewer being unavailable — becomes
 * REVIEW rather than ALLOW, because the cost of a wrong ALLOW is a policy strike
 * on the channel and the cost of a wrong REVIEW is a minute of an operator's time.
 */
@Injectable()
export class SafetyService {
  private readonly logger = new Logger(SafetyService.name);

  constructor(
    private readonly config: AppConfig,
    @Inject(LLM_PROVIDER) private readonly llm: LLMProvider,
  ) {}

  /** Evaluates a single piece of text. */
  async evaluate(text: string, surface: SafetySurface): Promise<SafetyAssessment> {
    const ruleFindings = evaluateRules(text, surface);
    const evaluators = ['rules'];
    let verdict = verdictFromRules(ruleFindings, this.config.safety.uncertainAction);
    const findings = [...ruleFindings];

    // Escalating to the model only when the rules did not already block saves a
    // paid call on content that is going nowhere anyway.
    if (this.config.safety.llmReviewEnabled && verdict !== 'BLOCK') {
      evaluators.push('llm');
      try {
        const review = await this.llm.moderate({
          text,
          surface,
          language: this.config.content.language,
        });
        findings.push(...review.data.findings);
        verdict = worstVerdict(verdict, review.data.verdict);
      } catch (error) {
        // A reviewer that cannot be reached must not silently downgrade to ALLOW.
        this.logger.warn(`Model safety review failed: ${describeError(error)}`);
        findings.push({
          category: 'CHILD_SAFETY',
          confidence: 0.3,
          reason: 'The model safety reviewer was unavailable, so this needs a human look.',
        });
        verdict = worstVerdict(verdict, 'REVIEW');
      }
    }

    return { verdict, findings, evaluators, evaluatedAt: new Date().toISOString() };
  }

  /**
   * Evaluates several related texts and returns the combined worst verdict —
   * used when a whole script (narration plus every scene prompt) must clear.
   */
  async evaluateAll(
    parts: Array<{ text: string; surface: SafetySurface }>,
  ): Promise<SafetyAssessment> {
    const assessments = await Promise.all(
      parts.map((part) => this.evaluate(part.text, part.surface)),
    );

    return {
      verdict: assessments.reduce<SafetyVerdict>(
        (worst, assessment) => worstVerdict(worst, assessment.verdict),
        'ALLOW',
      ),
      findings: assessments.flatMap((assessment) => assessment.findings),
      evaluators: [...new Set(assessments.flatMap((a) => a.evaluators))],
      evaluatedAt: new Date().toISOString(),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Pure functions — exported so they can be unit tested without the DI graph.  */
/* -------------------------------------------------------------------------- */

export function evaluateRules(text: string, surface: SafetySurface): SafetyFinding[] {
  const findings: SafetyFinding[] = [];

  for (const rule of SAFETY_RULES) {
    if (rule.surfaces && !rule.surfaces.includes(surface)) continue;

    const match = rule.pattern.exec(text);
    if (!match) continue;

    findings.push({
      category: rule.category,
      confidence: rule.weight,
      reason: rule.description,
      excerpt: excerptAround(text, match.index, match[0].length),
    });
  }

  return findings;
}

export function verdictFromRules(
  findings: SafetyFinding[],
  uncertainAction: 'block' | 'review',
): SafetyVerdict {
  if (findings.length === 0) return 'ALLOW';

  const blocking = findings.some((finding) => isBlockingFinding(finding));
  if (blocking) return 'BLOCK';

  // A pile of low-confidence hits is itself a signal worth a human look.
  const aggregate = findings.reduce((sum, finding) => sum + finding.confidence, 0);
  if (aggregate >= 1.5) return uncertainAction === 'block' ? 'BLOCK' : 'REVIEW';

  return 'REVIEW';
}

/** BLOCK-action rules always carry weight 1, which is what marks them as blocking. */
function isBlockingFinding(finding: SafetyFinding): boolean {
  const rule = ruleFor(finding);
  return rule?.action === 'BLOCK';
}

function ruleFor(finding: SafetyFinding): SafetyRule | undefined {
  return SAFETY_RULES.find(
    (rule) => rule.category === finding.category && rule.description === finding.reason,
  );
}

const VERDICT_SEVERITY: Record<SafetyVerdict, number> = { ALLOW: 0, REVIEW: 1, BLOCK: 2 };

export function worstVerdict(a: SafetyVerdict, b: SafetyVerdict): SafetyVerdict {
  return VERDICT_SEVERITY[a] >= VERDICT_SEVERITY[b] ? a : b;
}

/** A short window around the match, so a reviewer sees why a rule fired. */
function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 40);
  return truncate(
    `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`,
    140,
  );
}
