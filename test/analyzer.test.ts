import { buildReport, computeRatio, exceedsThreshold } from "../src/engine/analyzer";
import { normalizeExplain } from "../src/engine/explain";
import type { ResolvedLensConfig } from "../src/types/config.types";
import type { MongoExplainDocument } from "../src/types/explain.types";

import collscan from "./fixtures/collscan.json";
import ixscan from "./fixtures/ixscan.json";
import missingStats from "./fixtures/missing-stats.json";
import sharded from "./fixtures/sharded.json";
import sortCollscan from "./fixtures/sort-collscan.json";
import sortIxscan from "./fixtures/sort-ixscan.json";

const BASE_CONFIG: ResolvedLensConfig = {
  thresholds: { executionTimeMs: 200, docsExamined: 1000, ratio: 10 },
  sampling: { rate: 1 },
  circuitBreaker: { maxExplainsPerWindow: 10, windowMs: 10_000 },
  deduplication: { windowMs: 60_000 },
  explainConcurrency: 2,
  transport: [],
  advice: "human",
};

// ---------------------------------------------------------------------------
// normalizeExplain
// ---------------------------------------------------------------------------

describe("normalizeExplain", () => {
  it("extracts stats from a COLLSCAN explain", () => {
    const result = normalizeExplain(collscan as MongoExplainDocument, false);
    expect(result.stats.nReturned).toBe(1);
    expect(result.stats.totalDocsExamined).toBe(50_000);
    expect(result.stats.executionTimeMillis).toBe(450);
    expect(result.dominantStage).toBe("COLLSCAN");
    expect(result.raw).toBeUndefined();
  });

  it("detects FETCH as dominant stage for FETCH+IXSCAN tree", () => {
    const result = normalizeExplain(ixscan as MongoExplainDocument, false);
    expect(result.dominantStage).toBe("FETCH");
  });

  it("detects COLLSCAN even when nested under SORT (SORT+COLLSCAN tree)", () => {
    // COLLSCAN priority(4) > SORT priority(3) → COLLSCAN wins
    const result = normalizeExplain(sortCollscan as MongoExplainDocument, false);
    expect(result.dominantStage).toBe("COLLSCAN");
  });

  it("detects SORT when it wraps an IXSCAN tree (SORT+FETCH+IXSCAN)", () => {
    // SORT(3) > FETCH(2) > IXSCAN(1) → SORT wins
    const result = normalizeExplain(sortIxscan as MongoExplainDocument, false);
    expect(result.dominantStage).toBe("SORT");
  });

  it("includes raw explain when includeRaw is true", () => {
    const result = normalizeExplain(collscan as MongoExplainDocument, true);
    expect(result.raw).toBeDefined();
    expect(result.raw).toMatchObject({ executionStats: expect.any(Object) });
  });

  it("merges sharded explain: sums docs, takes slowest shard time", () => {
    const result = normalizeExplain(sharded as MongoExplainDocument, false);
    expect(result.stats.nReturned).toBe(8); // 5 + 3
    expect(result.stats.totalDocsExamined).toBe(45_000); // 25000 + 20000
    expect(result.stats.executionTimeMillis).toBe(450); // max(300, 450)
    expect(result.dominantStage).toBe("COLLSCAN");
  });

  it("returns safe zeros when executionStats is absent", () => {
    const result = normalizeExplain(missingStats as MongoExplainDocument, false);
    expect(result.stats.nReturned).toBe(0);
    expect(result.stats.totalDocsExamined).toBe(0);
    expect(result.stats.executionTimeMillis).toBe(0);
    expect(result.dominantStage).toBe("UNKNOWN");
  });
});

// ---------------------------------------------------------------------------
// computeRatio
// ---------------------------------------------------------------------------

describe("computeRatio", () => {
  it("computes examined/returned ratio", () => {
    expect(computeRatio(100, 10)).toBeCloseTo(10);
  });

  it("returns Infinity when docsReturned is 0 but docsExamined > 0", () => {
    expect(computeRatio(100, 0)).toBe(Number.POSITIVE_INFINITY);
  });

  it("returns 1 when both are 0 (empty result, empty scan)", () => {
    expect(computeRatio(0, 0)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// exceedsThreshold
// ---------------------------------------------------------------------------

describe("exceedsThreshold", () => {
  const t = BASE_CONFIG.thresholds;

  it("triggers on executionTimeMs", () => {
    expect(exceedsThreshold({ executionTimeMs: 200, docsExamined: 0, docsReturned: 1 }, t)).toBe(
      true,
    );
  });

  it("triggers on docsExamined", () => {
    expect(exceedsThreshold({ executionTimeMs: 0, docsExamined: 1000, docsReturned: 1 }, t)).toBe(
      true,
    );
  });

  it("triggers on ratio", () => {
    // docsExamined/docsReturned = 100/1 = 100 >= 10
    expect(exceedsThreshold({ executionTimeMs: 0, docsExamined: 100, docsReturned: 1 }, t)).toBe(
      true,
    );
  });

  it("does not trigger when all metrics are below thresholds", () => {
    expect(exceedsThreshold({ executionTimeMs: 50, docsExamined: 100, docsReturned: 50 }, t)).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// buildReport
// ---------------------------------------------------------------------------

describe("buildReport", () => {
  it("assembles a complete LensReport", () => {
    const explained = normalizeExplain(collscan as MongoExplainDocument, false);

    const report = buildReport({
      model: "User",
      operation: "find",
      filter: { status: "active" },
      executionTimeMs: 450,
      explain: explained,
      advice: {
        summary: "Full scan",
        suggestedIndex: { status: 1 },
        indexCommand: 'db.users.createIndex({"status":1})',
        details: "No index found.",
      },
      config: BASE_CONFIG,
    });

    expect(report.model).toBe("User");
    expect(report.operation).toBe("find");
    expect(report.executionTimeMs).toBe(450);
    expect(report.docsExamined).toBe(50_000);
    expect(report.docsReturned).toBe(1);
    expect(report.stage).toBe("COLLSCAN");
    expect(report.severity).toBe("critical"); // 450 > 200*5=1000? No, 450 < 1000. But docsExamined 50000 > 1000*5=5000 → critical
    expect(report.ratio).toBe(50_000);
    expect(report.raw).toBeUndefined(); // advice: 'human'
    expect(report.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("includes raw when advice is 'both'", () => {
    const explained = normalizeExplain(collscan as MongoExplainDocument, true);
    const report = buildReport({
      model: "User",
      operation: "find",
      filter: {},
      executionTimeMs: 300,
      explain: explained,
      advice: { summary: "", suggestedIndex: null, indexCommand: null, details: "" },
      config: { ...BASE_CONFIG, advice: "both" },
    });
    expect(report.raw).toBeDefined();
  });

  it("includes sort field when provided", () => {
    const explained = normalizeExplain(sortIxscan as MongoExplainDocument, false);
    const report = buildReport({
      model: "Order",
      operation: "find",
      filter: { status: "pending" },
      sort: { createdAt: -1 },
      executionTimeMs: 210,
      explain: explained,
      advice: { summary: "", suggestedIndex: null, indexCommand: null, details: "" },
      config: BASE_CONFIG,
    });
    expect(report.sort).toEqual({ createdAt: -1 });
  });
});
