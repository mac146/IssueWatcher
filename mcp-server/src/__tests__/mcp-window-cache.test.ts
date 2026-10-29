import assert from "node:assert/strict";
import { test } from "node:test";
import type { RankedParams } from "../mcp/radar.js";
import { fakeSource, HOUR, issueAgo, makeRadar, NOW, watch } from "./mcp-helpers.js";

const params = (sinceHours: number, extra: Partial<RankedParams> = {}): RankedParams => ({ sinceHours, limit: 10, minScore: 0, source: "both", ...extra });
const body = "The editor throws when the file is larger than two megabytes and the save button is pressed twice in a row.";
const numbers = (r: { issues: Array<{ number: number }> }) => r.issues.map((i) => i.number).sort((a, b) => a - b);

const data = () => ({
  "a/b": [issueAgo("a/b", 1, 2, { body }), issueAgo("a/b", 2, 30, { body }), issueAgo("a/b", 3, 60, { body }), issueAgo("a/b", 4, 100, { body }), issueAgo("a/b", 5, 300, { body })],
});

test("a question about a shorter window reuses what a longer one already loaded", async () => {
  const src = fakeSource(data());
  const radar = makeRadar(src, [watch("a/b")]);

  assert.deepEqual(numbers(await radar.ranked(params(168))), [1, 2, 3, 4]);
  assert.equal(src.calls.length, 1);

  assert.deepEqual(numbers(await radar.ranked(params(24))), [1], "filtered to the shorter window");
  assert.deepEqual(numbers(await radar.ranked(params(72))), [1, 2, 3]);
  assert.equal(src.calls.length, 1, "no further GitHub calls for windows already covered");
});

test("a question about a longer window than was loaded fetches again, once", async () => {
  const src = fakeSource(data());
  const radar = makeRadar(src, [watch("a/b")]);

  assert.deepEqual(numbers(await radar.ranked(params(24))), [1]);
  assert.equal(src.calls.length, 1);

  assert.deepEqual(numbers(await radar.ranked(params(720))), [1, 2, 3, 4, 5]);
  assert.equal(src.calls.length, 2, "the older issues needed a new fetch");

  await radar.ranked(params(500));
  assert.equal(src.calls.length, 2, "and that fetch now covers everything shorter");
});

test("even a short question loads at least three days, because it costs the same single request", async () => {
  const src = fakeSource(data());
  await makeRadar(src, [watch("a/b")]).ranked(params(6));
  assert.equal(src.calls.length, 1);
  assert.equal(src.calls[0]!.since.getTime(), NOW - 72 * HOUR);
});

test("questions about different windows at the same moment share one fetch per repo", async () => {
  const src = fakeSource(data(), 40);
  const radar = makeRadar(src, [watch("a/b")]);
  const [a, b] = await Promise.all([radar.ranked(params(24)), radar.ranked(params(72))]);
  assert.equal(src.calls.length, 1);
  assert.deepEqual(numbers(a), [1]);
  assert.deepEqual(numbers(b), [1, 2, 3]);
});

test("the shared cache still expires, and an expired entry is refetched", async () => {
  let now = NOW;
  const src = fakeSource(data());
  const radar = makeRadar(src, [watch("a/b")], { now: () => now, cacheTtlMs: 60_000 });
  await radar.ranked(params(72));
  now += 61_000;
  await radar.ranked(params(72));
  assert.equal(src.calls.length, 2);
});
