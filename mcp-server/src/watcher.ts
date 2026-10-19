import type { Digest } from "./digest.js";
import { logger } from "./logger.js";
import type { Mailer } from "./mail/mailer.js";
import { summarizeIssues, type Summarizer } from "./llm/summarizer.js";
import { pollOnce } from "./poller/poller.js";
import type { Issue, IssueSource, RepoState, WatchTarget } from "./poller/types.js";
import { rankIssues, type ScoringMode } from "./scoring/score.js";

export type StateStore = {
  load(): Promise<RepoState>;
  save(state: RepoState): Promise<void>;
};

export type WatcherDeps = {
  source: IssueSource;
  /** Everything to poll this cycle: starred repos plus dependency source repos. */
  targets: () => Promise<WatchTarget[]>;
  summarizer: Summarizer;
  mailer: Mailer;
  store: StateStore;
  /** True for issues the user has chosen never to hear about. */
  ignore: (issue: Issue) => boolean;
  concurrency: number;
  batchSize: number;
  /** Issues scoring at least this are summarised; the rest are listed compactly. */
  minSummaryScore: number;
  /** Ranking view: what could break me, what I could fix, or both. */
  scoringMode: ScoringMode;
  /** Cap on summarised issues per email. */
  maxIssuesPerEmail: number;
  /** Preview mode: nothing is emailed or persisted, and the logs say so. */
  dryRun?: boolean;
};

/**
 * Ranks new issues and splits them into the summarised "worth a look" tier and
 * a compact "also new" list. Only the top tier costs LLM calls.
 */
export async function buildDigest(
  polled: Array<{ issue: Issue; target: WatchTarget }>,
  deps: Pick<WatcherDeps, "summarizer" | "concurrency" | "batchSize" | "minSummaryScore" | "maxIssuesPerEmail" | "scoringMode">,
): Promise<Digest> {
  const ranked = rankIssues(polled, { mode: deps.scoringMode });
  const eligible = ranked.filter((r) => r.score >= deps.minSummaryScore);
  const toSummarize = eligible.slice(0, deps.maxIssuesPerEmail);
  const other = [...eligible.slice(deps.maxIssuesPerEmail), ...ranked.filter((r) => r.score < deps.minSummaryScore)];

  const top = await summarizeIssues(toSummarize, deps.summarizer, {
    concurrency: deps.concurrency,
    batchSize: deps.batchSize,
  });
  return { top, other: other.sort((a, b) => b.score - a.score) };
}

/**
 * One poll cycle. State is persisted only after the digest is delivered, so a
 * Gemini/SMTP/GitHub failure means the issues are retried next cycle, never lost.
 */
export async function runCycle(deps: WatcherDeps): Promise<number> {
  const state = await deps.store.load();
  const targets = await deps.targets();
  const { newIssues, nextState } = await pollOnce(deps.source, targets, state);

  const relevant = newIssues.filter((p) => !deps.ignore(p.issue));
  if (relevant.length < newIssues.length) {
    logger.info(`Ignored ${newIssues.length - relevant.length} issue(s) by your ignore rules`);
  }

  if (relevant.length === 0) {
    logger.info("No new issues");
    await deps.store.save(nextState);
    return 0;
  }

  logger.info(`Found ${relevant.length} new issue(s) across ${targets.length} watched repo(s)`);
  const digest = await buildDigest(relevant, deps);
  await deps.mailer.sendDigest(digest);
  await deps.store.save(nextState);
  logger.info(
    `Digest ${deps.dryRun ? "previewed (not sent)" : "sent"}: ${digest.top.length} worth a look, ${digest.other.length} lower relevance`,
  );
  return relevant.length;
}

/** Runs cycles back to back (never overlapping) until `signal` aborts. */
export async function watch(
  deps: WatcherDeps,
  intervalMs: number,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await runCycle(deps);
    } catch (err) {
      logger.error("Poll cycle failed; will retry next interval", err);
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, intervalMs);
      signal.addEventListener("abort", done, { once: true });
      function done() {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      }
    });
  }
}
