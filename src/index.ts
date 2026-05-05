/**
 * mongoose-lens — slow query interceptor and index advisor for Mongoose 8+
 *
 * @example
 * import mongoose from 'mongoose'
 * import { mongooseLens } from 'mongoose-lens'
 *
 * mongoose.plugin(mongooseLens({
 *   thresholds: { executionTimeMs: 200 },
 *   transport: [{ type: 'console' }, { type: 'json', path: './logs/queries.jsonl' }],
 * }))
 */

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export { mongooseLens } from "./plugin.js";

// Types consumers may need to annotate handlers / transports
export type { LensConfig } from "./types/config.types.js";
export type {
  AdviceBlock,
  LensReport,
  Severity,
} from "./types/report.types.js";
export type { QueryStage } from "./types/explain.types.js";

// ---------------------------------------------------------------------------
// Mongoose module augmentation — adds .lens() to all Query instances
// ---------------------------------------------------------------------------

import type { LensReport } from "./types/report.types.js";

declare module "mongoose" {
  // Names + defaults must exactly mirror the Mongoose 8 Query class for TS2428.
  // noUnusedVariables is disabled for this file via biome.json overrides.
  interface Query<
    ResultType,
    DocType,
    // biome-ignore lint/complexity/noBannedTypes: {} mirrors Mongoose's THelpers = {} default
    THelpers = {},
    RawDocType = unknown,
    QueryOp = "find",
    TDocOverrides = Record<string, never>,
  > {
    /**
     * Run explain('executionStats') on this query and return a LensReport.
     * The query is NOT executed — `executionTimeMs` comes from MongoDB's own
     * explain timing.  No sampling / dedup / circuit-breaker gates apply.
     *
     * @example
     * const report = await User.find({ status: 'active' }).lens()
     */
    lens(): Promise<LensReport>;

    /**
     * Opt this query out of automatic lens analysis.
     * Useful for internal or system queries you do not want to monitor.
     *
     * @example
     * await User.find({ _id: systemId }).skipLens()
     */
    skipLens(): this;
  }
}
