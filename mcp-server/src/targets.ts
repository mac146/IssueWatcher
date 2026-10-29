import path from "node:path";
import type { Config } from "./config.js";
import { CachedDiscovery, discoverDependencies, type DependencyMap } from "./deps/discovery.js";
import { HttpRegistry, type Registry } from "./deps/registry.js";
import type { GitHubAPI } from "./github/api.js";
import type { Repo, WatchTarget } from "./poller/types.js";

/**
 * Merges starred repos with dependency source repos into one watch list.
 * GitHub names are case-insensitive, so repos are merged case-insensitively
 * while keeping the spelling GitHub gave us for starred repos.
 */
export function buildTargets(starred: Repo[], dependencies: DependencyMap): WatchTarget[] {
  const byKey = new Map<string, WatchTarget>();

  for (const { owner, name } of starred) {
    byKey.set(`${owner}/${name}`.toLowerCase(), { owner, name, starred: true, dependencies: [] });
  }
  for (const [repo, uses] of Object.entries(dependencies)) {
    const key = repo.toLowerCase();
    const existing = byKey.get(key);
    if (existing) {
      existing.dependencies = uses;
      continue;
    }
    const [owner, name] = repo.split("/");
    byKey.set(key, { owner: owner!, name: name!, starred: false, dependencies: uses });
  }
  return [...byKey.values()];
}

const DEPENDENCY_TTL_MS = 24 * 3_600_000;

/** Everything to poll: starred repos plus the source repos of the user's dependencies. */
export type TargetSettings = Pick<Config, "dependencyScan" | "dependencyRepos" | "maxDependencyRepos" | "maxDependencies" | "stateFile">;

export function createTargetProvider(
  config: TargetSettings,
  github: Pick<GitHubAPI, "getStarredRepos" | "listOwnRepos" | "getFile">,
  registry: Registry = new HttpRegistry(),
): () => Promise<WatchTarget[]> {
  const discovery = config.dependencyScan
    ? new CachedDiscovery(
        () =>
          discoverDependencies(github, registry, {
            repos: config.dependencyRepos,
            maxRepos: config.maxDependencyRepos,
            maxDependencies: config.maxDependencies,
            activeWithinDays: 365,
          }),
        path.join(path.dirname(config.stateFile), "dependencies.json"),
        DEPENDENCY_TTL_MS,
      )
    : null;

  return async () => buildTargets(await github.getStarredRepos(), (await discovery?.get()) ?? {});
}
