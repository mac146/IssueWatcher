import type { Issue } from "../poller/types.js";

export type IgnoreRules = {
  /** "owner/name" patterns where a star matches any characters, e.g. "100xdevs-*" plus a slash and star. */
  repos: string[];
  /** Exact label names, case-insensitive. */
  labels: string[];
};

const toRegExp = (pattern: string) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i");

export function buildIgnore(rules: IgnoreRules): (issue: Issue) => boolean {
  const repoPatterns = rules.repos.map(toRegExp);
  const labels = new Set(rules.labels.map((l) => l.toLowerCase()));
  return (issue) =>
    repoPatterns.some((re) => re.test(issue.repo)) ||
    issue.labels.some((l) => labels.has(l.toLowerCase()));
}
