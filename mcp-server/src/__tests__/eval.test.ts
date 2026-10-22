import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildReport,
  buildSample,
  formatReport,
  parseCsv,
  parseLabels,
  rescore,
  reasonBucket,
  seededRandom,
  toCsv,
  type Label,
  type ScoreRecord,
} from "../eval/eval.js";
import { issue, starred } from "./helpers.js";

const pool = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ issue: issue("a/b", i + 1, { title: `Issue ${i + 1}` }), target: starred("a/b") }));

test("seeded random is reproducible", () => {
  const a = seededRandom(7);
  const b = seededRandom(7);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  assert.notEqual(seededRandom(8)(), seededRandom(7)());
});

test("buildSample is deterministic per seed, de-duplicated and size-limited", () => {
  const dup = [...pool(30), ...pool(5)];
  const one = buildSample(dup, 10, 1, { mode: "both" });
  const again = buildSample(dup, 10, 1, { mode: "both" });
  assert.deepEqual(one.rows.map((r) => r.id), again.rows.map((r) => r.id));
  assert.equal(one.rows.length, 10);
  assert.equal(new Set(one.rows.map((r) => r.id)).size, 10);
  assert.notDeepEqual(one.rows.map((r) => r.id), buildSample(dup, 10, 2, { mode: "both" }).rows.map((r) => r.id));
  assert.equal(buildSample(pool(3), 10, 1, { mode: "both" }).rows.length, 3);
});

test("the labelling file hides scores", () => {
  const { rows } = buildSample(pool(5), 5, 1, { mode: "both" });
  const csv = toCsv(rows);
  assert.ok(csv.startsWith("id,repo,number,title,url,label\n"));
  assert.ok(!/score|reason/i.test(csv));
});

test("CSV round-trips commas, quotes and newlines in titles", () => {
  const rows = [{ id: "a/b#1", repo: "a/b", number: 1, title: 'He said "hi", twice\nand left', url: "u" }];
  const parsed = parseCsv(toCsv(rows));
  assert.equal(parsed[1]![3], 'He said "hi", twice\nand left');
  assert.equal(parsed[1]![5], "");
});

test("parseLabels understands common spellings, skips blanks and reports junk", () => {
  const csv = "id,repo,number,title,url,label\na#1,a,1,t,u,U\na#2,a,2,t,u,no\na#3,a,3,t,u,\na#4,a,4,t,u,maybe\na#5,a,5,t,u, y \n";
  const { labels, unrecognised } = parseLabels(csv);
  assert.deepEqual([...labels], [["a#1", "useful"], ["a#2", "noise"], ["a#5", "useful"]]);
  assert.deepEqual(unrecognised, ['a#4: "maybe"']);
  assert.throws(() => parseLabels("id,title\n1,x"), /"id" and "label"/);
});

const rec = (id: string, score: number, reasons: string[] = [], createdAt = "2026-01-01T00:00:00Z"): ScoreRecord => ({ id, score, reasons, createdAt });

test("a perfect ranking scores precision 100% and AUC 1.0", () => {
  const scores = Array.from({ length: 30 }, (_, i) => rec(`i${i}`, 100 - i));
  const labels = new Map<string, Label>(scores.map((s, i) => [s.id, i < 10 ? "useful" : "noise"]));
  const r = buildReport(scores, labels);
  assert.equal(r.precisionAtK.find((p) => p.k === 10)!.ranking, 1);
  assert.equal(r.auc, 1);
  assert.equal(r.useful, 10);
  assert.ok(Math.abs(r.baseRate - 1 / 3) < 1e-9);
});

test("a reversed ranking scores AUC 0 and a constant score is a coin flip", () => {
  const ids = Array.from({ length: 20 }, (_, i) => `i${i}`);
  const labels = new Map<string, Label>(ids.map((id, i) => [id, i < 10 ? "useful" : "noise"]));
  assert.equal(buildReport(ids.map((id, i) => rec(id, i)), labels).auc, 0);
  assert.equal(buildReport(ids.map((id) => rec(id, 50)), labels).auc, 0.5);
});

test("newest-first baseline uses creation time, and unlabelled issues are ignored", () => {
  const scores = [
    rec("old-useful", 90, [], "2026-01-01T00:00:00Z"),
    rec("new-noise", 10, [], "2026-06-01T00:00:00Z"),
    ...Array.from({ length: 22 }, (_, i) => rec(`x${i}`, 50, [], `2026-02-${String((i % 27) + 1).padStart(2, "0")}T00:00:00Z`)),
    rec("skipped", 99),
  ];
  const labels = new Map<string, Label>([["old-useful", "useful"], ["new-noise", "noise"], ...Array.from({ length: 22 }, (_, i) => [`x${i}`, "noise"] as [string, Label])]);
  const r = buildReport(scores, labels);
  assert.equal(r.labelled, 24);
  assert.equal(r.precisionAtK.find((p) => p.k === 5)!.ranking, 0.2);
  assert.equal(r.precisionAtK.find((p) => p.k === 5)!.newestFirst, 0);
});

test("reason buckets merge numbers and versions; lift needs enough evidence", () => {
  assert.equal(reasonBucket("opened 3h ago"), reasonBucket("opened 17h ago"));
  assert.equal(reasonBucket("mentions 1.6.x, you use ^1.6.0"), "mentions your version");
  assert.equal(reasonBucket("crowded (14 comments)"), "crowded");

  const scores = Array.from({ length: 20 }, (_, i) => rec(`i${i}`, i, i < 8 ? ["good first issue"] : ["starred repo"]));
  const labels = new Map<string, Label>(scores.map((s, i) => [s.id, i < 6 ? "useful" : "noise"]));
  const gfi = buildReport(scores, labels).reasonLift.find((x) => x.reason === "good first issue")!;
  assert.equal(gfi.n, 8);
  assert.ok(gfi.usefulRate > gfi.withoutRate);
  assert.equal(buildReport(scores.slice(0, 6), new Map(labels)).reasonLift.length, 0); // too few samples
});

test("the report refuses to over-claim from a handful of labels", () => {
  const scores = [rec("a", 1), rec("b", 2)];
  const out = formatReport(buildReport(scores, new Map<string, Label>([["a", "useful"], ["b", "noise"]])));
  assert.match(out, /Only 2 labelled/);
});

test("buildSample returns the chosen issues so they can be re-scored later", () => {
  const { rows, items } = buildSample(pool(12), 5, 3, { mode: "both" });
  assert.deepEqual(items.map((i) => `${i.issue.repo}#${i.issue.number}`), rows.map((r) => r.id));
});

test("rescore reflects the scoring mode, so weights can be judged against fixed labels", () => {
  const items = [{ issue: issue("a/b", 1, { labels: ["good first issue"] }), target: starred("a/b") }];
  const contributor = rescore(items, { mode: "contributor" })[0]!;
  const consumer = rescore(items, { mode: "consumer" })[0]!;
  assert.ok(contributor.score > consumer.score);
  assert.equal(contributor.id, "a/b#1");
});
