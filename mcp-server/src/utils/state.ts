import fs from "node:fs/promises";
import path from "node:path";
import type { RepoState } from "../poller/types.js";

const VERSION = 2;

type StateFile = { version: number; repos: RepoState };

function isHighWaterState(value: unknown): value is RepoState {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every((n) => Number.isInteger(n) && (n as number) >= 0)
  );
}

/** v1 stored every open issue number per repo; the high-water mark is their maximum. */
function migrateV1(value: unknown): RepoState | null {
  if (typeof value !== "object" || value === null) return null;
  const out: RepoState = {};
  for (const [repo, numbers] of Object.entries(value)) {
    if (!Array.isArray(numbers) || !numbers.every((n) => Number.isInteger(n))) return null;
    out[repo] = numbers.length ? Math.max(...numbers) : 0;
  }
  return out;
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

  let parsed: Partial<StateFile>;
  try {
    parsed = JSON.parse(raw) as Partial<StateFile>;
  } catch (err) {
    throw new Error(`State file ${file} is corrupt; fix or delete it`, { cause: err });
  }

  const repos = parsed?.repos;
  if (parsed?.version === VERSION && isHighWaterState(repos)) return repos;
  const migrated = migrateV1(repos);
  if (migrated) return migrated;
  throw new Error(`State file ${file} has an unexpected shape`);
}

/** Atomic write (temp file + rename) so a crash never leaves a truncated file. */
export async function saveState(file: string, repos: RepoState): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const body: StateFile = { version: VERSION, repos };
  await fs.writeFile(tmp, JSON.stringify(body, null, 2), "utf-8");
  await fs.rename(tmp, file);
}
