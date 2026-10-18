import { logger } from "../logger.js";
import type { Issue, IssueSource, RepoState } from "./types.js";

export type PollResult = {
  /** Issues not seen before, excluding silently seeded repos. */
  newIssues: Issue[];
  /** State to persist once the new issues have been delivered. */
  nextState: RepoState;
};

/**
 * Compares current open issues against `state` without mutating it or doing I/O.
 *
 * - A repo missing from `state` (first run, or newly starred) is seeded silently
 *   so the user is not flooded with its entire backlog.
 * - If fetching a repo fails, its previous state is kept so nothing is lost or
 *   re-reported.
 * - Unstarred repos drop out of the state.
 */
export async function pollOnce(source: IssueSource, state: RepoState): Promise<PollResult> {
  const repos = await source.getStarredRepos();
  const nextState: RepoState = {};
  const newIssues: Issue[] = [];

  for (const { owner, name } of repos) {
    const key = `${owner}/${name}`;
    const previous = state[key];

    let issues: Issue[];
    try {
      issues = await source.getOpenIssues(owner, name);
    } catch (err) {
      logger.warn(`Skipping ${key}: failed to fetch issues`, err);
      if (previous) nextState[key] = previous;
      continue;
    }

    nextState[key] = issues.map((i) => i.number);
    if (!previous) {
      logger.info(`Seeded ${key} with ${issues.length} existing open issues`);
      continue;
    }

    const seen = new Set(previous);
    for (const issue of issues) {
      if (!seen.has(issue.number)) newIssues.push(issue);
    }
  }

  return { newIssues, nextState };
}
