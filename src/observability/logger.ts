import pino, { type Logger } from "pino";

const isProduction = process.env.NODE_ENV === "production";

const rootLogger = pino({
    level: process.env.LOG_LEVEL || "info",
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
