import pino, { type Logger } from "pino";

import { env } from "./env";

/**
 * Structured logger.
 *
 * - Local dev: pino-pretty for readable output.
 * - Production: raw JSON to stdout (parse-friendly).
 */
const isProd = process.env.NODE_ENV === "production";

export const logger: Logger = pino({
  level: env.logLevel,
  ...(isProd
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:HH:MM:ss.l",
            ignore: "pid,hostname",
          },
        },
      }),
});

/** Build a child logger with a named context (e.g. "morning"). */
export function ctx(name: string): Logger {
  return logger.child({ ctx: name });
}
