import type { LensReport } from "../types/report.types.js";
import { formatReport } from "../utils/formatter.js";

/**
 * Writes a formatted, ANSI-coloured report to process.stderr.
 * stderr keeps lens output out of application stdout / JSON log streams.
 */
export class ConsoleTransport {
  async write(report: LensReport): Promise<void> {
    process.stderr.write(formatReport(report));
  }
}
