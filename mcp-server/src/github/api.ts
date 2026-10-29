import axios, { AxiosError, AxiosInstance, AxiosResponse } from "axios";
import { logger } from "../logger.js";
import type { Issue, IssueSource, NewIssues, Repo } from "../poller/types.js";

const PER_PAGE = 100;
const MAX_PAGES = 50; // hard stop: 5,000 items per listing
const MAX_RETRIES = 3;
const MAX_RATE_LIMIT_WAIT_MS = 120_000;

type RawIssue = {
  number: number;
  comments?: number;
  assignees?: unknown[];
  created_at?: string;
  reactions?: { total_count?: number };
  title: string;
  body?: string | null;
  html_url: string;
  state: string;
  pull_request?: unknown;
  user?: { login?: string; type?: string } | null;
  labels?: Array<string | { name?: string }>;
};

type RawRepo = { name: string; owner: { login: string }; fork?: boolean; archived?: boolean; pushed_at?: string };

export type OwnRepo = Repo & { pushedAt: string };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function nextLink(res: AxiosResponse): string | null {
  const header = res.headers["link"];
  if (typeof header !== "string") return null;
  const match = header.split(",").find((part) => /rel="next"/.test(part));
  return match?.match(/<([^>]+)>/)?.[1] ?? null;
}

/** Milliseconds to wait before retrying, or null if the failure is not retryable. */
function retryDelay(err: AxiosError, attempt: number): number | null {
  const status = err.response?.status;
  if (!err.response) return 500 * 2 ** attempt; // network error / timeout

  const headers = err.response.headers;
  const retryAfter = Number(headers["retry-after"]);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;

  const rateLimited =
    status === 429 || (status === 403 && headers["x-ratelimit-remaining"] === "0");
  if (rateLimited) {
    const reset = Number(headers["x-ratelimit-reset"]);
    if (Number.isFinite(reset)) return Math.max(0, reset * 1000 - Date.now()) + 1000;
    return 60_000;
  }
  if (status !== undefined && status >= 500) return 500 * 2 ** attempt;
  return null;
}

export class GitHubAPI implements IssueSource {
  private readonly client: AxiosInstance;

