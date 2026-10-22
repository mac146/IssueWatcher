import type { Issue, WatchTarget } from "../poller/types.js";
import { scoreIssue, type ScoreOptions } from "../scoring/score.js";

/** One issue offered for labelling. */
export type SampleRow = { id: string; repo: string; number: number; title: string; url: string };

/** What the ranking said about it; kept out of the labelling file so labels are blind. */
export type ScoreRecord = { id: string; score: number; reasons: string[]; createdAt: string };

export type Label = "useful" | "noise";

/** Small deterministic PRNG (mulberry32) so a sample can be reproduced from its seed. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** What is stored so the sample can be re-scored later with different weights. */
export type StoredItem = { issue: Issue; target: WatchTarget };

export function rescore(items: StoredItem[], opts: ScoreOptions): ScoreRecord[] {
  return items.map(({ issue, target }) => ({
    id: issueId(issue),
    createdAt: issue.createdAt,
    ...scoreIssue(issue, target, opts),
  }));
}

export const issueId = (i: Pick<Issue, "repo" | "number">) => `${i.repo}#${i.number}`;

/**
 * Picks `size` issues at random and scores them. The labelling file is shuffled
 * and carries no score, so the labeller cannot be swayed by the ranking.
 */
export function buildSample(
  pool: Array<{ issue: Issue; target: WatchTarget }>,
  size: number,
  seed: number,
  opts: ScoreOptions,
): { rows: SampleRow[]; items: StoredItem[] } {
  const rand = seededRandom(seed);
  const unique = [...new Map(pool.map((p) => [issueId(p.issue), p])).values()];
  const chosen = shuffle(unique, rand).slice(0, size);

  const rows = chosen.map(({ issue }) => ({
    id: issueId(issue),
    repo: issue.repo,
    number: issue.number,
    title: issue.title,
    url: issue.url,
  }));
  void opts; // the mode is applied later, when the stored items are scored
  return { rows, items: chosen };
}

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const LABEL_HEADER = ["id", "repo", "number", "title", "url", "label"] as const;

export function toCsv(rows: SampleRow[]): string {
  const lines = [LABEL_HEADER.join(",")];
  for (const r of rows) lines.push([r.id, r.repo, r.number, r.title, r.url, ""].map(csvCell).join(","));
  return lines.join("\n") + "\n";
}

/** Minimal RFC 4180 parser: quoted cells, doubled quotes, embedded commas and newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // strip a UTF-8 BOM added by some editors

  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== "")) rows.push(row);
  return rows;
}

const USEFUL = new Set(["u", "y", "yes", "1", "useful", "good", "true"]);
const NOISE = new Set(["n", "no", "0", "noise", "bad", "false"]);

/** Reads the labelled CSV. Blank labels are skipped; unrecognised ones are reported. */
export function parseLabels(csv: string): { labels: Map<string, Label>; unrecognised: string[] } {
  const [header, ...rows] = parseCsv(csv);
  if (!header) return { labels: new Map(), unrecognised: [] };
  const idCol = header.indexOf("id");
  const labelCol = header.indexOf("label");
  if (idCol < 0 || labelCol < 0) throw new Error('The CSV needs "id" and "label" columns');

  const labels = new Map<string, Label>();
  const unrecognised: string[] = [];
  for (const row of rows) {
    const id = row[idCol]?.trim();
    const raw = row[labelCol]?.trim().toLowerCase();
    if (!id || !raw) continue;
    if (USEFUL.has(raw)) labels.set(id, "useful");
    else if (NOISE.has(raw)) labels.set(id, "noise");
    else unrecognised.push(`${id}: "${raw}"`);
  }
  return { labels, unrecognised };
}

export type Report = {
  labelled: number;
  useful: number;
  /** Fraction of labelled issues that were useful: what random ordering would achieve. */
  baseRate: number;
  precisionAtK: Array<{ k: number; ranking: number; newestFirst: number; expectedRandom: number }>;
  /** Probability that a random useful issue outranks a random noise issue (0.5 = coin flip). */
  auc: number | null;
  reasonLift: Array<{ reason: string; n: number; usefulRate: number; withoutRate: number }>;
};

