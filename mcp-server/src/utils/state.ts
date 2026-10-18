import fs from "node:fs/promises";
import path from "node:path";
import type { RepoState } from "../poller/types.js";

const VERSION = 1;

type StateFile = { version: number; repos: RepoState };

function isRepoState(value: unknown): value is RepoState {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every(
      (v) => Array.isArray(v) && v.every((n) => Number.isInteger(n)),
    )
  );
}

/**
 * Loads persisted state. A missing file is a normal first run; a corrupt file
 * throws instead of resetting, which would re-report every issue.
 */
export async function loadState(file: string): Promise<RepoState> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`State file ${file} is corrupt; fix or delete it`, { cause: err });
  }

  const repos = (parsed as Partial<StateFile>)?.repos;
  if (!isRepoState(repos)) throw new Error(`State file ${file} has an unexpected shape`);
  return repos;
}

/** Atomic write (temp file + rename) so a crash never leaves a truncated file. */
export async function saveState(file: string, repos: RepoState): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const body: StateFile = { version: VERSION, repos };
  await fs.writeFile(tmp, JSON.stringify(body, null, 2), "utf-8");
  await fs.rename(tmp, file);
}
