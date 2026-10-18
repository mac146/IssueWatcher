type Level = "info" | "warn" | "error";

function log(level: Level, msg: string, meta?: unknown): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${msg}`;
  const sink = level === "info" ? console.log : console[level];
  if (meta === undefined) sink(line);
  else sink(line, meta instanceof Error ? meta.stack ?? meta.message : meta);
}

export const logger = {
  info: (msg: string, meta?: unknown) => log("info", msg, meta),
  warn: (msg: string, meta?: unknown) => log("warn", msg, meta),
  error: (msg: string, meta?: unknown) => log("error", msg, meta),
};
