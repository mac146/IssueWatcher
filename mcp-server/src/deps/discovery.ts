import fs from "node:fs/promises";
import path from "node:path";
import { logger } from "../logger.js";
import type { DependencyUse } from "../poller/types.js";
import { MANIFEST_FILES, parseManifest, type ManifestDependency } from "./manifests.js";
import type { Registry } from "./registry.js";

export type ManifestSource = {
  listOwnRepos(): Promise<Array<{ owner: string; name: string; pushedAt: string }>>;
  getFile(owner: string, repo: string, filePath: string): Promise<string | null>;
};

export type DiscoveryOptions = {
  /** Explicit "owner/name" list; when empty, the user's recently pushed repos are scanned. */
  repos: string[];
  maxRepos: number;
  maxDependencies: number;
  /** Repos untouched for longer than this are skipped during auto-discovery. */
  activeWithinDays: number;
};

/** "owner/name" of a watched repo to the dependencies of the user's that live there. */
export type DependencyMap = Record<string, DependencyUse[]>;

type Aggregated = ManifestDependency & { usedBy: Set<string> };

const DAY_MS = 86_400_000;

async function inPool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

/**
 * Collects the dependencies declared across the user's repos, keeps the most
 * widely used ones, and maps each to the GitHub repo that hosts its source.
 * Packages whose repo can't be resolved are skipped (and logged at debug level).
 */
export async function discoverDependencies(
  source: ManifestSource,
  registry: Registry,
  opts: DiscoveryOptions,
  now: () => number = Date.now,
): Promise<DependencyMap> {
  let repos: Array<{ owner: string; name: string }>;
  if (opts.repos.length) {
    repos = opts.repos.map((r) => {
      const [owner, name] = r.split("/");
      return { owner: owner!, name: name! };
    });
  } else {
    const cutoff = now() - opts.activeWithinDays * DAY_MS;
    repos = (await source.listOwnRepos())
      .filter((r) => !r.pushedAt || Date.parse(r.pushedAt) >= cutoff)
      .slice(0, opts.maxRepos);
  }

  const aggregated = new Map<string, Aggregated>();
  await inPool(repos, 4, async ({ owner, name }) => {
    for (const file of MANIFEST_FILES) {
      let text: string | null;
      try {
        text = await source.getFile(owner, name, file);
      } catch (err) {
        logger.warn(`Could not read ${owner}/${name}/${file}`, err);
        continue;
      }
      if (!text) continue;
      for (const dep of parseManifest(file, text)) {
        const key = `${dep.ecosystem}:${dep.pkg}`;
        const existing = aggregated.get(key);
        if (existing) {
          existing.usedBy.add(`${owner}/${name}`);
          if (dep.kind === "runtime") existing.kind = "runtime";
        } else {
          aggregated.set(key, { ...dep, usedBy: new Set([`${owner}/${name}`]) });
        }
      }
    }
  });

  // Most widely used first, runtime before dev, then alphabetical for stable output.
  const ranked = [...aggregated.values()]
    .sort(
      (a, b) =>
        b.usedBy.size - a.usedBy.size ||
        Number(b.kind === "runtime") - Number(a.kind === "runtime") ||
        a.pkg.localeCompare(b.pkg),
    )
    .slice(0, opts.maxDependencies);

  const resolved = await inPool(ranked, 5, async (dep) => {
    try {
      return await registry.resolve(dep.ecosystem, dep.pkg);
    } catch (err) {
      logger.warn(`Registry lookup failed for ${dep.ecosystem}:${dep.pkg}`, err);
      return null;
    }
  });

  const map: DependencyMap = {};
  ranked.forEach((dep, i) => {
    const repo = resolved[i];
    if (!repo) return;
    (map[repo] ??= []).push({ ...dep, usedBy: [...dep.usedBy].sort() });
  });
  logger.info(
    `Dependency scan: ${repos.length} repo(s), ${aggregated.size} package(s), ${Object.keys(map).length} source repo(s) resolved`,
  );
  return map;
}

type CacheFile = { fetchedAt: number; map: DependencyMap };

/**
 * Wraps discovery with a disk cache so manifests and registries are not hit on
 * every poll. If a refresh fails, the stale cache is used rather than losing
 * the dependency watch list.
 */
export class CachedDiscovery {
  constructor(
    private readonly run: () => Promise<DependencyMap>,
    private readonly file: string,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<DependencyMap> {
    const cached = await this.read();
    if (cached && this.now() - cached.fetchedAt < this.ttlMs) return cached.map;
    try {
      const map = await this.run();
      await this.write({ fetchedAt: this.now(), map });
      return map;
    } catch (err) {
      logger.warn("Dependency discovery failed; using cached list if any", err);
      return cached?.map ?? {};
    }
  }

  private async read(): Promise<CacheFile | null> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf-8")) as CacheFile;
      return typeof parsed.fetchedAt === "number" && parsed.map ? parsed : null;
    } catch {
      return null;
    }
  }

  private async write(data: CacheFile): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data), "utf-8");
    await fs.rename(tmp, this.file);
  }
}
