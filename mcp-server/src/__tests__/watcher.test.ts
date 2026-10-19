import assert from "node:assert/strict";
import { test } from "node:test";
import type { Digest } from "../digest.js";
import type { RepoState } from "../poller/types.js";
import { runCycle, type StateStore, type WatcherDeps } from "../watcher.js";
import { MemoryCache } from "../llm/cache.js";
import { fakeSource, issue, starred } from "./helpers.js";

function setup(opts: { mailFails?: boolean; summaryFails?: boolean } = {}) {
  let saved: RepoState | null = null;
  const sent: Digest[] = [];
  const store: StateStore = {
    load: async () => ({ "a/b": 1 }),
    save: async (s) => void (saved = s),
  };
  const deps: WatcherDeps = {
    source: fakeSource({ "a/b": [issue("a/b", 1), issue("a/b", 2), issue("a/b", 3)] }),
    targets: async () => [starred("a/b")],
    summarizer: {
      summarizeBatch: async (issues) => {
        if (opts.summaryFails) throw new Error("llm down");
        return issues.map(() => "sum");
      },
    },
    mailer: {
      sendDigest: async (d) => {
        if (opts.mailFails) throw new Error("smtp down");
        sent.push(d);
      },
    },
    cache: new MemoryCache(),
    maxBodyChars: 4000,
    cacheTtlSeconds: 3600,
    extractiveFallback: false,
    store,
    ignore: () => false,
    concurrency: 2,
    batchSize: 2,
    scoringMode: "both",
    minSummaryScore: 0,
    maxIssuesPerEmail: 10,
  };
  return { deps, sent, saved: () => saved };
}

test("saves state after a successful send", async () => {
  const t = setup();
  assert.equal(await runCycle(t.deps), 2);
  assert.equal(t.sent[0]!.top.length, 2);
  assert.deepEqual(t.saved(), { "a/b": 3 });
});

test("does not save state when the email fails", async () => {
  const t = setup({ mailFails: true });
  await assert.rejects(runCycle(t.deps), /smtp down/);
  assert.equal(t.saved(), null);
});

test("still sends the digest when summarisation fails", async () => {
  const t = setup({ summaryFails: true });
  await runCycle(t.deps);
  assert.equal(t.sent[0]!.top.length, 2);
  assert.ok(t.sent[0]!.top.every((e) => e.summary === null));
});

test("issues below the summary threshold are listed without an LLM call", async () => {
  const t = setup();
  t.deps.minSummaryScore = 90; // a plain starred repo scores about 20
  let llmCalls = 0;
  t.deps.summarizer = { summarizeBatch: async (i) => (llmCalls++, i.map(() => "x")) };
  await runCycle(t.deps);
  assert.equal(llmCalls, 0);
  assert.equal(t.sent[0]!.top.length, 0);
  assert.equal(t.sent[0]!.other.length, 2);
});

test("issues beyond the per-email cap move to the compact list", async () => {
  const t = setup();
  t.deps.maxIssuesPerEmail = 1;
  await runCycle(t.deps);
  assert.equal(t.sent[0]!.top.length, 1);
  assert.equal(t.sent[0]!.other.length, 1);
});

test("ignored issues are dropped but state still advances", async () => {
  const t = setup();
  t.deps.ignore = () => true;
  assert.equal(await runCycle(t.deps), 0);
  assert.equal(t.sent.length, 0);
  assert.deepEqual(t.saved(), { "a/b": 3 });
});
