import type {
  CircuitBreakerConfig,
  DeduplicationConfig,
  ResolvedLensConfig,
} from "../types/config.types.js";

// ---------------------------------------------------------------------------
// Sampler — probabilistic gate
// ---------------------------------------------------------------------------

/** Returns true with probability `rate` (0.0–1.0). */
export function shouldSample(rate: number): boolean {
  return Math.random() < rate;
}

// ---------------------------------------------------------------------------
// Stable key serialisation — sort object keys for deterministic output
// ---------------------------------------------------------------------------

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value as object).sort();
  const pairs = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
  );
  return `{${pairs.join(",")}}`;
}

export function buildDedupeKey(model: string, filter: Record<string, unknown>): string {
  // Wrap in array so special characters in model names cannot produce the same
  // key as a different (model, filter) pair via separator injection.
  return stableStringify([model, filter]);
}

// ---------------------------------------------------------------------------
// Deduplication cache
// ---------------------------------------------------------------------------

/**
 * Tracks recently-seen (model, filter) pairs.
 *
 * `has` and `mark` are intentionally split so the circuit breaker can be
 * checked between them — we only mark a query as "seen" once we commit to
 * explaining it, preventing the dedup window from being consumed by a
 * circuit-breaker rejection.
 */
export class DeduplicationCache {
  private readonly windowMs: number;
  private readonly cache = new Map<string, number>();

  constructor(config: Required<DeduplicationConfig>) {
    this.windowMs = config.windowMs;
  }

  has(key: string): boolean {
    const last = this.cache.get(key);
    if (last === undefined) return false;
    if (Date.now() - last < this.windowMs) return true;
    this.cache.delete(key);
    return false;
  }

  mark(key: string): void {
    this.cache.set(key, Date.now());
    this.evict();
  }

  /** Lazily removes entries whose TTL has expired to prevent unbounded growth. */
  private evict(): void {
    if (this.cache.size <= 500) return; // skip eviction when small
    const cutoff = Date.now() - this.windowMs;
    for (const [k, ts] of this.cache) {
      if (ts < cutoff) this.cache.delete(k);
    }
  }
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

/**
 * Sliding-window circuit breaker.
 *
 * Allows at most `maxExplainsPerWindow` explains within any `windowMs`
 * period. `tryAcquire` atomically checks and records the attempt.
 */
export class CircuitBreaker {
  private readonly max: number;
  private readonly windowMs: number;
  private readonly timestamps: Array<number> = [];

  constructor(config: Required<CircuitBreakerConfig>) {
    this.max = config.maxExplainsPerWindow;
    this.windowMs = config.windowMs;
  }

  tryAcquire(): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    // Drop timestamps outside the current window
    let start = 0;
    while (start < this.timestamps.length && this.timestamps[start] < cutoff) {
      start++;
    }
    if (start > 0) this.timestamps.splice(0, start);

    if (this.timestamps.length >= this.max) return false;

    this.timestamps.push(now);
    return true;
  }

  /** Remaining capacity in the current window (informational). */
  get remaining(): number {
    return Math.max(0, this.max - this.timestamps.length);
  }
}

// ---------------------------------------------------------------------------
// Explain queue — bounded concurrency, fire-and-forget
// ---------------------------------------------------------------------------

type ExplainTask = () => Promise<void>;

/**
 * Limits the number of explain() calls running in parallel.
 *
 * Tasks are enqueued and started via `setImmediate` so the Mongoose
 * query callback returns to the caller before any explain work begins.
 * This ensures explains never block the client response path.
 */
export class ExplainQueue {
  private readonly concurrency: number;
  private running = 0;
  private readonly queue: Array<ExplainTask> = [];

  constructor(concurrency: number) {
    this.concurrency = Math.max(1, concurrency);
  }

  enqueue(task: ExplainTask): void {
    this.queue.push(task);
    // Defer to the next event-loop tick so the query response is sent first.
    setImmediate(() => this.drain());
  }

  private drain(): void {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.running++;
      task().finally(() => {
        this.running--;
        this.drain();
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Unified gate
// ---------------------------------------------------------------------------

/**
 * Decides whether an explain should be triggered for this query.
 *
 * Order matters:
 *  1. Sampling   — cheapest, eliminates the majority in prod
 *  2. Dedup      — avoids re-analysing the same query in the same window
 *  3. Circuit    — protects MongoDB from explain storms
 *
 * The dedup cache is only marked *after* the circuit breaker accepts,
 * so a rejected slot is never "used up" by the dedup window.
 */
export function shouldExplain(
  key: string,
  config: ResolvedLensConfig,
  dedup: DeduplicationCache,
  breaker: CircuitBreaker,
): boolean {
  if (!shouldSample(config.sampling.rate)) return false;
  if (dedup.has(key)) return false;
  if (!breaker.tryAcquire()) return false;
  dedup.mark(key);
  return true;
}
