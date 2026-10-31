import axios, { AxiosInstance } from "axios";
import type { DependencyUse } from "../poller/types.js";

/** Resolves a package to the GitHub repo that hosts its source ("owner/name"), or null. */
export type Registry = {
  resolve(ecosystem: DependencyUse["ecosystem"], pkg: string): Promise<string | null>;
};

/**
 * Extracts "owner/name" from the many spellings of a GitHub URL found in
 * package metadata: git+https://…/o/r.git, github:o/r, git@github.com:o/r.git,
 * https://github.com/o/r/tree/main/packages/x, and bare "o/r" shorthand.
 */
export function githubRepoFromUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  const s = url.trim();
  const m =
    s.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/i) ??
    s.match(/^github:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i) ??
    s.match(/^([\w.-]+)\/([\w.-]+)$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

type NpmLatest = { repository?: string | { url?: string } };
type PypiInfo = { info?: { project_urls?: Record<string, string> | null; home_page?: string | null } };

export type RegistryUrls = { npm: string; pypi: string };

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 400;

export class HttpRegistry implements Registry {
  constructor(
    private readonly client: AxiosInstance = axios.create({
      timeout: 10_000,
      headers: { "User-Agent": "IssueWatcher" },
    }),
    /** Overridden in tests (a local stub) and for registry mirrors. */
    private readonly urls: RegistryUrls = { npm: "https://registry.npmjs.org", pypi: "https://pypi.org" },
  ) {}

  async resolve(ecosystem: DependencyUse["ecosystem"], pkg: string): Promise<string | null> {
    for (let attempt = 0; ; attempt++) {
      try {
        return ecosystem === "npm" ? await this.npm(pkg) : await this.pypi(pkg);
      } catch (err) {
        // An unknown package is a normal "no repo"; anything else should surface.
        if (axios.isAxiosError(err) && err.response?.status === 404) return null;
        // A dropped connection or a registry hiccup is worth a second try; losing the package
        // would silently remove its repo from the watch list.
        const status = axios.isAxiosError(err) ? err.response?.status : undefined;
        // A timeout is not retried: a server that did not answer in 10 s will not answer the second time
        // either, and three tries would turn one hung registry into half a minute of waiting.
        const timedOut = axios.isAxiosError(err) && (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT");
        const transient = axios.isAxiosError(err) && !timedOut && (status === undefined || status < 400 || status >= 500);
        if (!transient || attempt >= MAX_ATTEMPTS - 1) throw err;
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
      }
    }
  }

  private async npm(pkg: string): Promise<string | null> {
    const res = await this.client.get<NpmLatest>(
      `${this.urls.npm}/${pkg.replace("/", "%2F")}/latest`,
    );
    const repo = res.data.repository;
    return githubRepoFromUrl(typeof repo === "string" ? repo : repo?.url);
  }

  private async pypi(pkg: string): Promise<string | null> {
    const res = await this.client.get<PypiInfo>(`${this.urls.pypi}/pypi/${pkg}/json`);
    const urls = res.data.info?.project_urls ?? {};
    const preferred = ["Source", "Source Code", "Repository", "Code", "Homepage", "GitHub"];
    const candidates = [
      ...preferred.map((k) => urls[k]),
      ...Object.values(urls),
      res.data.info?.home_page,
    ];
    for (const url of candidates) {
      const repo = githubRepoFromUrl(url);
      if (repo) return repo;
    }
    return null;
  }
}
