import type { MongooseQueryMiddleware, Schema } from "mongoose";
import { buildAdvice } from "../engine/advisor.js";
import { buildReport, exceedsThreshold } from "../engine/analyzer.js";
import { normalizeExplain } from "../engine/explain.js";
import {
  type CircuitBreaker,
  type DeduplicationCache,
  type ExplainQueue,
  buildDedupeKey,
  shouldExplain,
} from "../engine/sampler.js";
import type { ResolvedLensConfig } from "../types/config.types.js";
import type { LensReport } from "../types/report.types.js";

// ---------------------------------------------------------------------------
// Supported operations
// ---------------------------------------------------------------------------

const QUERY_OPS: Array<MongooseQueryMiddleware> = [
  "find",
  "findOne",
  "findOneAndUpdate",
  "findOneAndDelete",
  "updateOne",
  "updateMany",
  "deleteOne",
  "deleteMany",
  "countDocuments",
];

// ---------------------------------------------------------------------------
// Pre/post state — WeakMap keyed on the Query instance
// ---------------------------------------------------------------------------

const timers = new WeakMap<object, number>();

// ---------------------------------------------------------------------------
// Shared deps interface
// ---------------------------------------------------------------------------

export interface MiddlewareDeps {
  config: ResolvedLensConfig;
  dedup: DeduplicationCache;
  breaker: CircuitBreaker;
  queue: ExplainQueue;
  dispatch: (report: LensReport) => Promise<void>;
}

// Internal shape of `this` inside a Mongoose query hook.
// We cast to avoid fighting Mongoose's 7-generic Query<...> type.
interface QueryThis {
  getQuery(): Record<string, unknown>;
  getOptions(): Record<string, unknown>;
  model: {
    modelName: string;
    collection: { find: (...a: Array<unknown>) => { explain: (v: string) => Promise<unknown> } };
  };
  op: string;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerQueryMiddleware(schema: Schema, deps: MiddlewareDeps): void {
  const { config, dedup, breaker, queue, dispatch } = deps;

  // eslint-disable-next-line @typescript-eslint/no-this-alias
  schema.pre(QUERY_OPS, function (this: QueryThis) {
    timers.set(this, Date.now());
  });

  schema.post(QUERY_OPS, async function (this: QueryThis, _result: unknown) {
    const start = timers.get(this);
    timers.delete(this);
    if (start === undefined) return;

    const executionTimeMs = Date.now() - start;

    // Fast-path: bail before any allocation if time threshold is not exceeded.
    if (executionTimeMs < config.thresholds.executionTimeMs) return;

    const filter = this.getQuery();
    const options = this.getOptions();
    const sort = options.sort as Record<string, unknown> | undefined;
    const { model } = this;
    const modelName = model.modelName;
    const operation = this.op ?? "unknown";

    const key = buildDedupeKey(modelName, filter);
    if (!shouldExplain(key, config, dedup, breaker)) return;

    const { collection } = model;

    queue.enqueue(async () => {
      try {
        // Run explain on the native collection cursor — bypasses Mongoose
        // middleware to avoid an infinite loop.
        const rawExplain = await (
          collection as unknown as {
            find(f: unknown, o?: unknown): { explain(v: string): Promise<unknown> };
          }
        )
          .find(filter, { sort })
          .explain("executionStats");

        const includeRaw = config.advice !== "human";
        const normalized = normalizeExplain(
          rawExplain as Parameters<typeof normalizeExplain>[0],
          includeRaw,
        );

        // Re-check full stats — executionTimeMs already passed threshold, but
        // docsExamined/ratio may indicate the query is actually healthy.
        const metrics = {
          executionTimeMs,
          docsExamined: normalized.stats.totalDocsExamined,
          docsReturned: normalized.stats.nReturned,
        };
        if (!exceedsThreshold(metrics, config.thresholds)) return;

        const advice = buildAdvice({
          model: modelName,
          operation,
          filter,
          sort,
          explain: normalized,
          executionTimeMs,
          config,
        });
        const report = buildReport({
          model: modelName,
          operation,
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
