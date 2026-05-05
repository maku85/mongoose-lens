# mongoose-lens

Slow query interceptor and index advisor for Mongoose 8+.

Automatically runs `explain('executionStats')` on queries that exceed configurable thresholds, detects the dominant execution stage (COLLSCAN, SORT, high-ratio FETCH …), and suggests an optimal index following the **ESR rule** (Equality → Sort → Range).

## Features

- Zero-overhead on fast queries — sampling, circuit breaker, and deduplication keep explain calls rare
- Non-blocking — explain runs asynchronously via `setImmediate` + bounded concurrency queue
- Human-readable advice with a ready-to-paste `db.collection.createIndex(…)` command
- Three built-in transports: `console`, JSON lines file, custom handler
- On-demand `.lens()` helper for ad-hoc analysis in development
- Dual ESM + CJS output, TypeScript declarations included

## Installation

```sh
npm install mongoose-lens
# or
pnpm add mongoose-lens
```

`mongoose` ≥ 8.0.0 is a peer dependency.

## Quick start

```ts
import mongoose from 'mongoose'
import { mongooseLens } from 'mongoose-lens'

// Register once, before defining models
mongoose.plugin(mongooseLens({
  thresholds: { executionTimeMs: 200 },
  transport: [
    { type: 'console' },
    { type: 'json', path: './logs/slow-queries.jsonl' },
  ],
}))
```

From that point every query or aggregation slower than 200 ms (or that examines too many documents) will be automatically analyzed and reported.

## Configuration

```ts
mongooseLens({
  // A query triggers analysis when ANY threshold is exceeded.
  thresholds: {
    executionTimeMs: 200,   // wall-clock ms (default: 200)
    docsExamined:   1000,   // nExaminedDocuments (default: 1000)
    ratio:          10,     // examined / returned ratio (default: 10)
  },

  // Probabilistic sampling — 1 = always, 0 = never.
  sampling: { rate: 1 },

  // Sliding-window circuit breaker.
  circuitBreaker: {
    maxExplainsPerWindow: 10,   // max explains per window
    windowMs:             10_000,
  },

  // Skip re-analysis of the same model+filter within this window.
  deduplication: { windowMs: 60_000 },

  // Max simultaneous explain() calls in flight.
  explainConcurrency: 2,

  // 'human' (default) — readable summary + details text
  // 'raw'   — empty text fields, LensReport.raw contains the full explain
  // 'both'  — readable text AND LensReport.raw
  advice: 'human',

  transport: [
    { type: 'console' },
    { type: 'json', path: './logs/queries.jsonl' },
    { type: 'custom', handler: async (report) => { /* … */ } },
  ],
})
```

All fields are optional. Missing fields fall back to defaults.

## LensReport shape

```ts
interface LensReport {
  model:           string;          // e.g. "User"
  operation:       string;          // e.g. "find"
  filter:          Record<string, unknown>;
  sort?:           Record<string, unknown>;
  stage:           QueryStage;      // "COLLSCAN" | "IXSCAN" | "SORT" | "FETCH" | …
  severity:        "warning" | "critical";
  executionTimeMs: number;
  docsExamined:    number;
  docsReturned:    number;
  ratio:           number;
  timestamp:       string;          // ISO 8601
  advice: {
    summary:        string;
    details:        string;
    suggestedIndex: Record<string, 1 | -1> | null;
    indexCommand:   string | null;
  };
  raw?: object;                     // full explain output (opt-in)
}
```

## On-demand `.lens()` helper

Use `.lens()` during development to inspect a specific query without waiting for it to exceed a threshold:

```ts
const report = await User.find({ status: 'active' }).sort({ createdAt: -1 }).lens()

console.log(report.stage)               // "COLLSCAN"
console.log(report.advice.indexCommand) // db.users.createIndex({"status":1,"createdAt":-1})
```

`.lens()` runs `explain('executionStats')` directly — no sampling, dedup, or circuit-breaker gates apply. The query itself is **not** executed as a data fetch.

## Per-query opt-out with `.skipLens()`

Use `.skipLens()` to exclude a specific query from automatic lens analysis — useful for internal or system queries you do not want to monitor:

```ts
// This query will not trigger explain or emit any LensReport
await User.findById(systemId).skipLens()
```

`.skipLens()` is chainable and returns the query unchanged. It only suppresses the automatic middleware; `.lens()` is unaffected.

## Custom transport

```ts
import type { LensReport } from 'mongoose-lens'

mongoose.plugin(mongooseLens({
  transport: [{
    type: 'custom',
    handler: async (report: LensReport) => {
      await mySlackClient.post('#alerts', report.advice.summary)
    },
  }],
}))
```

## License

MIT
