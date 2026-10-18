import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadState, saveState } from "../utils/state.js";

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "iw-"));

test("missing file yields empty state", async () => {
  assert.deepEqual(await loadState(path.join(await tmp(), "nope.json")), {});
});

test("round-trips and creates missing directories", async () => {
  const file = path.join(await tmp(), "nested", "state.json");
  await saveState(file, { "a/b": [1, 2] });
  assert.deepEqual(await loadState(file), { "a/b": [1, 2] });
});

test("corrupt file throws instead of resetting", async () => {
  const file = path.join(await tmp(), "state.json");
  await fs.writeFile(file, "{not json");
  await assert.rejects(loadState(file), /corrupt/);
});
