export type Issue = {
  repo: string;
  number: number;
  title: string;
  body: string;
  user: string;
  url: string;
  labels: string[];
};

export type Repo = {
  owner: string;
  name: string;
};

export type IssueSource = {
  getStarredRepos(): Promise<Repo[]>;
  getOpenIssues(owner: string, repo: string): Promise<Issue[]>;
};

/** Map of "owner/name" to the open issue numbers already reported (or seeded). */
export type RepoState = Record<string, number[]>;
