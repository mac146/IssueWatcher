import type { Issue, IssueSource, Repo, WatchTarget } from "../poller/types.js";

export const issue = (repo: string, number: number, extra: Partial<Issue> = {}): Issue => ({
  repo,
  number,
  title: `Problem number ${number} in the app`,
  body: "a reasonably detailed body that is long enough",
  user: "u",
  url: `https://github.com/${repo}/issues/${number}`,
  labels: [],
  comments: 0,
  assignees: 0,
  createdAt: "2026-01-01T00:00:00Z",
  reactions: 0,
  isBot: false,
  ...extra,
});

export const starred = (repo: string): WatchTarget => {
  const [owner, name] = repo.split("/");
  return { owner: owner!, name: name!, starred: true, dependencies: [] };
};

/** Fake GitHub: `data` maps "owner/name" to its open issues, or an Error to simulate failure. */
export function fakeSource(data: Record<string, Issue[] | Error>): IssueSource {
  return {
    async getStarredRepos(): Promise<Repo[]> {
      return Object.keys(data).map((k) => {
        const [owner, name] = k.split("/");
        return { owner: owner!, name: name! };
      });
    },
    async getNewIssues(owner, name, after) {
      const v = data[`${owner}/${name}`]!;
      if (v instanceof Error) throw v;
      const highest = v.reduce((m, i) => Math.max(m, i.number), 0);
      if (after === null) return { issues: [], highWater: highest };
      return { issues: v.filter((i) => i.number > after), highWater: Math.max(highest, after) };
    },
  };
}
