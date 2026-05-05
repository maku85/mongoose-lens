import type { QueryStage } from "./explain.types.js";

export type Severity = "warning" | "critical";

export interface AdviceBlock {
  summary: string;
  suggestedIndex: Record<string, 1 | -1> | null;
  /** Ready-to-run db.collection.createIndex(...) shell command. */
  indexCommand: string | null;
  details: string;
}

export interface LensReport {
  timestamp: string;
  model: string;
  operation: string;
  executionTimeMs: number;
  docsExamined: number;
  docsReturned: number;
  /** docsExamined / docsReturned (Infinity when docsReturned === 0). */
  ratio: number;
  stage: QueryStage;
  severity: Severity;
  filter: Record<string, unknown>;
  sort?: Record<string, unknown>;
  advice: AdviceBlock;
  /** Full explain output — only present when LensConfig.advice === 'raw' | 'both'. */
  raw?: object;
}
