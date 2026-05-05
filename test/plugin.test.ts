import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Schema, type Model } from "mongoose";
import { mongooseLens } from "../src/plugin";
import type { LensReport } from "../src/types/report.types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Resolves on the first report delivered to the custom transport. */
function captureReport(): {
  promise: Promise<LensReport>;
  handler: (r: LensReport) => void;
} {
  let resolve: (r: LensReport) => void;
  const promise = new Promise<LensReport>((res) => {
    resolve = res;
  });
  return { promise, handler: (r) => resolve(r) };
}

/** Wait for all `setImmediate` + microtask callbacks to drain. */
async function flushAsync(ms = 200): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Setup — shared in-memory MongoDB instance
// ---------------------------------------------------------------------------

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  // Drop all collections between tests to avoid cross-test state
  const db = mongoose.connection.db;
  if (db) {
    const collections = await db.listCollections().toArray();
    await Promise.all(collections.map((c) => db.dropCollection(c.name)));
  }
  // Clear Mongoose model registry
  for (const name of Object.keys(mongoose.models)) {
    mongoose.deleteModel(name);
  }
});

// ---------------------------------------------------------------------------
// Factory — creates a fresh Model with the lens plugin wired up
// ---------------------------------------------------------------------------

function makeUserModel(
  onReport: (r: LensReport) => void,
  extraConfig: Parameters<typeof mongooseLens>[0] = {},
): Model<{ name: string; status: string; age: number }> {
  const schema = new Schema({
    name: String,
    status: String,
    age: Number,
  });

  schema.plugin(
    mongooseLens({
      thresholds: { executionTimeMs: 0, docsExamined: 0, ratio: 0 },
      sampling: { rate: 1 },
      transport: [{ type: "custom", handler: onReport }],
      ...extraConfig,
    }),
  );

  return mongoose.model("User", schema) as Model<{ name: string; status: string; age: number }>;
}

// ---------------------------------------------------------------------------
// Automatic middleware — slow query detection
// ---------------------------------------------------------------------------

