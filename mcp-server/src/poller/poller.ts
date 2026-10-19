import { logger } from "../logger.js";
import type { Issue, IssueSource, RepoState, WatchTarget } from "./types.js";

export type PolledIssue = { issue: Issue; target: WatchTarget };

export type PollResult = {
  /** Issues not seen before, excluding silently seeded repos. */
  newIssues: PolledIssue[];
  /** State to persist once the new issues have been delivered. */
  nextState: RepoState;
};

/**
 * Finds issues opened since the last poll without mutating `state` or doing I/O
 * of its own.
 *
 * State is a per-repo high-water mark, so a poll normally costs one API request
 * per repo no matter how many issues the repo has.
 *
 * - A repo missing from `state` (first run, newly starred, newly depended on) is
 *   seeded silently so the user is not flooded with its backlog.
 * - If fetching a repo fails, its previous mark is kept so nothing is lost.
 * - Repos no longer watched drop out of the state.
 */
export async function pollOnce(
  source: IssueSource,
  targets: WatchTarget[],
  state: RepoState,
): Promise<PollResult> {
  const nextState: RepoState = {};
  const newIssues: PolledIssue[] = [];

  for (const target of targets) {
    const key = `${target.owner}/${target.name}`;
    const previous = state[key];

    try {
      const { issues, highWater } = await source.getNewIssues(
        target.owner,
        target.name,
        previous ?? null,
      );
      nextState[key] = Math.max(highWater, previous ?? 0);

      if (previous === undefined) {
        logger.info(`Seeded ${key} at #${highWater}`);
        continue;
      }
      for (const issue of issues) newIssues.push({ issue, target });
    } catch (err) {
      logger.warn(`Skipping ${key}: failed to fetch issues`, err);
      if (previous !== undefined) nextState[key] = previous;
    }
  }

  return { newIssues, nextState };
}
