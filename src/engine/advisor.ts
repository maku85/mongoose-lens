import type { ResolvedLensConfig } from "../types/config.types.js";
import type { NormalizedExplain, QueryStage } from "../types/explain.types.js";
import type { AdviceBlock } from "../types/report.types.js";
import {
  buildIndexCommand,
  buildIndexSpec,
  categorizeFilterFields,
} from "../utils/index-suggester.js";
import { computeRatio } from "./analyzer.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface AdvisorInput {
  model: string;
  collectionName: string;
  operation: string;
  filter: Record<string, unknown>;
  sort?: Record<string, unknown>;
  explain: NormalizedExplain;
  executionTimeMs: number;
  config: ResolvedLensConfig;
}

/**
 * Produce an AdviceBlock for a slow query.
 *
 * When config.advice === 'raw' the text fields are left empty — the caller
 * will include the full explain document in LensReport.raw instead.
 */
export function buildAdvice(input: AdvisorInput): AdviceBlock {
  const { stats, dominantStage } = input.explain;
  const ratio = computeRatio(stats.totalDocsExamined, stats.nReturned);

  const filterFields = categorizeFilterFields(input.filter);
  const suggestedIndex = buildIndexSpec(filterFields, input.sort);
  const indexCommand = suggestedIndex
    ? buildIndexCommand(input.collectionName, suggestedIndex)
    : null;

  if (input.config.advice === "raw") {
    // Human text is suppressed — report will carry the raw explain instead.
    return { summary: "", suggestedIndex, indexCommand, details: "" };
  }

  const summary = buildSummary(input.model, input.operation, dominantStage);
  const details = buildDetails({
    model: input.model,
    operation: input.operation,
    stage: dominantStage,
    docsExamined: stats.totalDocsExamined,
    docsReturned: stats.nReturned,
    ratio,
    executionTimeMs: input.executionTimeMs,
    filter: input.filter,
    sort: input.sort,
    suggestedIndex,
  });

  return { summary, suggestedIndex, indexCommand, details };
}

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

function buildSummary(model: string, operation: string, stage: QueryStage): string {
  switch (stage) {
    case "COLLSCAN":
      return `Full collection scan on ${model}.${operation} — no index covers this filter.`;
    case "SORT":
      return `Blocking in-memory sort on ${model}.${operation} — sort fields are not indexed.`;
    case "FETCH":
      return `High document fetch ratio on ${model}.${operation} — index is not selective enough.`;
    case "IXSCAN":
      return `Inefficient index scan on ${model}.${operation} — too many documents examined.`;
    default:
      return `Slow query on ${model}.${operation} — performance threshold exceeded.`;
  }
}

interface DetailsInput {
  model: string;
  operation: string;
  stage: QueryStage;
  docsExamined: number;
  docsReturned: number;
  ratio: number;
  executionTimeMs: number;
  filter: Record<string, unknown>;
  sort?: Record<string, unknown>;
  suggestedIndex: Record<string, 1 | -1> | null;
}

function buildDetails(d: DetailsInput): string {
  const ratioStr = Number.isFinite(d.ratio) ? `${d.ratio.toFixed(1)}:1` : "∞ (0 docs returned)";

  const statsLine =
    `Examined ${d.docsExamined.toLocaleString()} docs, ` +
    `returned ${d.docsReturned.toLocaleString()} (ratio ${ratioStr}), ` +
    `took ${d.executionTimeMs}ms.`;

  const stageAdvice = stageDetails(d.stage, d.filter, d.sort);

  const indexLine = d.suggestedIndex
    ? `Suggested index follows the ESR rule (Equality → Sort → Range): ${JSON.stringify(d.suggestedIndex)}.`
    : "No index can be suggested — the filter is empty or covers no indexable fields.";

  return [statsLine, stageAdvice, indexLine].filter(Boolean).join(" ");
}

function stageDetails(
  stage: QueryStage,
  filter: Record<string, unknown>,
  sort?: Record<string, unknown>,
): string {
  const filterKeys = Object.keys(filter).filter((k) => !k.startsWith("$"));

  switch (stage) {
    case "COLLSCAN":
      return filterKeys.length > 0
        ? `MongoDB scanned every document because no index covers {${filterKeys.join(", ")}}. Performance will degrade linearly with collection growth.`
        : "MongoDB scanned every document (empty filter or $or without a covering index).";

    case "SORT":
      return sort
        ? `MongoDB performed a blocking in-memory sort on {${Object.keys(sort).join(", ")}}. Adding these fields to the index avoids the sort stage.`
        : "MongoDB performed a blocking in-memory sort. Include sort fields in the suggested index.";

    case "FETCH":
      return (
        "The index returned many candidate document IDs that were then fetched and rejected by the filter. " +
        "A more selective index (or a covered query) would reduce random I/O."
      );

    case "IXSCAN":
      return (
        "An index was used but it examined far more keys than documents returned. " +
        "Consider a more selective compound index that matches your filter and sort."
      );

    default:
      return "Review the raw explain output to identify the bottleneck.";
  }
}