/** "mentions 1.6.x, you use ^1.6.0" and "42 reactions" become stable buckets. */
export function reasonBucket(reason: string): string {
  return reason
    .replace(/opened \d+h ago|opened just now/, "opened recently")
    .replace(/\(.*?\)/g, "")
    .replace(/mentions .*/, "mentions your version")
    .replace(/\d+ (reactions|comments)/, "$1")
    .replace(/crowded.*/, "crowded")
    .replace(/title says.*/, "severe word in title")
    .replace(/body mentions.*/, "severe word in body")
    .replace(/you depend on .*/, "you depend on it")
    .replace(/dev dependency .*/, "dev dependency")
    .replace(/used by \d+ of your repos/, "used by several of your repos")
    .trim();
}

function precisionAt(order: string[], labels: Map<string, Label>, k: number): number {
  const top = order.slice(0, k);
  return top.length ? top.filter((id) => labels.get(id) === "useful").length / top.length : 0;
}

export function buildReport(scores: ScoreRecord[], labels: Map<string, Label>): Report {
  const labelled = scores.filter((s) => labels.has(s.id));
  const useful = labelled.filter((s) => labels.get(s.id) === "useful").length;
  const baseRate = labelled.length ? useful / labelled.length : 0;

  const byScore = [...labelled].sort((a, b) => b.score - a.score).map((s) => s.id);
  const byNewest = [...labelled].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map((s) => s.id);

  const precisionAtK = [5, 10, 20]
    .filter((k) => k <= labelled.length)
    .map((k) => ({
      k,
      ranking: precisionAt(byScore, labels, k),
      newestFirst: precisionAt(byNewest, labels, k),
      expectedRandom: baseRate,
    }));

  // AUC by pairwise comparison; ties count half.
  const pos = labelled.filter((s) => labels.get(s.id) === "useful");
  const neg = labelled.filter((s) => labels.get(s.id) === "noise");
  let auc: number | null = null;
  if (pos.length && neg.length) {
    let wins = 0;
    for (const p of pos) for (const n of neg) wins += p.score > n.score ? 1 : p.score === n.score ? 0.5 : 0;
    auc = wins / (pos.length * neg.length);
  }

  const buckets = new Map<string, Set<string>>();
  for (const s of labelled) {
    for (const r of s.reasons) {
      const b = reasonBucket(r);
      if (!buckets.has(b)) buckets.set(b, new Set());
      buckets.get(b)!.add(s.id);
    }
  }
  const rate = (ids: string[]) => (ids.length ? ids.filter((id) => labels.get(id) === "useful").length / ids.length : 0);
  const reasonLift = [...buckets.entries()]
    .filter(([, ids]) => ids.size >= 5 && labelled.length - ids.size >= 5)
    .map(([reason, ids]) => ({
      reason,
      n: ids.size,
      usefulRate: rate([...ids]),
      withoutRate: rate(labelled.map((s) => s.id).filter((id) => !ids.has(id))),
    }))
    .sort((a, b) => b.usefulRate - b.withoutRate - (a.usefulRate - a.withoutRate));

  return { labelled: labelled.length, useful, baseRate, precisionAtK, auc, reasonLift };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function formatReport(r: Report): string {
  if (r.labelled < 20) {
    return `Only ${r.labelled} labelled issue(s). Label at least 40 (ideally 100) for the numbers to mean anything.`;
  }
  const lines = [
    `Labelled issues: ${r.labelled} (${r.useful} useful, ${r.labelled - r.useful} noise; ${pct(r.baseRate)} useful overall)`,
    "",
    "Precision of the top-k (share of the top k that you called useful):",
    "  top-k   ranking   newest-first   random",
    ...r.precisionAtK.map(
      (p) => `  ${String(p.k).padStart(5)}   ${pct(p.ranking).padStart(7)}   ${pct(p.newestFirst).padStart(12)}   ${pct(p.expectedRandom).padStart(6)}`,
    ),
    "",
    r.auc === null
      ? "AUC: needs at least one useful and one noise label."
      : `AUC: ${r.auc.toFixed(2)}  (1.00 = every useful issue outranks every noise issue, 0.50 = no better than chance)`,
  ];
  if (r.reasonLift.length) {
    lines.push("", "Signals ranked by how much they separate useful from noise (n = issues with the signal):");
    for (const x of r.reasonLift) {
      lines.push(`  ${x.reason.padEnd(34)} n=${String(x.n).padStart(3)}   useful ${pct(x.usefulRate).padStart(4)} with it, ${pct(x.withoutRate).padStart(4)} without`);
    }
  }
  if (r.labelled < 60) lines.push("", `With only ${r.labelled} labels the differences are rough; treat them as hints.`);
  return lines.join("\n");
}
