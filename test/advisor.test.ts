import { buildAdvice } from "../src/engine/advisor";
import { normalizeExplain } from "../src/engine/explain";
import type { ResolvedLensConfig } from "../src/types/config.types";
import type { MongoExplainDocument } from "../src/types/explain.types";
import { buildIndexSpec, categorizeFilterFields } from "../src/utils/index-suggester";

import collscan from "./fixtures/collscan.json";
import ixscanHighRatio from "./fixtures/ixscan-high-ratio.json";
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
// categorizeFilterFields
// ---------------------------------------------------------------------------

describe("categorizeFilterFields", () => {
  it("classifies scalar values as equality", () => {
    const fields = categorizeFilterFields({ status: "active", role: "admin" });
    expect(fields).toEqual([
      { field: "status", category: "equality" },
      { field: "role", category: "equality" },
    ]);
  });

  it("classifies $gte / $lte objects as range", () => {
    const fields = categorizeFilterFields({
      createdAt: { $gte: new Date("2024-01-01") },
    });
    expect(fields).toEqual([{ field: "createdAt", category: "range" }]);
  });

  it("classifies $in as range", () => {
    const fields = categorizeFilterFields({ status: { $in: ["a", "b"] } });
    expect(fields).toEqual([{ field: "status", category: "range" }]);
  });

  it("puts equality before range in the output", () => {
    const fields = categorizeFilterFields({
      age: { $gte: 18 },
      status: "active",
    });
    expect(fields[0]).toEqual({ field: "status", category: "equality" });
    expect(fields[1]).toEqual({ field: "age", category: "range" });
  });

  it("recurses into $and operator", () => {
    const fields = categorizeFilterFields({
      $and: [{ status: "active" }, { age: { $gte: 18 } }],
    });
    expect(fields).toContainEqual({ field: "status", category: "equality" });
    expect(fields).toContainEqual({ field: "age", category: "range" });
  });

  it("recurses into $or operator", () => {
    const fields = categorizeFilterFields({
      $or: [{ status: "a" }, { status: "b" }],
    });
    expect(fields).toEqual([{ field: "status", category: "equality" }]);
  });

  it("deduplicates: first occurrence wins", () => {
    const fields = categorizeFilterFields({
      status: "active",
      $and: [{ status: { $in: ["inactive"] } }],
    });
    // 'status' first seen as equality → stays equality
    expect(fields).toEqual([{ field: "status", category: "equality" }]);
  });

  it("skips _id", () => {
    const fields = categorizeFilterFields({ _id: "abc", name: "Alice" });
    expect(fields).toEqual([{ field: "name", category: "equality" }]);
  });

  it("returns empty array for empty filter", () => {
    expect(categorizeFilterFields({})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildIndexSpec — ESR rule
// ---------------------------------------------------------------------------

describe("buildIndexSpec", () => {
  it("returns null for empty filter and no sort", () => {
    expect(buildIndexSpec([])).toBeNull();
  });

  it("builds equality-only index, all ascending", () => {
    const fields = categorizeFilterFields({ status: "active", role: "user" });
    expect(buildIndexSpec(fields)).toEqual({ status: 1, role: 1 });
  });

  it("inserts sort fields between equality and range (ESR)", () => {
    const fields = categorizeFilterFields({
      status: "active",
      age: { $gte: 18 },
    });
    const spec = buildIndexSpec(fields, { createdAt: -1 });
    const keys = Object.keys(spec!);
    expect(keys.indexOf("status")).toBeLessThan(keys.indexOf("createdAt"));
    expect(keys.indexOf("createdAt")).toBeLessThan(keys.indexOf("age"));
    expect(spec).toEqual({ status: 1, createdAt: -1, age: 1 });
  });

  it("mirrors descending sort direction", () => {
    const fields = categorizeFilterFields({ status: "active" });
    const spec = buildIndexSpec(fields, { createdAt: -1 });
    expect(spec!.createdAt).toBe(-1);
  });

  it("gives range field -1 when sort on same field is descending", () => {
    const fields = categorizeFilterFields({ age: { $gte: 18 } });
    const spec = buildIndexSpec(fields, { age: -1 });
    // age appears as sort first (E→S→R), direction -1 from sort
    expect(spec!.age).toBe(-1);
  });

  it("range fields default to ascending when no sort", () => {
    const fields = categorizeFilterFields({ createdAt: { $gte: new Date() } });
    const spec = buildIndexSpec(fields);
    expect(spec!.createdAt).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// buildAdvice
// ---------------------------------------------------------------------------

describe("buildAdvice", () => {
  it("produces a non-empty summary and index command for COLLSCAN", () => {
    const explain = normalizeExplain(collscan as MongoExplainDocument, false);
    const advice = buildAdvice({
      model: "User",
      collectionName: "users",
      operation: "find",
      filter: { status: "active" },
      explain,
      executionTimeMs: 450,
      config: BASE_CONFIG,
    });

    expect(advice.summary).toContain("collection scan");
    expect(advice.suggestedIndex).toEqual({ status: 1 });
    expect(advice.indexCommand).toContain("createIndex");
    expect(advice.indexCommand).toContain('"status":1');
    expect(advice.details).toBeTruthy();
  });

  it("produces a SORT-specific summary for sort-over-ixscan stage", () => {
    const explain = normalizeExplain(sortIxscan as MongoExplainDocument, false);
    const advice = buildAdvice({
      model: "Order",
      collectionName: "orders",
      operation: "find",
      filter: { status: "pending" },
      sort: { createdAt: -1 },
      explain,
      executionTimeMs: 210,
      config: BASE_CONFIG,
    });

    expect(advice.summary).toContain("sort");
    // ESR: status (equality) → createdAt (sort)
    expect(advice.suggestedIndex).toMatchObject({ status: 1, createdAt: -1 });
  });

  it("returns null suggestedIndex for empty filter", () => {
    const explain = normalizeExplain(collscan as MongoExplainDocument, false);
    const advice = buildAdvice({
      model: "User",
      collectionName: "users",
      operation: "find",
      filter: {},
      explain,
      executionTimeMs: 450,
      config: BASE_CONFIG,
    });

    expect(advice.suggestedIndex).toBeNull();
    expect(advice.indexCommand).toBeNull();
  });

  it("returns empty text fields when advice mode is 'raw'", () => {
    const explain = normalizeExplain(collscan as MongoExplainDocument, false);
    const advice = buildAdvice({
      model: "User",
      collectionName: "users",
      operation: "find",
      filter: { status: "active" },
      explain,
      executionTimeMs: 450,
      config: { ...BASE_CONFIG, advice: "raw" },
    });

    expect(advice.summary).toBe("");
    expect(advice.details).toBe("");
    // but suggestedIndex is still computed
    expect(advice.suggestedIndex).toEqual({ status: 1 });
  });

  it("includes FETCH summary for high-ratio ixscan", () => {
    const explain = normalizeExplain(ixscanHighRatio as MongoExplainDocument, false);
    const advice = buildAdvice({
      model: "Product",
      collectionName: "products",
      operation: "find",
      filter: { category: "electronics" },
      explain,
      executionTimeMs: 320,
      config: BASE_CONFIG,
    });

    expect(advice.summary).toContain("fetch ratio");
    expect(advice.suggestedIndex).toEqual({ category: 1 });
  });
});
