#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { logger, logToStderr } from "../logger.js";
import { runCheck } from "./diagnose.js";
import { buildRuntime, packageVersion } from "./runtime.js";
import { createIssueWatcherServer } from "./server.js";
import { loadMcpSettings, SETUP_HELP } from "./settings.js";

const USAGE = `issuewatcher-mcp: an MCP server that ranks GitHub issues for your AI assistant

Usage:
  issuewatcher-mcp            start the server (speaks MCP over stdio; your AI app runs this)
  issuewatcher-mcp --check    test your setup in a terminal
  issuewatcher-mcp --version  print the version

Environment:
  GITHUB_TOKEN   required. A GitHub personal access token (read-only is enough)
  SCORING_MODE   contributor | consumer | both (default both)
  See https://github.com/mac146/IssueWatcher for all options.
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const version = packageVersion();

  if (args.includes("--version") || args.includes("-v")) {
    console.log(version);
    return;
  }
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return;
  }

  const { settings, problems } = loadMcpSettings();

  if (args.includes("--check")) {
    logToStderr(); // keep the report on stdout clean; log lines go to stderr
    process.exitCode = await runCheck(settings, problems, version);
    return;
  }

  // From here stdout carries only MCP messages. A stray log line there would corrupt the stream,
  // so every log goes to stderr, and console.log is redirected in case a dependency uses it.
  logToStderr();
  console.log = (...parts: unknown[]) => console.error(...parts);

  for (const p of problems) logger.warn(p);

  let radar = null;
  if (settings.githubToken) {
    radar = buildRuntime({ ...settings, githubToken: settings.githubToken }).radar;
  } else {
    logger.warn(`No GITHUB_TOKEN set. ${SETUP_HELP}`);
  }

  const server = createIssueWatcherServer({ radar, version, settingsProblems: problems });

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down`);
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  // The client closing our stdin is how a stdio server is told to stop.
  process.stdin.once("end", () => process.exit(0));
  process.on("unhandledRejection", (reason) => logger.error("Unhandled rejection", reason));

  await server.connect(new StdioServerTransport());
  // Start loading in the background: by the time the user asks their first question it is usually ready.
  if (radar && settings.prefetch) void radar.warmUp();
  logger.info(`issuewatcher-mcp ${version} ready (mode ${settings.mode}, ${radar ? "token set" : "NO TOKEN"})`);
}

main().catch((err) => {
  logToStderr();
  logger.error("Fatal error", err);
  process.exit(1);
});
