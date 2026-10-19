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

export class HttpRegistry implements Registry {
  constructor(
    private readonly client: AxiosInstance = axios.create({
      timeout: 15_000,
      headers: { "User-Agent": "IssueWatcher" },
    }),
  ) {}

  async resolve(ecosystem: DependencyUse["ecosystem"], pkg: string): Promise<string | null> {
    try {
      return ecosystem === "npm" ? await this.npm(pkg) : await this.pypi(pkg);
    } catch (err) {
      // An unknown package is a normal "no repo"; anything else should surface.
      if (axios.isAxiosError(err) && err.response?.status === 404) return null;
      throw err;
    }
  }

  private async npm(pkg: string): Promise<string | null> {
    const res = await this.client.get<NpmLatest>(
      `https://registry.npmjs.org/${pkg.replace("/", "%2F")}/latest`,
    );
    const repo = res.data.repository;
    return githubRepoFromUrl(typeof repo === "string" ? repo : repo?.url);
  }

  private async pypi(pkg: string): Promise<string | null> {
    const res = await this.client.get<PypiInfo>(`https://pypi.org/pypi/${pkg}/json`);
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
