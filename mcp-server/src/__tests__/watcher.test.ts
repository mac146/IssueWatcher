import assert from "node:assert/strict";
import { test } from "node:test";
import { runCycle, type StateStore, type WatcherDeps } from "../watcher.js";
import type { RepoState } from "../poller/types.js";
import { fakeSource, issue } from "./helpers.js";

function setup(opts: { mailFails?: boolean; summaryFails?: boolean } = {}) {
  let saved: RepoState | null = null;
  const sent: number[] = [];
  const store: StateStore = {
    load: async () => ({ "a/b": [1] }),
    save: async (s) => void (saved = s),
  };
  const deps: WatcherDeps = {
    source: fakeSource({ "a/b": [issue("a/b", 1), issue("a/b", 2), issue("a/b", 3)] }),
    summarizer: {
      summarizeBatch: async (issues) => {
        if (opts.summaryFails) throw new Error("llm down");
        return issues.map(() => "sum");
      },
    },
    mailer: {
      sendDigest: async (items) => {
        if (opts.mailFails) throw new Error("smtp down");
        sent.push(items.length);
      },
    },
    store,
    concurrency: 2,
    batchSize: 2,
    maxIssuesPerEmail: 10,
  };
  return { deps, sent, saved: () => saved };
}

test("saves state after a successful send", async () => {
  const t = setup();
  assert.equal(await runCycle(t.deps), 2);
  assert.deepEqual(t.sent, [2]);
  assert.deepEqual(t.saved(), { "a/b": [1, 2, 3] });
});

test("does not save state when the email fails", async () => {
  const t = setup({ mailFails: true });
  await assert.rejects(runCycle(t.deps), /smtp down/);
  assert.equal(t.saved(), null);
});

test("still sends the digest when summarisation fails", async () => {
  const t = setup({ summaryFails: true });
  await runCycle(t.deps);
  assert.deepEqual(t.sent, [2]);
});

test("issues beyond the per-email summary cap are still listed", async () => {
  const t = setup();
  t.deps.maxIssuesPerEmail = 1;
  await runCycle(t.deps);
  assert.deepEqual(t.sent, [2]);
});
