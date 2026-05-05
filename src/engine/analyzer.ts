import type { ResolvedLensConfig } from "../types/config.types.js";
import type { NormalizedExplain } from "../types/explain.types.js";
import type { LensReport, Severity } from "../types/report.types.js";
import type { AdviceBlock } from "../types/report.types.js";

// ---------------------------------------------------------------------------
// Threshold evaluation
// ---------------------------------------------------------------------------

export interface QueryMetrics {
  executionTimeMs: number;
  /** May be unknown before explain runs — pass 0 and check after. */
  docsExamined: number;
  docsReturned: number;
}

/**
 * Returns true if any threshold is exceeded.
 * Called *before* explain (using only executionTimeMs) and *after*
 * (using full stats) depending on caller context.
 */
export function exceedsThreshold(
  metrics: QueryMetrics,
  thresholds: ResolvedLensConfig["thresholds"],
): boolean {
  if (metrics.executionTimeMs >= thresholds.executionTimeMs) return true;
  if (metrics.docsExamined >= thresholds.docsExamined) return true;

  const ratio = computeRatio(metrics.docsExamined, metrics.docsReturned);
  if (ratio >= thresholds.ratio) return true;

  return false;
}

export function computeRatio(docsExamined: number, docsReturned: number): number {
  if (docsReturned === 0) return docsExamined === 0 ? 1 : Number.POSITIVE_INFINITY;
  return docsExamined / docsReturned;
}

function determineSeverity(
  metrics: QueryMetrics,
  thresholds: ResolvedLensConfig["thresholds"],
): Severity {
  const ratio = computeRatio(metrics.docsExamined, metrics.docsReturned);

  const critical =
    metrics.executionTimeMs >= thresholds.executionTimeMs * 5 ||
    metrics.docsExamined >= thresholds.docsExamined * 5 ||
    ratio >= thresholds.ratio * 5;

  return critical ? "critical" : "warning";
}

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------

export interface ReportInput {
  model: string;
  operation: string;
  filter: Record<string, unknown>;
  sort?: Record<string, unknown>;
  executionTimeMs: number;
  explain: NormalizedExplain;
  advice: AdviceBlock;
  config: ResolvedLensConfig;
}

export function buildReport(input: ReportInput): LensReport {
  const { stats, dominantStage, raw } = input.explain;

  const metrics: QueryMetrics = {
    executionTimeMs: input.executionTimeMs,
    docsExamined: stats.totalDocsExamined,
    docsReturned: stats.nReturned,
  };

  const includeRaw = input.config.advice === "raw" || input.config.advice === "both";

  return {
    timestamp: new Date().toISOString(),
    model: input.model,
    operation: input.operation,
    executionTimeMs: input.executionTimeMs,
    docsExamined: stats.totalDocsExamined,
    docsReturned: stats.nReturned,
    ratio: computeRatio(stats.totalDocsExamined, stats.nReturned),
    stage: dominantStage,
    severity: determineSeverity(metrics, input.config.thresholds),
    filter: input.filter,
    ...(input.sort ? { sort: input.sort } : {}),
    advice: input.advice,
    ...(includeRaw && raw ? { raw } : {}),
  };
}
