# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-05-05

### Added
- `mongooseLens()` plugin factory for Mongoose 8+
- Automatic slow-query interception via pre/post hooks (query + aggregate)
- `explain('executionStats')` analysis with dominant-stage detection (COLLSCAN, IXSCAN, SORT, FETCH)
- Index suggester following the ESR rule (Equality → Sort → Range)
- Human-readable advice with suggested `createIndex` command
- Probabilistic sampler (`sampling.rate`)
- Sliding-window circuit breaker (`circuitBreaker.maxExplainsPerWindow`)
- Deduplication cache to skip repeated identical queries (`deduplication.windowMs`)
- Non-blocking async explain queue (`setImmediate` + bounded concurrency)
- Three built-in transports: `console`, `json` (JSONL), `custom`
- On-demand `.lens()` query helper that returns a `LensReport` without executing the query as a data fetch
- `.skipLens()` query helper to opt a specific query out of automatic lens analysis
- `advice: 'both'` mode documented (human-readable text + raw explain in `LensReport.raw`)
- Dual ESM + CJS output with full TypeScript declarations
