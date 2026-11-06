import pino, { type Logger } from "pino";

export type { Logger };

export function createLogger(service: string, level = "info"): Logger {
  return pino({
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        "*.authorization",
        "*.Authorization",
        "*.token",
        "*.botToken",
        "*.contextToken",
        "*.internalToken",
        "req.headers.authorization",
        "req.headers['x-xiaoqi-internal']",
      ],
      censor: "[redacted]",
    },
  });
}
