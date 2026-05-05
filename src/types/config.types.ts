import type { LensReport } from "./report.types.js";

// ---------------------------------------------------------------------------
// Threshold config
// ---------------------------------------------------------------------------

export interface ThresholdConfig {
  /** Milliseconds. Default: 200. */
  executionTimeMs?: number;
  /** Total docs examined. Default: 1000. */
  docsExamined?: number;
  /** docsExamined / docsReturned ratio. Default: 10. */
  ratio?: number;
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

export interface SamplingConfig {
  /** 0.0–1.0. Default: 1.0. */
  rate?: number;
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

export interface CircuitBreakerConfig {
  /** Max explain calls allowed within windowMs. Default: 10. */
  maxExplainsPerWindow?: number;
  /** Window duration in ms. Default: 10_000. */
  windowMs?: number;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

export interface DeduplicationConfig {
  /**
   * Skip explain for identical queries (same model + serialized filter)
   * seen within this window. Default: 60_000.
   */
  windowMs?: number;
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

export interface ConsoleTransportConfig {
  type: "console";
}

export interface JsonTransportConfig {
  type: "json";
  /** File path for the .jsonl output. */
  path: string;
}

export interface CustomTransportConfig {
  type: "custom";
  handler: (report: LensReport) => void | Promise<void>;
}

export type TransportConfig = ConsoleTransportConfig | JsonTransportConfig | CustomTransportConfig;

// ---------------------------------------------------------------------------
// Advice mode
// ---------------------------------------------------------------------------

export type AdviceMode = "human" | "raw" | "both";

// ---------------------------------------------------------------------------
// Top-level plugin config
// ---------------------------------------------------------------------------

export interface LensConfig {
  thresholds?: ThresholdConfig;
  sampling?: SamplingConfig;
  circuitBreaker?: CircuitBreakerConfig;
  deduplication?: DeduplicationConfig;
  /** Max parallel explain calls. Default: 2. */
  explainConcurrency?: number;
  transport?: Array<TransportConfig>;
  /** Controls verbosity of the advice block and raw field. Default: 'human'. */
  advice?: AdviceMode;
}

// ---------------------------------------------------------------------------
// Resolved (all fields defined) — used internally after merging defaults
// ---------------------------------------------------------------------------

export interface ResolvedLensConfig {
  thresholds: Required<ThresholdConfig>;
  sampling: Required<SamplingConfig>;
  circuitBreaker: Required<CircuitBreakerConfig>;
  deduplication: Required<DeduplicationConfig>;
  explainConcurrency: number;
  transport: Array<TransportConfig>;
  advice: AdviceMode;
}
