import { loadConfig } from "./config.js";
import { GitHubAPI } from "./github/api.js";
import { GeminiSummarizer, RateLimiter } from "./llm/summarizer.js";
import { logger } from "./logger.js";
import { SmtpMailer } from "./mail/mailer.js";
import { loadState, saveState } from "./utils/state.js";
import { runCycle, watch, type WatcherDeps } from "./watcher.js";

async function main(): Promise<void> {
  const config = loadConfig();

  const deps: WatcherDeps = {
    source: new GitHubAPI(config.githubToken),
    summarizer: new GeminiSummarizer(
      config.googleApiKey,
      config.geminiModel,
      config.maxBodyChars,
      new RateLimiter(config.llmRequestsPerMinute),
    ),
    mailer: new SmtpMailer(config),
    store: {
      load: () => loadState(config.stateFile),
      save: (state) => saveState(config.stateFile, state),
    },
    concurrency: config.llmConcurrency,
    batchSize: config.llmBatchSize,
    maxIssuesPerEmail: config.maxIssuesPerEmail,
  };

  if (config.runOnce) {
    await runCycle(deps);
    return;
  }

  const controller = new AbortController();
  const stop = (sig: string) => {
    logger.info(`Received ${sig}, shutting down after the current cycle`);
    controller.abort();
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  logger.info(`Watching starred repos every ${Math.round(config.pollIntervalMs / 60_000)} min`);
  await watch(deps, config.pollIntervalMs, controller.signal);
}

main().catch((err) => {
  logger.error("Fatal error", err);
  process.exit(1);
});
