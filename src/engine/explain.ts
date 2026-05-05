import type {
  MongoExecutionStage,
  MongoExplainDocument,
  NormalizedExplain,
  QueryStage,
} from "../types/explain.types.js";

// ---------------------------------------------------------------------------
// Stage priority — higher index = higher severity; COLLSCAN wins.
// ---------------------------------------------------------------------------

const STAGE_PRIORITY: Record<string, number> = {
  UNKNOWN: 0,
  IXSCAN: 1,
  FETCH: 2,
  SORT: 3,
  COLLSCAN: 4,
};

function stageRank(stage: string): number {
  return STAGE_PRIORITY[stage] ?? 0;
}

/**
 * Walk the execution stage tree recursively, returning the highest-severity
 * stage found. COLLSCAN anywhere in the tree dominates.
 */
function findDominantStage(node: MongoExecutionStage | undefined): QueryStage {
  if (!node) return "UNKNOWN";

  let best = node.stage ?? "UNKNOWN";

  if (node.inputStage) {
    const child = findDominantStage(node.inputStage);
    if (stageRank(child) > stageRank(best)) best = child;
  }

  if (node.inputStages) {
    for (const child of node.inputStages) {
      const s = findDominantStage(child);
      if (stageRank(s) > stageRank(best)) best = s;
    }
  }

  const known: Array<QueryStage> = ["COLLSCAN", "IXSCAN", "FETCH", "SORT"];
  return (known as Array<string>).includes(best) ? (best as QueryStage) : "UNKNOWN";
}

// ---------------------------------------------------------------------------
// Sharded cluster support — merge stats across shards
// ---------------------------------------------------------------------------

interface RawStats {
  nReturned: number;
  totalDocsExamined: number;
  executionTimeMillis: number;
  executionStages?: MongoExecutionStage;
}

function mergeShardStats(shards: Record<string, { executionStats?: RawStats }>): RawStats {
  let nReturned = 0;
  let totalDocsExamined = 0;
  let executionTimeMillis = 0;
  let dominantStageNode: MongoExecutionStage | undefined;
  let bestRank = -1;

  for (const shard of Object.values(shards)) {
    const s = shard.executionStats;
    if (!s) continue;
    nReturned += s.nReturned ?? 0;
    totalDocsExamined += s.totalDocsExamined ?? 0;
    // wall-clock time: take the slowest shard
    if ((s.executionTimeMillis ?? 0) > executionTimeMillis) {
      executionTimeMillis = s.executionTimeMillis ?? 0;
    }
    const stage = s.executionStages;
    if (stage) {
      const rank = stageRank(findDominantStage(stage));
      if (rank > bestRank) {
        bestRank = rank;
        dominantStageNode = stage;
      }
    }
  }

  return { nReturned, totalDocsExamined, executionTimeMillis, executionStages: dominantStageNode };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Normalise a raw MongoDB explain document into the subset we care about.
 *
 * Handles:
 *  - Standard standalone/replica-set format  (executionStats)
 *  - Sharded format  (executionStatsByShardName)
 *  - Missing fields  (returns safe zeros + UNKNOWN)
 */
export function normalizeExplain(
  doc: MongoExplainDocument,
  includeRaw: boolean,
): NormalizedExplain {
  let raw: RawStats;

  if (doc.executionStatsByShardName && Object.keys(doc.executionStatsByShardName).length > 0) {
    raw = mergeShardStats(
      doc.executionStatsByShardName as Record<string, { executionStats?: RawStats }>,
    );
  } else if (doc.executionStats) {
    raw = doc.executionStats as RawStats;
  } else {
    raw = { nReturned: 0, totalDocsExamined: 0, executionTimeMillis: 0 };
  }

  return {
    stats: {
      nReturned: raw.nReturned ?? 0,
      totalDocsExamined: raw.totalDocsExamined ?? 0,
      executionTimeMillis: raw.executionTimeMillis ?? 0,
    },
    dominantStage: findDominantStage(raw.executionStages),
    ...(includeRaw ? { raw: doc as Record<string, unknown> } : {}),
  };
}
