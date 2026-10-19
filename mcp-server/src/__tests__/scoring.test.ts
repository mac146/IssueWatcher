import assert from "node:assert/strict";
import { test } from "node:test";
import type { WatchTarget } from "../poller/types.js";
import { buildIgnore } from "../scoring/filters.js";
import { rankIssues, scoreIssue } from "../scoring/score.js";
import { issue, starred } from "./helpers.js";

const dep = (range: string, kind: "runtime" | "dev" = "runtime", usedBy = ["me/app"]) => ({
  ecosystem: "npm" as const,
  pkg: "axios",
  range,
  kind,
  usedBy,
});
const depTarget = (...deps: ReturnType<typeof dep>[]): WatchTarget => ({
  owner: "axios",
  name: "axios",
  starred: false,
  dependencies: deps,
});

test("a runtime dependency outranks a merely starred repo for the same issue", () => {
  const i = issue("axios/axios", 1);
  assert.ok(scoreIssue(i, depTarget(dep("^1.6.0"))).score > scoreIssue(i, starred("axios/axios")).score);
});

test("runtime dependency outranks dev dependency", () => {
  const i = issue("axios/axios", 1);
  assert.ok(scoreIssue(i, depTarget(dep("^1.0.0"))).score > scoreIssue(i, depTarget(dep("^1.0.0", "dev"))).score);
});

test("an issue mentioning your minor version beats one mentioning only your major", () => {
  const exact = scoreIssue(issue("a/b", 1, { title: "Crash in 1.6.2 when streaming" }), depTarget(dep("^1.6.0")));
  const major = scoreIssue(issue("a/b", 1, { title: "Crash in 1.9.0 when streaming" }), depTarget(dep("^1.6.0")));
  const other = scoreIssue(issue("a/b", 1, { title: "Crash in 2.0.0 when streaming" }), depTarget(dep("^1.6.0")));
  assert.ok(exact.score > major.score && major.score > other.score);
  assert.ok(exact.reasons.some((r) => r.includes("you use ^1.6.0")));
});

test("severity keywords and bug labels raise the score; the title counts more than the body", () => {
  const base = scoreIssue(issue("a/b", 1), starred("a/b")).score;
  const inTitle = scoreIssue(issue("a/b", 1, { title: "Regression: crash on startup" }), starred("a/b")).score;
  const inBody = scoreIssue(issue("a/b", 1, { body: "we noticed a memory leak in production use" }), starred("a/b")).score;
  const bug = scoreIssue(issue("a/b", 1, { labels: ["bug"] }), starred("a/b")).score;
  assert.ok(inTitle > inBody && inBody > base && bug > base);
});

test("noise lowers the score: bots, questions, duplicates and empty bodies", () => {
  const base = scoreIssue(issue("a/b", 1), starred("a/b")).score;
  assert.ok(scoreIssue(issue("a/b", 1, { isBot: true }), starred("a/b")).score < base);
  assert.ok(scoreIssue(issue("a/b", 1, { labels: ["question"] }), starred("a/b")).score < base);
  assert.ok(scoreIssue(issue("a/b", 1, { labels: ["duplicate"] }), starred("a/b")).score < base);
  assert.ok(scoreIssue(issue("a/b", 1, { body: "" }), starred("a/b")).score < base);
});

test("scores stay within 0-100 and always carry reasons for strong signals", () => {
  const hot = scoreIssue(
    issue("a/b", 1, { title: "Security regression in 1.6.1", labels: ["bug", "security"], reactions: 9, comments: 12 }),
    depTarget(dep("^1.6.0", "runtime", ["me/a", "me/b"])),
  );
  assert.ok(hot.score <= 100 && hot.score > 80);
  assert.ok(hot.reasons.length >= 4);
  assert.equal(scoreIssue(issue("a/b", 1, { isBot: true, labels: ["duplicate"], body: "" }), starred("a/b")).score >= 0, true);
});

test("rankIssues sorts by score then recency", () => {
  const t = starred("a/b");
  const ranked = rankIssues([
    { issue: issue("a/b", 1), target: t },
    { issue: issue("a/b", 3, { title: "crash on start" }), target: t },
    { issue: issue("a/b", 2), target: t },
  ]);
  assert.deepEqual(ranked.map((r) => r.issue.number), [3, 2, 1]);
});

test("ignore rules match repo globs and labels case-insensitively", () => {
  const ignore = buildIgnore({ repos: ["100xdevs-*/*", "me/noisy"], labels: ["Question"] });
  assert.equal(ignore(issue("100xdevs-cohort-3/assignments", 1)), true);
  assert.equal(ignore(issue("me/noisy", 1)), true);
  assert.equal(ignore(issue("a/b", 1, { labels: ["question"] })), true);
  assert.equal(ignore(issue("a/b", 1, { labels: ["bug"] })), false);
  assert.equal(buildIgnore({ repos: [], labels: [] })(issue("a/b", 1)), false);
});

