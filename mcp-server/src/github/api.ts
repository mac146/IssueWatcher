import axios, { AxiosError, AxiosInstance, AxiosResponse } from "axios";
import { logger } from "../logger.js";
import type { Issue, IssueSource, Repo } from "../poller/types.js";

const PER_PAGE = 100;
const MAX_PAGES = 50; // hard stop: 5,000 items per listing
const MAX_RETRIES = 3;
const MAX_RATE_LIMIT_WAIT_MS = 120_000;

type RawIssue = {
  number: number;
  title: string;
  body?: string | null;
  html_url: string;
  state: string;
  pull_request?: unknown;
  user?: { login?: string } | null;
  labels?: Array<string | { name?: string }>;
};

type RawRepo = { name: string; owner: { login: string } };

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

  constructor(token: string, client?: AxiosInstance) {
    this.client =
      client ??
      axios.create({
        baseURL: "https://api.github.com",
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

  private async paginate<T>(url: string, params: Record<string, unknown>): Promise<T[]> {
    const items: T[] = [];
    let next: string | null = url;
    let query: Record<string, unknown> | undefined = { ...params, per_page: PER_PAGE };

    for (let page = 0; next && page < MAX_PAGES; page++) {
      const res: AxiosResponse<T[]> = await this.get<T[]>(next, query);
      items.push(...res.data);
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

  async getOpenIssues(owner: string, repo: string): Promise<Issue[]> {
    const raw = await this.paginate<RawIssue>(`/repos/${owner}/${repo}/issues`, {
      state: "open",
    });
    return raw
      .filter((i) => !i.pull_request)
      .map((i) => ({
        repo: `${owner}/${repo}`,
        number: i.number,
        title: i.title,
        body: i.body ?? "",
        user: i.user?.login ?? "unknown",
        url: i.html_url,
        labels: (i.labels ?? [])
          .map((l) => (typeof l === "string" ? l : l.name))
          .filter((n): n is string => Boolean(n)),
      }));
  }
}
