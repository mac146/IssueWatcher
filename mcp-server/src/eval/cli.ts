import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config.js";
import { GitHubAPI } from "../github/api.js";
import { logger } from "../logger.js";
import type { Issue, WatchTarget } from "../poller/types.js";
import type { ScoringMode } from "../scoring/score.js";
import { createTargetProvider } from "../targets.js";
import { buildReport, buildSample, formatReport, parseCsv, parseLabels, rescore, toCsv, type StoredItem } from "./eval.js";

const DIR = path.resolve("eval");
const CSV = path.join(DIR, "labels.csv");
const SAMPLE = path.join(DIR, "sample.json");

type StoredSample = { mode: ScoringMode; seed: number; items: StoredItem[] };

const arg = (name: string, fallback: number) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  const n = found ? Number(found.split("=")[1]) : fallback;
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

async function exportSample(): Promise<void> {
  const size = arg("size", 100);
  const perRepo = arg("per-repo", 4);
  const seed = arg("seed", 42);

  if (await fs.stat(CSV).then(() => true, () => false)) {
    const { labels } = parseLabels(await fs.readFile(CSV, "utf-8"));
    if (labels.size > 0 && !process.argv.includes("--force")) {
      throw new Error(
        `${CSV} already has ${labels.size} label(s). Exporting would overwrite them.\n` +
          "Use a different folder, move the file, or pass --force if you really want a new sample.",
      );
    }
  }

  const config = loadConfig({ ...process.env, DRY_RUN: "true" });
  const github = new GitHubAPI(config.githubToken);
  const targets = await createTargetProvider(config, github)();
  logger.info(`Collecting up to ${perRepo} recent open issues from each of ${targets.length} repos...`);

  const pool: StoredItem[] = [];
  for (const target of targets) {
    try {
      for (const issue of await github.getRecentOpenIssues(target.owner, target.name, perRepo)) pool.push({ issue, target });
    } catch (err) {
      logger.warn(`Skipping ${target.owner}/${target.name}`, err);
    }
  }

  const { rows, items } = buildSample(pool, size, seed, { mode: config.scoringMode });
  await fs.mkdir(DIR, { recursive: true });
  await fs.writeFile(CSV, toCsv(rows), "utf-8");
  const sample: StoredSample = { mode: config.scoringMode, seed, items };
  await fs.writeFile(SAMPLE, JSON.stringify(sample), "utf-8");

  console.log(`\nWrote ${rows.length} issues (of ${pool.length} collected) to ${CSV}`);
  console.log(`Scoring mode: ${config.scoringMode}. The issues are stored in ${SAMPLE}; the CSV has no scores, so your labels stay blind.`);
  console.log(
    "\nNext: open labels.csv, read each issue (the url column) and fill the label column with\n" +
      "  u  if you would genuinely want to be told about it (or might pick it up)\n" +
      "  n  if it is noise to you\n" +
      "Leave unsure ones blank. Then run: npm run eval:report",
  );
}

/**
 * One-time upgrade for a sheet exported before samples were stored: re-fetches the
 * issues listed in labels.csv so they can be re-scored. Existing labels are untouched.
 */
async function rebuildSample(): Promise<void> {
  const rows = parseCsv(await fs.readFile(CSV, "utf-8"));
  const header = rows.shift() ?? [];
  const col = (name: string) => header.indexOf(name);
  if (col("repo") < 0 || col("number") < 0) throw new Error("labels.csv must have repo and number columns");

  const config = loadConfig({ ...process.env, DRY_RUN: "true" });
  const github = new GitHubAPI(config.githubToken);
  const targets = await createTargetProvider(config, github)();
  const byRepo = new Map<string, WatchTarget>(targets.map((t) => [`${t.owner}/${t.name}`.toLowerCase(), t]));

  const items: StoredItem[] = [];
  let missing = 0;
  for (const r of rows) {
    const repo = r[col("repo")]!;
    const target = byRepo.get(repo.toLowerCase());
    const [owner, name] = repo.split("/");
    let issue: Issue | null = null;
    try {
      issue = target && owner && name ? await github.getIssue(owner, name, Number(r[col("number")])) : null;
    } catch (err) {
      logger.warn(`Could not fetch ${repo}#${r[col("number")]}`, err);
    }
    if (issue && target) items.push({ issue, target });
    else missing++;
  }
  const sample: StoredSample = { mode: config.scoringMode, seed: 0, items };
  await fs.writeFile(SAMPLE, JSON.stringify(sample), "utf-8");
  console.log(`Rebuilt ${SAMPLE} with ${items.length} issue(s)${missing ? ` (${missing} could not be fetched and are skipped)` : ""}.`);
  console.log("Scoring mode:", config.scoringMode, "- your labels in labels.csv were not changed.");
}

async function report(): Promise<void> {
  const [csv, raw] = await Promise.all([fs.readFile(CSV, "utf-8"), fs.readFile(SAMPLE, "utf-8")]).catch(() => {
    throw new Error("Missing eval files. Run `npm run eval:export` (new sheet) or `npm run eval:rebuild` (existing labels.csv).");
  });
  const { labels, unrecognised } = parseLabels(csv);
  const sample = JSON.parse(raw) as StoredSample;

  if (unrecognised.length) {
    console.log(`Ignored ${unrecognised.length} label(s) that are not u/n:\n  ${unrecognised.slice(0, 5).join("\n  ")}\n`);
  }
  // Re-scored with the CURRENT scoring code, so weight changes can be judged on the same labels.
  const scores = rescore(sample.items, { mode: sample.mode });
  console.log(`Scoring mode: ${sample.mode} (issues re-scored with the current weights)\n`);
  console.log(formatReport(buildReport(scores, labels)));
}

const commands: Record<string, () => Promise<void>> = { export: exportSample, rebuild: rebuildSample, report };
const run = commands[process.argv[2] ?? ""];
(run ? run() : Promise.reject(new Error("Usage: cli.ts export|rebuild|report"))).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
