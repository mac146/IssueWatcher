import { logger } from "./logger.js";
import type { Mailer } from "./mail/mailer.js";
import { summarizeIssues, type Summarizer } from "./llm/summarizer.js";
import { pollOnce } from "./poller/poller.js";
import type { IssueSource, RepoState } from "./poller/types.js";

export type StateStore = {
  load(): Promise<RepoState>;
  save(state: RepoState): Promise<void>;
};

export type WatcherDeps = {
  source: IssueSource;
  summarizer: Summarizer;
  mailer: Mailer;
  store: StateStore;
  concurrency: number;
  maxIssuesPerEmail: number;
};

/**
 * One poll cycle. State is persisted only after the digest is delivered, so a
 * Gemini/SMTP/GitHub failure means the issues are retried next cycle, never lost.
 */
export async function runCycle(deps: WatcherDeps): Promise<number> {
  const state = await deps.store.load();
  const { newIssues, nextState } = await pollOnce(deps.source, state);

  if (newIssues.length === 0) {
    logger.info("No new issues");
    await deps.store.save(nextState);
    return 0;
  }

  logger.info(`Found ${newIssues.length} new issue(s)`);
  const items = await summarizeIssues(newIssues, deps.summarizer, {
    concurrency: deps.concurrency,
    limit: deps.maxIssuesPerEmail,
  });
  await deps.mailer.sendDigest(items);
  await deps.store.save(nextState);
  logger.info(`Digest sent for ${newIssues.length} issue(s)`);
  return newIssues.length;
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
