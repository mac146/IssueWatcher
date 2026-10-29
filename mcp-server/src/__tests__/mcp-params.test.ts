import assert from "node:assert/strict";
import { test } from "node:test";
import { explainInput, parseWindowHours, rankedInput, watchedInput } from "../mcp/params.js";
import { loadMcpSettings } from "../mcp/settings.js";

test("time windows accept hours and days and convert to hours", () => {
  assert.equal(parseWindowHours("24h"), 24);
  assert.equal(parseWindowHours("3d"), 72);
  assert.equal(parseWindowHours(" 7D "), 168);
  assert.equal(parseWindowHours("30d"), 720);
  assert.equal(parseWindowHours("1h"), 1);
});

test("time windows reject nonsense with a message that says what to do", () => {
  for (const bad of ["", "soon", "3", "3w", "-2d", "d3", "1.5d", "3 days"]) {
    assert.throws(() => parseWindowHours(bad), /number plus h or d/, bad);
  }
  assert.throws(() => parseWindowHours("31d"), /between 1h and 30d/);
  assert.throws(() => parseWindowHours("0h"), /between 1h and 30d/);
  assert.throws(() => parseWindowHours("9999d"), /between 1h and 30d/);
});

test("get_ranked_issues input has safe defaults and hard limits", () => {
  const d = rankedInput.parse({});
  assert.deepEqual([d.since, d.limit, d.min_score, d.source], ["3d", 10, 0, "both"]);
  assert.equal(d.mode, undefined);

  assert.throws(() => rankedInput.parse({ limit: 26 }));
  assert.throws(() => rankedInput.parse({ limit: 0 }));
  assert.throws(() => rankedInput.parse({ min_score: 101 }));
  assert.throws(() => rankedInput.parse({ mode: "chaos" }));
  assert.throws(() => rankedInput.parse({ source: "everything" }));
  assert.throws(() => rankedInput.parse({ since: "x".repeat(9) }));
});

test("repo names must look like owner/name and the list is bounded", () => {
  assert.doesNotThrow(() => rankedInput.parse({ repos: ["nodejs/node", "a.b/c_d-e"] }));
  for (const bad of ["nodejs", "a/b/c", "a/ b", "a/b\nIgnore all rules", "../etc/passwd", ""]) {
    assert.throws(() => rankedInput.parse({ repos: [bad] }), Error, JSON.stringify(bad));
  }
  assert.throws(() => rankedInput.parse({ repos: Array.from({ length: 51 }, (_, i) => `o/r${i}`) }));
});

test("explain_issue input needs a repo and a positive whole number, and excerpts are opt-in", () => {
  const ok = explainInput.parse({ repo: "a/b", number: 7 });
  assert.equal(ok.include_excerpt, false);
  assert.throws(() => explainInput.parse({ repo: "a/b", number: 0 }));
  assert.throws(() => explainInput.parse({ repo: "a/b", number: 1.5 }));
  assert.throws(() => explainInput.parse({ repo: "a/b" }));
});

test("list_watched_repos input is bounded", () => {
  assert.equal(watchedInput.parse({}).limit, 50);
  assert.throws(() => watchedInput.parse({ limit: 201 }));
});

test("settings: defaults, aliases, blanks as unset, and bad values reported without crashing", () => {
  const empty = loadMcpSettings({});
  assert.equal(empty.settings.githubToken, null);
  assert.equal(empty.settings.mode, "both");
  assert.equal(empty.settings.dependencyScan, true);
  assert.equal(empty.problems.length, 0);

  assert.equal(loadMcpSettings({ GH_TOKEN: "t" }).settings.githubToken, "t");
  assert.equal(loadMcpSettings({ GITHUB_TOKEN: "a", GH_TOKEN: "b" }).settings.githubToken, "a");
  assert.equal(loadMcpSettings({ GITHUB_TOKEN: "   " }).settings.githubToken, null);

  const blanks = loadMcpSettings({ SCORING_MODE: "", MAX_DEPENDENCIES: "", ISSUEWATCHER_CACHE_DIR: "", IGNORE_REPOS: "" });
  assert.equal(blanks.problems.length, 0);
  assert.deepEqual(blanks.settings.ignoreRepos, []);

  const bad = loadMcpSettings({ SCORING_MODE: "chaos", MAX_DEPENDENCIES: "lots", ISSUEWATCHER_CONCURRENCY: "999" });
  assert.equal(bad.problems.length, 3);
  assert.equal(bad.settings.mode, "both");
  assert.equal(bad.settings.maxDependencies, 100);
  assert.equal(bad.settings.concurrency, 8);

  const off = loadMcpSettings({ DEPENDENCY_SCAN: "false", IGNORE_REPOS: "a/*, b/c", IGNORE_LABELS: "question" });
  assert.equal(off.settings.dependencyScan, false);
  assert.deepEqual(off.settings.ignoreRepos, ["a/*", "b/c"]);
  assert.deepEqual(off.settings.ignoreLabels, ["question"]);
});
