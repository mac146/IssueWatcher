import type { Issue, WatchTarget } from "../poller/types.js";
import { Radar, type RadarOptions, type RadarSource } from "../mcp/radar.js";
import { issue as baseIssue } from "./helpers.js";

export const NOW = Date.parse("2026-10-29T12:00:00Z");
export const HOUR = 3_600_000;

/** An issue opened `hoursAgo` hours before NOW. */
export const issueAgo = (repo: string, number: number, hoursAgo: number, extra: Partial<Issue> = {}): Issue =>
  baseIssue(repo, number, { createdAt: new Date(NOW - hoursAgo * HOUR).toISOString(), ...extra });

export const watch = (repo: string, extra: Partial<WatchTarget> = {}): WatchTarget => {
  const [owner, name] = repo.split("/");
  return { owner: owner!, name: name!, starred: true, dependencies: [], ...extra };
};

export const dependencyTarget = (repo: string, pkg: string, range = "^1.0.0", usedBy = ["me/app"]): WatchTarget =>
  watch(repo, { starred: false, dependencies: [{ ecosystem: "npm", pkg, range, kind: "runtime", usedBy }] });

export type FakeSource = RadarSource & {
  calls: Array<{ repo: string; since: Date }>;
  singleCalls: string[];
  inFlight: { now: number; max: number };
};

/**
 * Fake GitHub. `data` maps "owner/name" to its issues, an Error to throw, or a function for custom
 * behaviour (for example never resolving). Filters by `since` and `max` like the real client.
 */
export function fakeSource(
  data: Record<string, Issue[] | Error | (() => Promise<Issue[]>)>,
  delayMs = 0,
): FakeSource {
  const inFlight = { now: 0, max: 0 };
  const src: FakeSource = {
    calls: [],
    singleCalls: [],
    inFlight,
    async getIssuesSince(owner, repo, since, max) {
      const key = `${owner}/${repo}`;
      src.calls.push({ repo: key, since });
      inFlight.now++;
      inFlight.max = Math.max(inFlight.max, inFlight.now);
      try {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        const v = data[key];
        if (v === undefined) return [];
        if (v instanceof Error) throw v;
        const issues = typeof v === "function" ? await v() : v;
        return issues.filter((i) => Date.parse(i.createdAt) >= since.getTime()).slice(0, max);
      } finally {
        inFlight.now--;
      }
    },
    async getIssue(owner, repo, number) {
      src.singleCalls.push(`${owner}/${repo}#${number}`);
      const v = data[`${owner}/${repo}`];
      if (v instanceof Error) throw v;
      const issues = typeof v === "function" ? await v() : (v ?? []);
      return issues.find((i) => i.number === number) ?? null;
    },
  };
  return src;
}

export function makeRadar(
  source: RadarSource,
  targets: WatchTarget[],
  extra: Partial<RadarOptions> = {},
): Radar {
  return new Radar({ source, targets: async () => targets, now: () => NOW, ...extra });
}

/** An axios-shaped error, as the GitHub client throws. */
export function httpError(status: number, headers: Record<string, string> = {}): Error {
  return Object.assign(new Error(`Request failed with status code ${status} for token ghp_SECRETSECRETSECRET`), {
    isAxiosError: true,
    response: { status, headers, data: {} },
  });
}
