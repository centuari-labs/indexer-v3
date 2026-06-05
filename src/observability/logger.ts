import pino, { type Logger } from "pino";

const isProduction = process.env.NODE_ENV === "production";

/**
 * M5: redact RPC URLs (which can embed API keys) from structured logs. Viem
 * surfaces the endpoint URL on thrown errors (`err.url`) and on transport
 * objects, so a raw `log.error({ err })` of a transport failure would leak the
 * full RPC URL — and any key in it — to stdout. These paths cover the common
 * shapes Viem uses (`err.url`, nested `err.cause.url`, and bare `url` fields).
 */
const REDACT_PATHS = [
    "url",
    "*.url",
    "err.url",
    "err.cause.url",
    "*.cause.url",
];

const rootLogger = pino({
    level: process.env.LOG_LEVEL || "info",
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    ...(isProduction
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

export function createLogger(service: string): Logger {
    return rootLogger.child({ service });
}

export default rootLogger;