describe("automatic query interception", () => {
  it("emits a LensReport for a find that exceeds thresholds", async () => {
    const { promise, handler } = captureReport();
    const User = makeUserModel(handler);

    await User.insertMany([
      { name: "Alice", status: "active", age: 25 },
      { name: "Bob", status: "inactive", age: 30 },
    ]);

    await User.find({ status: "active" });
    const report = await promise;

    expect(report.model).toBe("User");
    expect(report.operation).toBe("find");
    expect(report.filter).toMatchObject({ status: "active" });
    expect(typeof report.executionTimeMs).toBe("number");
    expect(["warning", "critical"]).toContain(report.severity);
    expect(report.advice.summary).toBeTruthy();
    expect(report.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("report contains a COLLSCAN stage when no index exists", async () => {
    const { promise, handler } = captureReport();
    const User = makeUserModel(handler);

    await User.create({ name: "Carol", status: "active", age: 22 });
    await User.find({ status: "active" });

    const report = await promise;
    expect(report.stage).toBe("COLLSCAN");
  });

  it("report includes a suggestedIndex for a filter with known fields", async () => {
    const { promise, handler } = captureReport();
    const User = makeUserModel(handler);

    await User.create({ name: "Dan", status: "active", age: 35 });
    await User.find({ status: "active" });

    const report = await promise;
    expect(report.advice.suggestedIndex).not.toBeNull();
    expect(report.advice.indexCommand).toContain("createIndex");
  });

  it("does not emit a report when executionTimeMs is below threshold", async () => {
    const reports: Array<LensReport> = [];
    const schema = new Schema({ name: String });
    schema.plugin(
      mongooseLens({
        thresholds: { executionTimeMs: 99_999, docsExamined: 99_999, ratio: 99_999 },
        sampling: { rate: 1 },
        transport: [
          {
            type: "custom",
            handler: (r) => {
              reports.push(r);
            },
          },
        ],
      }),
    );
    const M = mongoose.model("NoReport", schema);

    await M.create({ name: "X" });
    await M.find({ name: "X" });
    await flushAsync(300);

    expect(reports).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

describe("sampling", () => {
  it("skips explain when rate is 0", async () => {
    const reports: Array<LensReport> = [];
    const User = makeUserModel((r) => reports.push(r), { sampling: { rate: 0 } });

    await User.create({ name: "Eve", status: "active", age: 28 });
    await User.find({ status: "active" });
    await flushAsync(300);

    expect(reports).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

describe("circuit breaker", () => {
  it("stops firing after maxExplainsPerWindow is reached", async () => {
    const reports: Array<LensReport> = [];
    const schema = new Schema({ name: String, status: String });
    schema.plugin(
      mongooseLens({
        thresholds: { executionTimeMs: 0, docsExamined: 0, ratio: 0 },
        sampling: { rate: 1 },
        circuitBreaker: { maxExplainsPerWindow: 2, windowMs: 60_000 },
        deduplication: { windowMs: 0 }, // disable dedup to test breaker alone
        transport: [
          {
            type: "custom",
            handler: (r) => {
              reports.push(r);
            },
          },
        ],
      }),
    );
    const M = mongoose.model("CB", schema);

    await M.create({ name: "A", status: "x" });

    // Fire 5 queries with different filters to bypass dedup
    for (let i = 0; i < 5; i++) {
      await M.find({ name: String(i) });
    }
    await flushAsync(500);

    // Circuit breaker allows at most 2 explains in this window
    expect(reports.length).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

describe("deduplication", () => {
  it("does not re-analyse the same filter within the dedup window", async () => {
    const reports: Array<LensReport> = [];
    const schema = new Schema({ status: String });
    schema.plugin(
      mongooseLens({
        thresholds: { executionTimeMs: 0, docsExamined: 0, ratio: 0 },
        sampling: { rate: 1 },
        deduplication: { windowMs: 60_000 },
        transport: [
          {
            type: "custom",
            handler: (r) => {
              reports.push(r);
            },
          },
        ],
      }),
    );
    const M = mongoose.model("Dedup", schema);

    await M.create({ status: "active" });

    // Same filter twice in quick succession
    await M.find({ status: "active" });
    await M.find({ status: "active" });
    await flushAsync(500);

    expect(reports).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// .skipLens() opt-out helper
// ---------------------------------------------------------------------------

describe(".skipLens() query helper", () => {
  it("suppresses the automatic LensReport for the skipped query", async () => {
    const reports: Array<LensReport> = [];
    const User = makeUserModel((r) => reports.push(r));

    await User.create({ name: "Skip", status: "active", age: 20 });

    // Skipped query — should produce no report
    await User.find({ status: "active" }).skipLens();
    await flushAsync(300);

    expect(reports).toHaveLength(0);
  });

  it("only suppresses the query it is called on", async () => {
    const reports: Array<LensReport> = [];
    const User = makeUserModel((r) => reports.push(r), {
      deduplication: { windowMs: 0 },
    });

    await User.create({ name: "Skip2", status: "active", age: 21 });

    await User.find({ status: "active" }).skipLens();
    await User.find({ status: "active" });
    await flushAsync(500);

    // Only the second query should produce a report
    expect(reports).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// .lens() on-demand helper
// ---------------------------------------------------------------------------

describe(".lens() query helper", () => {
  it("returns a LensReport without executing the query as a data fetch", async () => {
    const User = makeUserModel(() => {});
    await User.create({ name: "Frank", status: "active", age: 40 });

    const report = await User.find({ status: "active" }).lens();

    expect(report).toBeDefined();
    expect(report.model).toBe("User");
    expect(report.stage).toBe("COLLSCAN");
    expect(report.advice.suggestedIndex).not.toBeNull();
  });

  it("lens() report reflects sort in the index suggestion", async () => {
    const User = makeUserModel(() => {});
    await User.create({ name: "Grace", status: "active", age: 27 });

    const report = await User.find({ status: "active" }).sort({ age: -1 }).lens();

    // ESR: status (equality) → age (sort, descending)
    expect(report.advice.suggestedIndex).toMatchObject({ status: 1, age: -1 });
  });
});
