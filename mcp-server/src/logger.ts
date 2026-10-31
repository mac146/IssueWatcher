type Level = "info" | "warn" | "error";

let allToStderr = false;

/**
 * Sends every log line to stderr. An MCP server that speaks over stdio must keep
 * stdout for protocol messages only: a single stray log line there corrupts the
 * stream and the client disconnects.
 */
export function logToStderr(): void {
  allToStderr = true;
}

function log(level: Level, msg: string, meta?: unknown): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${msg}`;
  const sink = allToStderr ? console.error : level === "info" ? console.log : console[level];
  if (meta === undefined) sink(line);
  // Stack traces are for real faults. A warning is an expected failure (a dropped connection, a
  // missing file) and a one-line message says everything a user needs.
  else if (meta instanceof Error) sink(line, level === "error" ? meta.stack ?? meta.message : meta.message);
  else sink(line, meta);
}

export const logger = {
  info: (msg: string, meta?: unknown) => log("info", msg, meta),
  warn: (msg: string, meta?: unknown) => log("warn", msg, meta),
  error: (msg: string, meta?: unknown) => log("error", msg, meta),
};
