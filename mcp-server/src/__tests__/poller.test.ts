import assert from "node:assert/strict";
import { test } from "node:test";
import { pollOnce } from "../poller/poller.js";
import { fakeSource, issue } from "./helpers.js";

test("seeds unknown repos silently", async () => {
  const src = fakeSource({ "a/b": [issue("a/b", 1), issue("a/b", 2)] });
  const { newIssues, nextState } = await pollOnce(src, {});
  assert.equal(newIssues.length, 0);
  assert.deepEqual(nextState, { "a/b": [1, 2] });
});

test("reports only issues not in state", async () => {
  const src = fakeSource({ "a/b": [issue("a/b", 1), issue("a/b", 3)] });
  const { newIssues, nextState } = await pollOnce(src, { "a/b": [1, 2] });
  assert.deepEqual(newIssues.map((i) => i.number), [3]);
  assert.deepEqual(nextState, { "a/b": [1, 3] });
});

test("keeps previous state when a repo fetch fails", async () => {
  const src = fakeSource({ "a/b": new Error("boom"), "c/d": [issue("c/d", 5)] });
  const { newIssues, nextState } = await pollOnce(src, { "a/b": [1, 2], "c/d": [] });
  assert.deepEqual(nextState["a/b"], [1, 2]);
  assert.deepEqual(newIssues.map((i) => i.number), [5]);
});

test("does not mutate input state and drops unstarred repos", async () => {
  const state = { "gone/repo": [1] };
  const { nextState } = await pollOnce(fakeSource({ "a/b": [] }), state);
  assert.deepEqual(state, { "gone/repo": [1] });
  assert.deepEqual(Object.keys(nextState), ["a/b"]);
});
