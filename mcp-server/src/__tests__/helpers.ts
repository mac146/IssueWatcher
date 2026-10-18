import type { Issue, IssueSource, Repo } from "../poller/types.js";

export const issue = (repo: string, number: number): Issue => ({
  repo,
  number,
  title: `t${number}`,
  body: "",
  user: "u",
  url: `https://github.com/${repo}/issues/${number}`,
  labels: [],
});

export function fakeSource(data: Record<string, Issue[] | Error>): IssueSource {
  return {
    async getStarredRepos(): Promise<Repo[]> {
      return Object.keys(data).map((k) => {
        const [owner, name] = k.split("/");
        return { owner: owner!, name: name! };
      });
    },
    async getOpenIssues(owner, name) {
      const v = data[`${owner}/${name}`]!;
      if (v instanceof Error) throw v;
      return v;
    },
  };
}
