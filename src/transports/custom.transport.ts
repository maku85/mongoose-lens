import type { LensReport } from "../types/report.types.js";

/**
 * Delegates to a user-supplied handler.
 * Errors thrown by the handler propagate — the caller (dispatch) wraps
 * individual transport writes in try/catch so one failing transport does
 * not suppress the others.
 */
export class CustomTransport {
  private readonly handler: (report: LensReport) => void | Promise<void>;

  constructor(handler: (report: LensReport) => void | Promise<void>) {
    this.handler = handler;
  }

  async write(report: LensReport): Promise<void> {
    await this.handler(report);
  }
}
