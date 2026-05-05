/** Normalized subset of MongoDB explain('executionStats') output. */
export interface ExplainExecutionStats {
  nReturned: number;
  totalDocsExamined: number;
  executionTimeMillis: number;
}

/** Dominant query stage extracted from the explain tree. */
export type QueryStage = "COLLSCAN" | "IXSCAN" | "FETCH" | "SORT" | "UNKNOWN";

/** Normalized explain result produced by the explain engine. */
export interface NormalizedExplain {
  stats: ExplainExecutionStats;
  dominantStage: QueryStage;
  /** Full raw explain document, present only when advice === 'raw' | 'both'. */
  raw?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Raw MongoDB explain shapes (partial — only fields we need)
// ---------------------------------------------------------------------------

export interface MongoExecutionStage {
  stage: string;
  inputStage?: MongoExecutionStage;
  inputStages?: Array<MongoExecutionStage>;
}

export interface MongoExecutionStats {
  nReturned: number;
  totalDocsExamined: number;
  executionTimeMillis: number;
  executionStages?: MongoExecutionStage;
}

/** Minimal shape of the document returned by explain('executionStats'). */
export interface MongoExplainDocument {
  executionStats?: MongoExecutionStats;
  /** Sharded clusters nest stats here. */
  executionStatsByShardName?: Record<string, { executionStats?: MongoExecutionStats }>;
}
