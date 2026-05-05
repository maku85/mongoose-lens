// ---------------------------------------------------------------------------
// Field categorisation — ESR rule (Equality → Sort → Range)
// ---------------------------------------------------------------------------

/** MongoDB operators that signal a range predicate on a field. */
const RANGE_OPS = new Set([
  "$gt",
  "$gte",
  "$lt",
  "$lte",
  "$ne",
  "$in",
  "$nin",
  "$regex",
  "$exists",
  "$type",
  "$elemMatch",
]);

export type FieldCategory = "equality" | "range";

export interface CategorizedField {
  field: string;
  category: FieldCategory;
}

/**
 * Walk a MongoDB filter document and classify each top-level field as
 * equality or range, following the ESR index design rule.
 *
 * Handles logical operators ($and / $or / $nor) by recursing into them.
 * Skips `_id` — MongoDB always has a unique index on it.
 * Deduplicates: first occurrence wins (equality beats range for the same field).
 */
export function categorizeFilterFields(filter: Record<string, unknown>): Array<CategorizedField> {
  const seen = new Set<string>();
  const equality: Array<CategorizedField> = [];
  const range: Array<CategorizedField> = [];

  function walk(obj: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(obj)) {
      // Logical operators — recurse into each sub-condition
      if (key === "$and" || key === "$or" || key === "$nor") {
        if (Array.isArray(value)) {
          for (const sub of value) {
            if (isPlainObject(sub)) walk(sub as Record<string, unknown>);
          }
        }
        continue;
      }

      // Skip top-level MongoDB operator keys and _id
      if (key.startsWith("$") || key === "_id") continue;

      if (seen.has(key)) continue;
      seen.add(key);

      if (isRangeValue(value)) {
        range.push({ field: key, category: "range" });
      } else {
        equality.push({ field: key, category: "equality" });
      }
    }
  }

  walk(filter);
  // Equality fields first, range fields after
  return [...equality, ...range];
}

function isRangeValue(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return Object.keys(value as object).some((k) => RANGE_OPS.has(k));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Index spec builder — ESR ordering
// ---------------------------------------------------------------------------

/**
 * Build a compound index spec from categorised filter fields and an optional
 * sort document, following the Equality → Sort → Range (ESR) rule.
 *
 * Direction rules:
 *  - Equality fields: always 1
 *  - Sort fields: mirrors the sort direction from the query
 *  - Range fields: 1 by default; -1 if the sort on that same field is descending
 *
 * Returns null when the filter is empty and there are no sort fields — a full
 * collection scan is expected in that case and there is no useful index to suggest.
 */
export function buildIndexSpec(
  filterFields: Array<CategorizedField>,
  sort?: Record<string, unknown>,
): Record<string, 1 | -1> | null {
  const spec: Record<string, 1 | -1> = {};

  // 1. Equality fields — always ascending
  for (const f of filterFields) {
    if (f.category === "equality") {
      spec[f.field] = 1;
    }
  }

  // 2. Sort fields (ESR: Sort comes between Equality and Range)
  if (sort) {
    for (const [field, dir] of Object.entries(sort)) {
      if (!(field in spec)) {
        spec[field] = Number(dir) < 0 ? -1 : 1;
      }
    }
  }

  // 3. Range fields — ascending unless the sort on the same field is descending
  for (const f of filterFields) {
    if (f.category === "range" && !(f.field in spec)) {
      const sortDir = sort?.[f.field];
      spec[f.field] = sortDir !== undefined && Number(sortDir) < 0 ? -1 : 1;
    }
  }

  return Object.keys(spec).length > 0 ? spec : null;
}

// ---------------------------------------------------------------------------
// Shell command builder
// ---------------------------------------------------------------------------

/**
 * Produce a ready-to-run createIndex shell command.
 * `collectionName` must be the actual MongoDB collection name (e.g. from
 * `model.collection.collectionName`), not the Mongoose model name.
 */
export function buildIndexCommand(
  collectionName: string,
  indexSpec: Record<string, 1 | -1>,
): string {
  return `db.${collectionName}.createIndex(${JSON.stringify(indexSpec)}, { background: true })`;
}
