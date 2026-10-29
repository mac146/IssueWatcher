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

const NL = String.fromCharCode(10);
const long = "The editor throws when the file is larger than two megabytes and the save button is pressed twice in a row.";

test("incidental body words do not count: regression tests, PostgreSQL PANIC, security headers", () => {
  const plain = scoreIssue(issue("a/b", 1, { body: long }), starred("a/b"), contrib);
  for (const body of [
    long + " Add a regression test to verify this behavior.",
    long + " A client whose session ended with a FATAL or PANIC ErrorResponse is reused.",
    long + " Register the CORS hook like the built-in security headers.",
  ]) {
    const r = scoreIssue(issue("a/b", 1, { body }), starred("a/b"), contrib);
    assert.equal(r.score, plain.score, body);
    assert.ok(!r.reasons.some((x) => x.startsWith("body mentions")), body);
  }
  // A real regression report in the body still counts, and the title still may say "panic" or "security".
  assert.ok(scoreIssue(issue("a/b", 1, { body: long + " This is a regression from 1.2." }), starred("a/b"), contrib).score > plain.score);
  assert.ok(scoreIssue(issue("a/b", 1, { title: "Panic when parsing a nested table" }), starred("a/b"), contrib).score > plain.score);
});

test("generic titles such as 'Report a bug' are treated as vague", () => {
  const good = scoreIssue(issue("a/b", 1, { title: "Crash when saving a large file" }), starred("a/b"), contrib);
  for (const title of ["Report a bug", "Bug report", "Feature request", "Not working", "Help!"]) {
    const r = scoreIssue(issue("a/b", 1, { title }), starred("a/b"), contrib);
    assert.ok(r.reasons.includes("vague title"), title);
    assert.ok(r.score < good.score - 15, title);
  }
});

test("contributor mode: work that is already taken ranks lower", () => {
  const base = scoreIssue(issue("a/b", 1, { body: long }), starred("a/b"), contrib);

  const team = scoreIssue(issue("a/b", 1, { body: long, labels: ["status:team-assigned"] }), starred("a/b"), contrib);
  assert.ok(team.reasons.includes("team already on it") && team.score <= base.score - 20);

  for (const body of [
    long + " I'm open to implementing either fix.",
    long + " I can submit a PR for this.",
    long + " A PR is already prepared.",
    long + " A fix for this is tracked in #4981.",
    long + " The proposed fix is in GitHub PR #39224.",
    long + " Please assign this to me.",
  ]) {
    const r = scoreIssue(issue("a/b", 1, { body }), starred("a/b"), contrib);
    assert.ok(r.reasons.includes("a fix is already planned or open"), body);
    assert.ok(r.score < base.score, body);
  }

  // Ordinary mentions of pull requests or "fix" do not trigger it.
  const calm = scoreIssue(issue("a/b", 1, { body: long + " We should fix the docs. Related: see #12 for context." }), starred("a/b"), contrib);
  assert.ok(!calm.reasons.includes("a fix is already planned or open"));
});

test("'has reproduction details' needs real text, not just template headings", () => {
  const empty = ["### Steps to reproduce", "", "### Expected behavior", "", "### Actual behavior"].join(NL);
  const real = ["### Steps to reproduce", "1. Open a file larger than two megabytes in the editor", "2. Press the save button twice in a row quickly", "Expected behavior: it saves. Actual behavior: it throws a RangeError and the file is lost."].join(NL);
  assert.ok(!scoreIssue(issue("a/b", 1, { body: empty }), starred("a/b"), contrib).reasons.includes("has reproduction details"));
  assert.ok(scoreIssue(issue("a/b", 1, { body: real }), starred("a/b"), contrib).reasons.includes("has reproduction details"));
});

const longBody = "The editor throws when the file is larger than two megabytes and the save button is pressed twice in a row.";

test("a fix mentioned for a DIFFERENT issue does not count as this one being fixed", () => {
  const base = scoreIssue(issue("a/b", 1, { body: longBody }), starred("a/b"), contrib);
  const other = scoreIssue(
    issue("a/b", 1, { body: longBody + " Extend existing fixes for similar panic issues (like #64668) to cover this." }),
    starred("a/b"),
    contrib,
  );
  assert.ok(!other.reasons.includes("a fix is already planned or open"));
  assert.equal(other.score, base.score);
  // These do mean this issue is being fixed.
  for (const body of [longBody + " Fixed in #4981.", longBody + " This is fixed by PR #12.", longBody + " The proposed fix is in GitHub PR #39224."]) {
    assert.ok(scoreIssue(issue("a/b", 1, { body }), starred("a/b"), contrib).reasons.includes("a fix is already planned or open"), body);
  }
});

test("a reporter who says they are opening or preparing a PR is flagged", () => {
  for (const body of [
    longBody + " I'm opening a pull request for this.",
    longBody + " I am preparing a PR with the fix.",
    longBody + " We are working on a fix and will send it soon.",
    longBody + " I'm opening a small PR that turns these into usage errors.",
  ]) {
    assert.ok(scoreIssue(issue("a/b", 1, { body }), starred("a/b"), contrib).reasons.includes("a fix is already planned or open"), body);
  }
});

const dt = (title: string) => issue("DefinitelyTyped/DefinitelyTyped", 7, { title, body: longBody });
const dtTarget = (...pkgs: string[]): WatchTarget => ({
  owner: "DefinitelyTyped",
  name: "DefinitelyTyped",
  starred: false,
  dependencies: pkgs.map((pkg) => ({ ecosystem: "npm" as const, pkg, range: "^5.0.0", kind: "dev" as const, usedBy: ["me/app"] })),
});

test("DefinitelyTyped: only issues about a @types package you use are relevant", () => {
  const target = dtTarget("@types/express", "@types/node");
  const mine = scoreIssue(dt("[@types/express] req.query is typed wrong"), target, contrib);
  const notMine = scoreIssue(dt("[@types/sinon] 22.0.1 breaks named imports under ESM"), target, contrib);

  assert.ok(mine.reasons.some((r) => r.includes("@types/express")));
  assert.ok(notMine.reasons.includes("types for sinon, which you do not use"));
  assert.ok(!notMine.reasons.some((r) => r.includes("@types/express")), "must not credit an unrelated dependency");
  assert.ok(mine.score > notMine.score);
  assert.equal(notMine.score, 0); // 15 points of base signals minus 25, clamped at zero

  // No package named in the title: neutral, the other dependencies still apply.
  const generic = scoreIssue(dt("Tests fail on Windows when path contains spaces"), target, contrib);
  assert.ok(!generic.reasons.some((r) => r.includes("do not use")));
});

test("a severity word inside a file path is not a severity signal", () => {
  const plain = scoreIssue(issue("a/b", 1, { title: "Dead link in docs README", body: longBody }), starred("a/b"), contrib);
  for (const title of [
    "Dead link in security/sca/README.md",
    "Broken import in src/crash/handler.ts",
    "Typo in docs\\security\\policy.md",
  ]) {
    const r = scoreIssue(issue("a/b", 1, { title, body: longBody }), starred("a/b"), contrib);
    assert.ok(!r.reasons.some((x) => x.startsWith("title says")), title);
    assert.equal(r.score, plain.score, title);
  }
  // The same words outside a path still count.
  assert.ok(scoreIssue(issue("a/b", 1, { title: "Security hole in login", body: longBody }), starred("a/b"), contrib).score > plain.score);
  assert.ok(scoreIssue(issue("a/b", 1, { title: "Crash in src/main.ts on startup", body: longBody }), starred("a/b"), contrib).score > plain.score);
});
