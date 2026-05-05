import type { LensReport } from "../types/report.types.js";

// ANSI escape sequences — no external dep needed
const R = "\x1b[0m"; // reset
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";

function severityColor(s: string): string {
  return s === "critical" ? RED : YELLOW;
}

function severityIcon(s: string): string {
  return s === "critical" ? "✖" : "⚠";
}

function fmtRatio(ratio: number): string {
  return Number.isFinite(ratio) ? `${ratio.toFixed(1)}:1` : "∞:1";
}

/** Wrap text at `width` chars, indenting continuation lines with `pad`. */
function wrap(text: string, width: number, pad: string): string {
  const words = text.split(" ");
  const lines: Array<string> = [];
  let line = "";
  for (const w of words) {
    if (line.length + w.length + (line ? 1 : 0) > width && line) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines.join(`\n${pad}`);
}

const COL = 13; // label column width ("  Examined: " = 12 chars + space)
const PAD = " ".repeat(COL + 2); // continuation indent

function row(label: string, value: string): string {
  const padded = `  ${label}:`.padEnd(COL);
  return `${DIM}${padded}${R} ${value}`;
}

/**
 * Format a LensReport as a human-readable, ANSI-coloured console block.
 * Written to stderr so it does not mix with application stdout.
 */
export function formatReport(report: LensReport): string {
  const color = severityColor(report.severity);
  const icon = severityIcon(report.severity);

  const header =
    `${BOLD}${color}[mongoose-lens] ${icon} ${report.severity}${R}` +
    `  ${DIM}${report.timestamp}${R}` +
    `\n  ${BOLD}${report.model}.${report.operation}${R}` +
    `  ${report.executionTimeMs}ms`;

  const lines: Array<string> = [header, ""];

  lines.push(row("Stage", `${BOLD}${report.stage}${R}`));
  lines.push(
    row(
      "Examined",
      `${report.docsExamined.toLocaleString()} docs → returned ${report.docsReturned.toLocaleString()} (ratio ${fmtRatio(report.ratio)})`,
    ),
  );

  if (report.advice.summary) {
    lines.push(row("Summary", wrap(report.advice.summary, 72, PAD)));
  }

  if (report.advice.indexCommand) {
    lines.push(row("Index", `${CYAN}${report.advice.indexCommand}${R}`));
  }

  if (report.advice.details) {
    lines.push(row("Details", wrap(report.advice.details, 72, PAD)));
  }

  if (report.filter && Object.keys(report.filter).length > 0) {
    lines.push(row("Filter", JSON.stringify(report.filter)));
  }

  if (report.sort && Object.keys(report.sort).length > 0) {
    lines.push(row("Sort", JSON.stringify(report.sort)));
  }

  lines.push("");
  return lines.join("\n");
}
