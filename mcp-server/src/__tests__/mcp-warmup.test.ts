import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Radar, type RankedParams } from "../mcp/radar.js";
import { renderRanked } from "../mcp/render.js";
import { loadMcpSettings } from "../mcp/settings.js";
import type { WatchTarget } from "../poller/types.js";
import { startStub } from "./stub-github.js";
import { fakeSource, httpError, issueAgo, makeRadar, NOW, watch } from "./mcp-helpers.js";

const params = (extra: Partial<RankedParams> = {}): RankedParams => ({ sinceHours: 72, limit: 10, minScore: 0, source: "both", ...extra });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const body = "The editor throws when the file is larger than two megabytes and the save button is pressed twice in a row.";

function slowTargets(targets: WatchTarget[], delayMs: number) {
  const state = { calls: 0 };
  return {
    state,
    fn: async () => {
      state.calls++;
      await sleep(delayMs);
      return targets;
    },
  };
}

test("two questions at the same moment share one load of the repo list and one fetch per repo", async () => {
  const src = fakeSource({ "a/b": [issueAgo("a/b", 1, 2, { body })], "c/d": [issueAgo("c/d", 2, 2, { body })] }, 40);
  const targets = slowTargets([watch("a/b"), watch("c/d")], 40);
  const radar = new Radar({ source: src, targets: targets.fn, now: () => NOW });

  const [one, two] = await Promise.all([radar.ranked(params()), radar.ranked(params({ limit: 1 }))]);
  assert.equal(targets.state.calls, 1, "the repo list is loaded once");
  assert.equal(src.calls.length, 2, "each repo is fetched once, not once per question");
  assert.equal(one.returned, 2);
  assert.equal(two.returned, 1);
});

test("warmUp loads everything, so the first real question makes no GitHub calls", async () => {
  const src = fakeSource({ "a/b": [issueAgo("a/b", 1, 2, { body })], "c/d": [issueAgo("c/d", 2, 2, { body })] });
  const radar = makeRadar(src, [watch("a/b"), watch("c/d")]);

  await radar.warmUp();
  assert.equal(src.calls.length, 2);

  const r = await radar.ranked(params()); // the default 3d window is what warmUp loaded
  assert.equal(src.calls.length, 2, "served from the warm cache");
  assert.equal(r.returned, 2);
  assert.equal(r.partial, false);
});

test("a warm-up running while the user asks does not duplicate work", async () => {
  const src = fakeSource({ "a/b": [issueAgo("a/b", 1, 2, { body })] }, 50);
  const radar = makeRadar(src, [watch("a/b")]);
  const warm = radar.warmUp();
  const answer = await radar.ranked(params());
  await warm;
  assert.equal(src.calls.length, 1);
  assert.equal(answer.returned, 1);
});

test("warmUp never throws, whatever goes wrong", async () => {
  const broken = new Radar({
    source: fakeSource({}),
    targets: async () => {
      throw httpError(401);
    },
    now: () => NOW,
  });
  await assert.doesNotReject(() => broken.warmUp());

  const failingRepos = makeRadar(fakeSource({ "a/b": httpError(500) }), [watch("a/b")]);
  await assert.doesNotReject(() => failingRepos.warmUp());
});

test("a slow first load answers within the budget with an honest 'still loading', and the next question succeeds", async () => {
  const src = fakeSource({ "a/b": [issueAgo("a/b", 1, 2, { body })] });
  const targets = slowTargets([watch("a/b")], 250);
  const radar = new Radar({ source: src, targets: targets.fn, now: () => NOW, budgetMs: 60 });

  const started = Date.now();
  const first = await radar.ranked(params());
  assert.ok(Date.now() - started < 200, "must not wait for the slow load");
  assert.equal(first.partial, true);
  assert.equal(first.returned, 0);
  assert.match(first.notice ?? "", /Still loading/);
  assert.match(renderRanked(first), /^Still loading your repositories/, "the text version leads with the notice");

  await sleep(350); // the load kept going in the background
  const second = await radar.ranked(params());
  assert.equal(second.returned, 1);
  assert.equal(second.partial, false);
  assert.equal(targets.state.calls, 1, "the load that was already under way was reused");
});

test("a scan that runs out of time says so in a notice the assistant can relay", async () => {
  const hang = () => new Promise<never>(() => undefined);
  const src = fakeSource({ "ok/one": [issueAgo("ok/one", 1, 1, { body })], "slow/two": hang as never });
  const radar = makeRadar(src, [watch("ok/one"), watch("slow/two")], { budgetMs: 60 });
  const r = await radar.ranked(params());
  assert.equal(r.partial, true);
  assert.match(r.notice ?? "", /time limit/);
  assert.match(renderRanked(r), /Note: The scan hit its time limit/);
});

test("a complete result carries no notice", async () => {
  const r = await makeRadar(fakeSource({ "a/b": [issueAgo("a/b", 1, 2, { body })] }), [watch("a/b")]).ranked(params());
  assert.equal(r.partial, false);
  assert.equal(r.notice, undefined);
});

test("the warm-up setting defaults on and can be turned off", () => {
  assert.equal(loadMcpSettings({}).settings.prefetch, true);
  assert.equal(loadMcpSettings({ ISSUEWATCHER_PREFETCH: "false" }).settings.prefetch, false);
  assert.equal(loadMcpSettings({ ISSUEWATCHER_PREFETCH: "" }).settings.prefetch, true);
});

const MAIN = fileURLToPath(new URL("../mcp/main.js", import.meta.url));

async function startServerAndCountIssueRequests(extraEnv: Record<string, string>, waitMs: number): Promise<number> {
  const stub = await startStub();
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    GITHUB_TOKEN: "test-token",
    ISSUEWATCHER_GITHUB_API_URL: stub.url,
    ISSUEWATCHER_NPM_URL: `${stub.url}/npm`,
    ISSUEWATCHER_PYPI_URL: `${stub.url}/pypi`,
    ISSUEWATCHER_CACHE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "iw-warm-")),
    ...extraEnv,
  };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  const child = spawn(process.execPath, [MAIN], { env, stdio: ["pipe", "pipe", "pipe"] });
  try {
    // No tool call is ever made: any issue requests come from the warm-up alone.
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && stub.count("/issues") === 0) await sleep(50);
    await sleep(150);
    return stub.count("/issues");
  } finally {
    child.stdin.end();
    child.kill();
    await stub.close();
  }
}

test("the real server starts loading issues on launch, before any question is asked", { timeout: 60_000 }, async () => {
  const requests = await startServerAndCountIssueRequests({}, 20_000);
  assert.ok(requests >= 3, `expected the warm-up to fetch issues for the watched repos, saw ${requests} requests`);
});

test("with ISSUEWATCHER_PREFETCH=false the server stays idle until asked", { timeout: 60_000 }, async () => {
  const requests = await startServerAndCountIssueRequests({ ISSUEWATCHER_PREFETCH: "false" }, 1_500);
  assert.equal(requests, 0);
});
