export type LogLevel = "debug" | "info" | "warn" | "error";

const levelPriority: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function configuredLevel(): LogLevel {
  const value = process.env.LOG_LEVEL?.toLowerCase();
  return value && value in levelPriority ? (value as LogLevel) : "info";
}

function log(level: LogLevel, message: string, details?: unknown): void {
  if (levelPriority[level] < levelPriority[configuredLevel()]) return;

  const suffix = details === undefined ? "" : ` ${JSON.stringify(details)}`;
  process.stderr.write(`${new Date().toISOString()} ${level.toUpperCase()} ${message}${suffix}\n`);
}

export const logger = {
  debug: (message: string, details?: unknown) => log("debug", message, details),
  info: (message: string, details?: unknown) => log("info", message, details),
  warn: (message: string, details?: unknown) => log("warn", message, details),
  error: (message: string, details?: unknown) => log("error", message, details),
};