  /** `baseUrl` is only overridden in tests (a local stub) and for GitHub Enterprise. */
  constructor(token: string, client?: AxiosInstance, baseUrl = "https://api.github.com") {
    this.client =
      client ??
      axios.create({
        baseURL: baseUrl,
        timeout: 20_000,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "IssueWatcher",
        },
      });
  }

  private async get<T>(url: string, params?: Record<string, unknown>): Promise<AxiosResponse<T>> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.client.get<T>(url, { params });
      } catch (err) {
        const delay = axios.isAxiosError(err) ? retryDelay(err, attempt) : null;
        if (delay === null || attempt >= MAX_RETRIES || delay > MAX_RATE_LIMIT_WAIT_MS) throw err;
        logger.warn(`GitHub request failed (${url}), retrying in ${Math.round(delay / 1000)}s`);
        await sleep(delay);
      }
    }
  }

  private async paginate<T>(
    url: string,
    params: Record<string, unknown>,
    opts: { maxPages?: number; stopAfter?: (page: T[]) => boolean } = {},
  ): Promise<T[]> {
    const maxPages = opts.maxPages ?? MAX_PAGES;
    const items: T[] = [];
    let next: string | null = url;
    let query: Record<string, unknown> | undefined = { per_page: PER_PAGE, ...params };

    for (let page = 0; next && page < maxPages; page++) {
      const res: AxiosResponse<T[]> = await this.get<T[]>(next, query);
      items.push(...res.data);
      if (opts.stopAfter?.(res.data)) return items;
      next = nextLink(res);
      query = undefined; // the "next" URL already carries the query string
    }
    if (next) logger.warn(`Pagination cap reached for ${url}; results truncated`);
    return items;
  }

  /** Throws on failure so callers never mistake an outage for "no data". */
  async getStarredRepos(): Promise<Repo[]> {
    const raw = await this.paginate<RawRepo>("/user/starred", {});
    return raw.map((r) => ({ owner: r.owner.login, name: r.name }));
  }

  async getNewIssues(owner: string, repo: string, after: number | null): Promise<NewIssues> {
    const path = `/repos/${owner}/${repo}/issues`;

    if (after === null) {
      // Seeding: only the newest item (issue or PR, open or closed) is needed.
      const res = await this.get<RawIssue[]>(path, {
        state: "all",
        sort: "created",
        direction: "desc",
        per_page: 1,
      });
      return { issues: [], highWater: res.data[0]?.number ?? 0 };
    }

    // Newest first; once a page reaches a number we already know, older items are known too.
    const raw = await this.paginate<RawIssue>(
      path,
      { state: "open", sort: "created", direction: "desc" },
      { maxPages: 10, stopAfter: (page) => page.some((i) => i.number <= after) },
    );

    const fresh = [...new Map(raw.map((i) => [i.number, i])).values()].filter(
      (i) => i.number > after,
    );
    return {
      issues: fresh.filter((i) => !i.pull_request).map((i) => toIssue(i, `${owner}/${repo}`)),
      highWater: fresh.reduce((max, i) => Math.max(max, i.number), after),
    };
  }

  /** Newest open issues (no PRs), used by the preview command. */
  async getRecentOpenIssues(owner: string, repo: string, limit: number): Promise<Issue[]> {
    const res = await this.get<RawIssue[]>(`/repos/${owner}/${repo}/issues`, {
      state: "open",
      sort: "created",
      direction: "desc",
      per_page: Math.min(100, limit * 3),
    });
    return res.data
      .filter((i) => !i.pull_request)
      .slice(0, limit)
      .map((i) => toIssue(i, `${owner}/${repo}`));
  }

  /**
   * Open issues created at or after `since`, newest first, at most `max`. Pull requests are
   * excluded. Paging stops at the first page that reaches an older issue, so a quiet repo
   * costs one request.
   */
  async getIssuesSince(owner: string, repo: string, since: Date, max: number): Promise<Issue[]> {
    const sinceMs = since.getTime();
    const perPage = Math.max(1, Math.min(PER_PAGE, max * 2));
    const raw = await this.paginate<RawIssue>(
      `/repos/${owner}/${repo}/issues`,
      { state: "open", sort: "created", direction: "desc", per_page: perPage },
      {
        maxPages: 5,
        stopAfter: (page) => page.some((i) => Date.parse(i.created_at ?? "") < sinceMs),
      },
    );
    return raw
      .filter((i) => !i.pull_request && Date.parse(i.created_at ?? "") >= sinceMs)
      .slice(0, max)
      .map((i) => toIssue(i, `${owner}/${repo}`));
  }

  /** Remaining API calls and when the window resets; used by the setup check. */
  async getRateLimit(): Promise<{ limit: number; remaining: number; resetAt: Date }> {
    const res = await this.get<{ resources?: { core?: { limit: number; remaining: number; reset: number } } }>("/rate_limit");
    const core = res.data.resources?.core;
    if (!core) throw new Error("Unexpected rate limit response");
    return { limit: core.limit, remaining: core.remaining, resetAt: new Date(core.reset * 1000) };
  }

  /** The authenticated user's login, used by the setup check to confirm the token works. */
  async getLogin(): Promise<string> {
    const res = await this.get<{ login?: string }>("/user");
    return res.data.login ?? "unknown";
  }

  /** One issue by number, or null if it no longer exists or is a pull request. */
  async getIssue(owner: string, repo: string, number: number): Promise<Issue | null> {
    try {
      const res = await this.get<RawIssue>(`/repos/${owner}/${repo}/issues/${number}`);
      return res.data.pull_request ? null : toIssue(res.data, `${owner}/${repo}`);
    } catch (err) {
      if (axios.isAxiosError(err) && [404, 410].includes(err.response?.status ?? 0)) return null;
      throw err;
    }
  }

  /** The user's own, non-fork, non-archived repos, most recently pushed first. */
  async listOwnRepos(): Promise<OwnRepo[]> {
    const raw = await this.paginate<RawRepo>(
      "/user/repos",
      { affiliation: "owner", sort: "pushed" },
      { maxPages: 5 },
    );
    return raw
      .filter((r) => !r.fork && !r.archived)
      .map((r) => ({ owner: r.owner.login, name: r.name, pushedAt: r.pushed_at ?? "" }));
  }

  /** Returns a file's text from the default branch, or null if it does not exist. */
  async getFile(owner: string, repo: string, filePath: string): Promise<string | null> {
    try {
      const res = await this.get<{ content?: string; encoding?: string; type?: string }>(
        `/repos/${owner}/${repo}/contents/${filePath}`,
      );
      const { content, encoding, type } = res.data;
      if (type !== "file" || !content || encoding !== "base64") return null;
      return Buffer.from(content, "base64").toString("utf-8");
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) return null;
      throw err;
    }
  }
}

function toIssue(i: RawIssue, repo: string): Issue {
  return {
    repo,
    number: i.number,
    title: i.title,
    body: i.body ?? "",
    user: i.user?.login ?? "unknown",
    url: i.html_url,
    labels: (i.labels ?? [])
      .map((l) => (typeof l === "string" ? l : l.name))
      .filter((n): n is string => Boolean(n)),
    comments: i.comments ?? 0,
    assignees: i.assignees?.length ?? 0,
    createdAt: i.created_at ?? "",
    reactions: i.reactions?.total_count ?? 0,
    isBot: i.user?.type === "Bot" || (i.user?.login ?? "").endsWith("[bot]"),
  };
}
