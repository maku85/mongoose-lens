import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { LensReport } from "../types/report.types.js";

/**
 * Appends one JSON line per report to a .jsonl file.
 *
 * The destination directory is created on first write (recursive mkdir).
 * Subsequent writes skip the mkdir call to avoid the syscall overhead.
 * `appendFile` is used for atomicity — each line is a single write(2) call,
 * which is atomic for sizes well below PIPE_BUF on any modern OS.
 */
export class JsonTransport {
  private readonly path: string;
  private dirReady = false;

  constructor(filePath: string) {
    this.path = resolve(filePath);
  }

  async write(report: LensReport): Promise<void> {
    if (!this.dirReady) {
      await mkdir(dirname(this.path), { recursive: true });
      this.dirReady = true;
    }
    await appendFile(this.path, `${JSON.stringify(report)}\n`, "utf8");
  }
}
