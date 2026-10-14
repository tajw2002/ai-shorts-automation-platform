import { type VideoStatus } from '@shorts/contracts';

/**
 * One transition in the video state machine.
 *
 * Every step must be **idempotent**: re-running it after a crash, or after a
 * duplicate queue delivery, must not repeat work that already produced output.
 * Steps enforce this by checking for their own output before doing anything —
 * a scene that already has a downloaded asset is not generated again, which is
 * what stops a retry from costing money twice.
 */
export interface PipelineStep {
  /** The status this step consumes. Exactly one step may claim a given status. */
  readonly from: VideoStatus;
  /** Human-readable name for logs and the dashboard. */
  readonly name: string;
  /**
   * Status held while the step runs, when a distinct in-progress state is useful
   * to show an operator (e.g. GENERATING, ASSEMBLING).
   */
  readonly running?: VideoStatus;
  execute(context: PipelineContext): Promise<PipelineStepResult>;
}

export interface PipelineContext {
  videoId: string;
  /** The job this step is running under, for cost attribution and logging. */
  jobId: string | null;
}

export interface PipelineStepResult {
  next: VideoStatus;
  /** Recorded on the status event; shown in the video's history. */
  note?: string;
  /**
   * Set when the step deliberately stops the pipeline rather than continuing —
   * a human gate, or a failure that has already been recorded.
   */
  halt?: boolean;
}

/** Injection token for the step registry, so steps can be provided as a list. */
export const PIPELINE_STEPS = Symbol('PIPELINE_STEPS');
