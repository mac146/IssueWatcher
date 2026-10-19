import assert from "node:assert/strict";
import { test } from "node:test";
import { pollOnce } from "../poller/poller.js";
import { fakeSource, issue, starred } from "./helpers.js";

const targets = (...repos: string[]) => repos.map(starred);

test("seeds unknown repos silently at their high-water mark", async () => {
  const src = fakeSource({ "a/b": [issue("a/b", 1), issue("a/b", 2)] });
  const { newIssues, nextState } = await pollOnce(src, targets("a/b"), {});
  assert.equal(newIssues.length, 0);
  assert.deepEqual(nextState, { "a/b": 2 });
});

test("reports only issues above the high-water mark", async () => {
  const src = fakeSource({ "a/b": [issue("a/b", 1), issue("a/b", 3), issue("a/b", 4)] });
  const { newIssues, nextState } = await pollOnce(src, targets("a/b"), { "a/b": 3 });
  assert.deepEqual(newIssues.map((p) => p.issue.number), [4]);
  assert.deepEqual(nextState, { "a/b": 4 });
});

test("keeps previous state when a repo fetch fails", async () => {
  const src = fakeSource({ "a/b": new Error("boom"), "c/d": [issue("c/d", 5)] });
  const { newIssues, nextState } = await pollOnce(src, targets("a/b", "c/d"), { "a/b": 2, "c/d": 3 });
  assert.equal(nextState["a/b"], 2);
  assert.deepEqual(newIssues.map((p) => p.issue.number), [5]);
});

test("a repo whose first fetch fails is not recorded, so it is seeded later", async () => {
  const src = fakeSource({ "a/b": new Error("boom") });
  const { nextState } = await pollOnce(src, targets("a/b"), {});
  assert.deepEqual(nextState, {});
});

test("does not mutate input state and drops repos no longer watched", async () => {
  const state = { "gone/repo": 1 };
  const { nextState } = await pollOnce(fakeSource({ "a/b": [] }), targets("a/b"), state);
  assert.deepEqual(state, { "gone/repo": 1 });
  assert.deepEqual(Object.keys(nextState), ["a/b"]);
});

test("each new issue carries the watch target it came from", async () => {
  const target = { ...starred("a/b"), starred: false };
  const src = fakeSource({ "a/b": [issue("a/b", 2)] });
  const { newIssues } = await pollOnce(src, [target], { "a/b": 1 });
  assert.equal(newIssues[0]!.target, target);
});
