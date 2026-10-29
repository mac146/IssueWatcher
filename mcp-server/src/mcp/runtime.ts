import path from "node:path";
import { createRequire } from "node:module";
import { HttpRegistry } from "../deps/registry.js";
import { GitHubAPI } from "../github/api.js";
import { buildIgnore } from "../scoring/filters.js";
import { createTargetProvider } from "../targets.js";
import { Radar } from "./radar.js";
import type { McpSettings } from "./settings.js";

/** Package version, read from package.json so the server reports the version that was installed. */
export function packageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    return (require("../../package.json") as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export type Runtime = { radar: Radar; github: GitHubAPI; targets: ReturnType<typeof createTargetProvider> };

/** Wires the real GitHub client, registry lookups, ignore rules and radar from the settings. */
export function buildRuntime(settings: McpSettings & { githubToken: string }): Runtime {
  const github = new GitHubAPI(settings.githubToken, undefined, settings.githubApiUrl);
  const registry = new HttpRegistry(undefined, { npm: settings.npmUrl, pypi: settings.pypiUrl });
  const targets = createTargetProvider(
    {
      dependencyScan: settings.dependencyScan,
      dependencyRepos: settings.dependencyRepos,
      maxDependencyRepos: settings.maxDependencyRepos,
      maxDependencies: settings.maxDependencies,
      // The dependency cache is written next to this path.
      stateFile: path.join(settings.cacheDir, "state.json"),
    },
    github,
    registry,
  );
  const radar = new Radar({
    source: github,
    targets,
    ignore: buildIgnore({ repos: settings.ignoreRepos, labels: settings.ignoreLabels }),
    defaultMode: settings.mode,
    concurrency: settings.concurrency,
    budgetMs: settings.budgetMs,
    cacheTtlMs: settings.cacheTtlMs,
  });
  return { radar, github, targets };
}