test("a major-only version match is weak, and meaningless for 0.x packages", () => {
  const major = scoreIssue(issue("a/b", 1, { title: "bug in 1.9.0" }), depTarget(dep("^1.6.0")));
  const exact = scoreIssue(issue("a/b", 1, { title: "bug in 1.6.2" }), depTarget(dep("^1.6.0")));
  const none = scoreIssue(issue("a/b", 1, { title: "bug in 2.0.0" }), depTarget(dep("^1.6.0")));
  assert.ok(exact.score - major.score >= 15 && major.score - none.score <= 5);

  const zeroMinorMiss = scoreIssue(issue("a/b", 1, { title: "bug in 0.9.1" }), depTarget(dep("^0.14.3")));
  const zeroNone = scoreIssue(issue("a/b", 1, { title: "bug in 3.0.0" }), depTarget(dep("^0.14.3")));
  assert.equal(zeroMinorMiss.score, zeroNone.score);
});

test("dev-only dependencies cannot outrank a runtime dependency on hype alone", () => {
  const hype = { title: "crash with TypeScript 7 in 10.9.2", body: "x".repeat(60), reactions: 30, comments: 20, labels: ["bug"] };
  const devHot = scoreIssue(issue("a/b", 1, hype), depTarget(dep("^10.9.2", "dev")));
  const runtimeQuiet = scoreIssue(issue("a/b", 1, { title: "bug in 1.6.2" }), depTarget(dep("^1.6.0")));
  assert.ok(runtimeQuiet.score >= devHot.score, `${runtimeQuiet.score} vs ${devHot.score}`);
});

const NOW = Date.parse("2026-10-19T12:00:00Z");
const contrib = { mode: "contributor" as const, now: NOW };
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

test("contributor mode: a starred repo outranks a dependency-only repo", () => {
  const i = issue("a/b", 1);
  const star = scoreIssue(i, starred("a/b"), contrib).score;
  const dependency = scoreIssue(i, depTarget(dep("^1.6.0")), contrib).score;
  assert.ok(star > dependency, `${star} vs ${dependency}`);
  // The old consumer view is the reverse.
  assert.ok(scoreIssue(i, depTarget(dep("^1.6.0")), { mode: "consumer" }).score > scoreIssue(i, starred("a/b"), { mode: "consumer" }).score);
});

test("contributor mode: good first issue, unassigned and fresh beats assigned and old", () => {
  const good = scoreIssue(issue("a/b", 1, { labels: ["good first issue"], createdAt: hoursAgo(3) }), starred("a/b"), contrib);
  const taken = scoreIssue(issue("a/b", 1, { labels: ["good first issue"], createdAt: hoursAgo(300), assignees: 1 }), starred("a/b"), contrib);
  assert.ok(good.score - taken.score >= 40);
  assert.ok(good.reasons.includes("good first issue") && good.reasons.includes("unassigned"));
  assert.ok(good.reasons.some((r) => r.startsWith("opened 3h ago")));
  assert.ok(taken.reasons.includes("already assigned"));
});

test("contributor mode: help wanted counts, docs work is not penalised, questions are", () => {
  const base = scoreIssue(issue("a/b", 1), starred("a/b"), contrib).score;
  assert.ok(scoreIssue(issue("a/b", 1, { labels: ["help wanted"] }), starred("a/b"), contrib).score > base);
  assert.equal(scoreIssue(issue("a/b", 1, { labels: ["documentation"] }), starred("a/b"), contrib).score, base);
  assert.ok(scoreIssue(issue("a/b", 1, { labels: ["question"] }), starred("a/b"), contrib).score < base);
});

test("contributor mode: reproduction details help, a crowded thread hurts", () => {
  const plain = scoreIssue(issue("a/b", 1), starred("a/b"), contrib).score;
  const repro = scoreIssue(issue("a/b", 1, { body: "Steps to reproduce:\n1. run it\nExpected: ok\nActual: crash" }), starred("a/b"), contrib).score;
  const crowded = scoreIssue(issue("a/b", 1, { comments: 14 }), starred("a/b"), contrib).score;
  assert.ok(repro > plain && crowded < plain);
});

test("contributor-only signals do not leak into consumer mode", () => {
  const i = issue("a/b", 1, { labels: ["good first issue"], createdAt: hoursAgo(2) });
  const r = scoreIssue(i, starred("a/b"), { mode: "consumer", now: NOW });
  assert.ok(!r.reasons.includes("good first issue") && !r.reasons.includes("unassigned"));
});

test("junk filter: vague, single-word and non-English titles score lower", () => {
  const good = scoreIssue(issue("a/b", 1, { title: "Crash when saving a large file" }), starred("a/b"), contrib);
  for (const title of ["idurar", "test", "Assignment__1__", "Сообщить об ошибке"]) {
    const junk = scoreIssue(issue("a/b", 1, { title }), starred("a/b"), contrib);
    assert.ok(junk.score < good.score - 10, `${title}: ${junk.score} vs ${good.score}`);
  }
  assert.ok(scoreIssue(issue("a/b", 1, { title: "idurar" }), starred("a/b"), contrib).reasons.includes("vague title"));
});

test("asking for a regression test suite is not treated as a severe report", () => {
  const request = scoreIssue(issue("a/b", 1, { title: "Add regression test suite for retries" }), starred("a/b"), contrib);
  const report = scoreIssue(issue("a/b", 1, { title: "Regression: retries now fail on timeout" }), starred("a/b"), contrib);
  assert.ok(report.score > request.score);
  assert.ok(!request.reasons.some((r) => r.includes("regression")));
});
