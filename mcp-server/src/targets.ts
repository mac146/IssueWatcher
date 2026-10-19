import type { DependencyMap } from "./deps/discovery.js";
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
