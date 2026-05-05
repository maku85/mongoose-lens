import type { Model, Schema } from "mongoose";
import { buildAdvice } from "./engine/advisor.js";
import { buildReport } from "./engine/analyzer.js";
import { normalizeExplain } from "./engine/explain.js";
import { CircuitBreaker, DeduplicationCache, ExplainQueue } from "./engine/sampler.js";
import { registerAggregateMiddleware } from "./middleware/aggregate.middleware.js";
import { registerQueryMiddleware, skippedQueries } from "./middleware/query.middleware.js";
import { createTransports, dispatch } from "./transports/dispatch.js";
import type { LensConfig, ResolvedLensConfig } from "./types/config.types.js";
import type { LensReport } from "./types/report.types.js";

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

const DEFAULTS: ResolvedLensConfig = {
  thresholds: { executionTimeMs: 200, docsExamined: 1000, ratio: 10 },
  sampling: { rate: 1.0 },
  circuitBreaker: { maxExplainsPerWindow: 10, windowMs: 10_000 },
  deduplication: { windowMs: 60_000 },
  explainConcurrency: 2,
  transport: [{ type: "console" }],
  advice: "human",
};

function resolveConfig(user: LensConfig): ResolvedLensConfig {
  return {
    thresholds: { ...DEFAULTS.thresholds, ...user.thresholds },
    sampling: { ...DEFAULTS.sampling, ...user.sampling },
    circuitBreaker: { ...DEFAULTS.circuitBreaker, ...user.circuitBreaker },
    deduplication: { ...DEFAULTS.deduplication, ...user.deduplication },
    explainConcurrency: user.explainConcurrency ?? DEFAULTS.explainConcurrency,
    transport: user.transport ?? DEFAULTS.transport,
    advice: user.advice ?? DEFAULTS.advice,
  };
}

// ---------------------------------------------------------------------------
// .lens() helper — on-demand explain without automatic gates
// ---------------------------------------------------------------------------

/**
 * Run explain on the native collection for the given query and return a
 * LensReport.  `executionTimeMs` is taken from MongoDB's own
 * `executionStats.executionTimeMillis` — so the query is NOT executed twice
 * and the Mongoose middleware hooks are never re-triggered.
 */
// Runtime shape of a Mongoose Query — avoids the 7-generic Query<...> type.
interface QueryShape {
  model: Model<unknown>;
  getQuery(): Record<string, unknown>;
  getOptions(): Record<string, unknown>;
  op?: string;
}

async function runLensOnQuery(query: QueryShape, config: ResolvedLensConfig): Promise<LensReport> {
  const { model } = query;
  const filter = query.getQuery();
  const options = query.getOptions();
  const sort = options.sort as Record<string, unknown> | undefined;
  const modelName = model.modelName;
  const collectionName = model.collection.collectionName;
  const operation = query.op ?? "find";

  const rawExplain = await model.collection
    .find(filter, { sort: sort as Record<string, 1 | -1> | undefined })
    .explain("executionStats");

  const includeRaw = config.advice !== "human";
  const normalized = normalizeExplain(
    rawExplain as Parameters<typeof normalizeExplain>[0],
    includeRaw,
  );

  // Use MongoDB's own timing from the explain run — avoids a second round-trip.
  const executionTimeMs = normalized.stats.executionTimeMillis;

  const advice = buildAdvice({
    model: modelName,
    collectionName,
    operation,
    filter,
    sort,
    explain: normalized,
    executionTimeMs,
    config,
  });

  return buildReport({
    model: modelName,
    operation,
    filter,
    sort,
    executionTimeMs,
    explain: normalized,
    advice,
    config,
  });
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

/**
 * Returns a Mongoose schema plugin that:
 *  - intercepts slow queries via pre/post hooks
 *  - analyses them with explain() asynchronously (non-blocking)
 *  - emits LensReport objects to the configured transports
 *  - adds a `.lens()` query helper for on-demand analysis
 *
 * @example
 * mongoose.plugin(mongooseLens({ thresholds: { executionTimeMs: 100 } }))
 */
export function mongooseLens(userConfig: LensConfig = {}): (schema: Schema) => void {
  const config = resolveConfig(userConfig);
  const transports = createTransports(config.transport);
  const dedup = new DeduplicationCache(config.deduplication);
  const breaker = new CircuitBreaker(config.circuitBreaker);
  const queue = new ExplainQueue(config.explainConcurrency);

  const dispatchFn = (report: LensReport): Promise<void> => dispatch(report, transports);

  return function lensPlugin(schema: Schema): void {
    const deps = { config, dedup, breaker, queue, dispatch: dispatchFn };

    registerQueryMiddleware(schema, deps);
    registerAggregateMiddleware(schema, deps);

    // .lens() — on-demand explain; bypasses all automatic gates.
    // .skipLens() — opt-out: marks this query instance so the post-hook skips it.
    // Cast schema.query to any: Mongoose types it as {} which doesn't allow
    // adding arbitrary helper methods without a full generic chain.
    const q = schema.query as Record<string, unknown>;

    q.lens = function (this: QueryShape): Promise<LensReport> {
      return runLensOnQuery(this, config);
    };

    q.skipLens = function (this: object): object {
      skippedQueries.add(this);
      return this;
    };
  };
}
