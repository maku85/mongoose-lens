import type { Aggregate, Model, Schema } from "mongoose";
import { buildAdvice } from "../engine/advisor.js";
import { buildReport, exceedsThreshold } from "../engine/analyzer.js";
import { normalizeExplain } from "../engine/explain.js";
import { buildDedupeKey, shouldExplain } from "../engine/sampler.js";
import type { MiddlewareDeps } from "./query.middleware.js";

// ---------------------------------------------------------------------------
// Helpers — extract useful fields from the aggregate pipeline
// ---------------------------------------------------------------------------

type PipelineStage = Record<string, unknown>;

/** Returns the filter from the first $match stage, or {} if absent. */
function extractMatchFilter(pipeline: Array<PipelineStage>): Record<string, unknown> {
  for (const stage of pipeline) {
    if ("$match" in stage && isPlainObject(stage.$match)) {
      return stage.$match as Record<string, unknown>;
    }
  }
  return {};
}

/** Returns the sort spec from the first $sort stage, or undefined if absent. */
function extractSort(pipeline: Array<PipelineStage>): Record<string, unknown> | undefined {
  for (const stage of pipeline) {
    if ("$sort" in stage && isPlainObject(stage.$sort)) {
      return stage.$sort as Record<string, unknown>;
    }
  }
  return undefined;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// WeakMap timer — keyed on Aggregate instance
// ---------------------------------------------------------------------------

const timers = new WeakMap<object, number>();

type AnyAggregate = Aggregate<Array<unknown>>;

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerAggregateMiddleware(schema: Schema, deps: MiddlewareDeps): void {
  const { config, dedup, breaker, queue, dispatch } = deps;

  schema.pre("aggregate", function (this: AnyAggregate) {
    timers.set(this, Date.now());
  });

  schema.post("aggregate", async function (this: AnyAggregate, _result: unknown) {
    const start = timers.get(this);
    timers.delete(this);
    if (start === undefined) return;

    const executionTimeMs = Date.now() - start;
    if (executionTimeMs < config.thresholds.executionTimeMs) return;

    const pipeline = this.pipeline() as unknown as Array<PipelineStage>;
    const filter = extractMatchFilter(pipeline);
    const sort = extractSort(pipeline);

    // Use the model name from the Aggregate instance
    const model = (this as unknown as { model: Model<unknown> }).model;
    const modelName = model?.modelName ?? "Unknown";

    const key = buildDedupeKey(modelName, filter);
    if (!shouldExplain(key, config, dedup, breaker)) return;

    const collection = model.collection;

    queue.enqueue(async () => {
      try {
        // Run explain on the raw aggregate cursor — bypasses Mongoose middleware.
        const rawExplain = await collection.aggregate(pipeline).explain("executionStats");

        const includeRaw = config.advice !== "human";
        const normalized = normalizeExplain(
          rawExplain as Parameters<typeof normalizeExplain>[0],
          includeRaw,
        );

        const metrics = {
          executionTimeMs,
          docsExamined: normalized.stats.totalDocsExamined,
          docsReturned: normalized.stats.nReturned,
        };
        if (!exceedsThreshold(metrics, config.thresholds)) return;

        const advice = buildAdvice({
          model: modelName,
          operation: "aggregate",
          filter,
          sort,
          explain: normalized,
          executionTimeMs,
          config,
        });
        const report = buildReport({
          model: modelName,
          operation: "aggregate",
          filter,
          sort,
          executionTimeMs,
          explain: normalized,
          advice,
          config,
        });

        await dispatch(report);
      } catch {
        // Explain errors must never surface to the application.
      }
    });
  });
}
