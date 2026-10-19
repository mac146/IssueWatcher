import path from "node:path";
import { loadConfig, type Config } from "./config.js";
import { CachedDiscovery, discoverDependencies } from "./deps/discovery.js";
import { HttpRegistry } from "./deps/registry.js";
import { GitHubAPI } from "./github/api.js";
import { GeminiSummarizer, RateLimiter, type Summarizer } from "./llm/summarizer.js";
import { logger } from "./logger.js";
import { renderText, SmtpMailer, type Mailer } from "./mail/mailer.js";
import type { IssueSource, NewIssues } from "./poller/types.js";
import { buildIgnore } from "./scoring/filters.js";
import { buildTargets } from "./targets.js";
import { loadState, saveState } from "./utils/state.js";
import { runCycle, watch, type WatcherDeps } from "./watcher.js";

const DEPENDENCY_TTL_MS = 24 * 3_600_000;

function targetProvider(config: Config, github: GitHubAPI): WatcherDeps["targets"] {
  const discovery = config.dependencyScan
    ? new CachedDiscovery(
        () =>
          discoverDependencies(github, new HttpRegistry(), {
            repos: config.dependencyRepos,
            maxRepos: config.maxDependencyRepos,
            maxDependencies: config.maxDependencies,
            activeWithinDays: 365,
          }),
        path.join(path.dirname(config.stateFile), "dependencies.json"),
        DEPENDENCY_TTL_MS,
      )
    : null;

  return async () => buildTargets(await github.getStarredRepos(), (await discovery?.get()) ?? {});
}

/** Dry run: show the newest open issues per repo as if they were new; touch nothing. */
function previewDeps(config: Config, github: GitHubAPI, targets: WatcherDeps["targets"]): Partial<WatcherDeps> {
  const source: IssueSource = {
    getStarredRepos: () => github.getStarredRepos(),
    async getNewIssues(owner, repo): Promise<NewIssues> {
      return { issues: await github.getRecentOpenIssues(owner, repo, config.previewPerRepo), highWater: 0 };
    },
  };
  const summarizer: Summarizer = {
    summarizeBatch: async (issues) => issues.map(() => "(preview: AI summary skipped)"),
  };
  const mailer: Mailer = {
    async sendDigest(digest) {
      console.log(`\n${renderText(digest)}`);
    },
  };
  return {
    source,
    summarizer,
    mailer,
    store: {
      // Every watched repo "was last seen at #0", so all fetched issues count as new.
      load: async () => Object.fromEntries((await targets()).map((t) => [`${t.owner}/${t.name}`, 0])),
      save: async () => undefined,
    },
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const github = new GitHubAPI(config.githubToken);
  const targets = targetProvider(config, github);

  const deps: WatcherDeps = {
    source: github,
    targets,
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
    ignore: buildIgnore({ repos: config.ignoreRepos, labels: config.ignoreLabels }),
    concurrency: config.llmConcurrency,
    batchSize: config.llmBatchSize,
    scoringMode: config.scoringMode,
    minSummaryScore: config.minSummaryScore,
    maxIssuesPerEmail: config.maxIssuesPerEmail,
  };

  if (config.dryRun) {
    logger.info("DRY_RUN: ranking recent issues only; no LLM calls, email or state changes");
    await runCycle({ ...deps, ...previewDeps(config, github, targets), dryRun: true });
    return;
  }

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

  logger.info(`Watching every ${Math.round(config.pollIntervalMs / 60_000)} min`);
  await watch(deps, config.pollIntervalMs, controller.signal);
}

main().catch((err) => {
  logger.error("Fatal error", err);
  process.exit(1);
});
