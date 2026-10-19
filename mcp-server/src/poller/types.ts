export type Issue = {
  repo: string;
  number: number;
  title: string;
  body: string;
  user: string;
  url: string;
  labels: string[];
  comments: number;
  assignees: number;
  /** ISO timestamp. */
  createdAt: string;
  reactions: number;
  isBot: boolean;
};

export type Repo = {
  owner: string;
  name: string;
};

/** How one of the user's projects uses a package that lives in a watched repo. */
export type DependencyUse = {
  ecosystem: "npm" | "pypi";
  pkg: string;
  /** Raw version range from the manifest, e.g. "^1.6.0" or ">=2.1". */
  range: string;
  kind: "runtime" | "dev";
  /** The user's repos that declare this dependency. */
  usedBy: string[];
};

/** A repo to poll, and why we care about it. */
export type WatchTarget = Repo & {
  starred: boolean;
  dependencies: DependencyUse[];
};

export type NewIssues = {
  issues: Issue[];
  /** Highest issue/PR number seen; everything at or below it is "already known". */
  highWater: number;
};

export type IssueSource = {
  getStarredRepos(): Promise<Repo[]>;
  /**
   * Open issues numbered above `after`. With `after === null` nothing is
   * returned and only the current high-water mark is reported (silent seeding).
   */
  getNewIssues(owner: string, repo: string, after: number | null): Promise<NewIssues>;
};

/** Map of "owner/name" to the highest issue number already reported (or seeded). */
export type RepoState = Record<string, number>;
