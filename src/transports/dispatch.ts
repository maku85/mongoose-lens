import type { TransportConfig } from "../types/config.types.js";
import type { LensReport } from "../types/report.types.js";
import { ConsoleTransport } from "./console.transport.js";
import { CustomTransport } from "./custom.transport.js";
import { JsonTransport } from "./json.transport.js";

/** Minimal interface satisfied by all transport classes. */
export interface Transport {
  write(report: LensReport): Promise<void>;
}

/** Instantiate concrete transport objects from config. */
export function createTransports(configs: Array<TransportConfig>): Array<Transport> {
  return configs.map((cfg) => {
    switch (cfg.type) {
      case "console":
        return new ConsoleTransport();
      case "json":
        return new JsonTransport(cfg.path);
      case "custom":
        return new CustomTransport(cfg.handler);
    }
  });
}

/**
 * Fan-out a report to all transports in parallel.
 * A failure in one transport is caught and logged to stderr, but does not
 * prevent the other transports from receiving the report.
 */
export async function dispatch(report: LensReport, transports: Array<Transport>): Promise<void> {
  await Promise.all(
    transports.map((t) =>
      t.write(report).catch((err: unknown) => {
        process.stderr.write(`[mongoose-lens] transport error: ${String(err)}\n`);
      }),
    ),
  );
}
