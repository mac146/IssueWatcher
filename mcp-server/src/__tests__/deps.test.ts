import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CachedDiscovery, discoverDependencies, type ManifestSource } from "../deps/discovery.js";
import { minVersion, parsePackageJson, parseRequirementsTxt } from "../deps/manifests.js";
import { githubRepoFromUrl, type Registry } from "../deps/registry.js";
import { buildTargets } from "../targets.js";

test("package.json: runtime and dev deps, skipping non-registry specs", () => {
  const deps = parsePackageJson(
    JSON.stringify({
      dependencies: { axios: "^1.6.0", local: "file:../x", gitdep: "github:o/r", alias: "npm:other@1" },
      devDependencies: { typescript: "~5.4.0" },
    }),
  );
  assert.deepEqual(
    deps.map((d) => [d.pkg, d.range, d.kind]),
    [
      ["axios", "^1.6.0", "runtime"],
      ["typescript", "~5.4.0", "dev"],
    ],
  );
});

test("package.json: invalid JSON yields nothing", () => {
  assert.deepEqual(parsePackageJson("{nope"), []);
});

test("requirements.txt: pins, ranges, extras, markers, comments and flags", () => {
  const deps = parseRequirementsTxt(
    [
      "# comment",
      "-r other.txt",
      "Flask==2.3.1",
      "requests[security]>=2.28,<3  # inline",
      "numpy ; python_version < '3.9'",
      "git+https://github.com/o/r.git",
      "My_Package.name==1.0",
    ].join("\n"),
  );
  assert.deepEqual(
    deps.map((d) => [d.pkg, d.range]),
    [
      ["flask", "==2.3.1"],
      ["requests", ">=2.28,<3"],
      ["numpy", "*"],
      ["my-package-name", "==1.0"],
    ],
  );
});

test("minVersion reads the lowest version a range allows", () => {
  assert.deepEqual(minVersion("^1.6.0"), { major: 1, minor: 6 });
  assert.deepEqual(minVersion(">=2.1,<3"), { major: 2, minor: 1 });
  assert.deepEqual(minVersion("==4.0.1"), { major: 4, minor: 0 });
  assert.deepEqual(minVersion("3.x"), { major: 3, minor: 0 });
  assert.equal(minVersion("*"), null);
});

test("githubRepoFromUrl handles the common spellings", () => {
  for (const url of [
    "git+https://github.com/axios/axios.git",
    "https://github.com/axios/axios",
    "git://github.com/axios/axios.git",
    "git@github.com:axios/axios.git",
    "github:axios/axios",
    "axios/axios",
    "https://github.com/axios/axios/tree/main/packages/x",
    "https://github.com/axios/axios#readme",
  ]) {
    assert.equal(githubRepoFromUrl(url), "axios/axios", url);
  }
  assert.equal(githubRepoFromUrl("https://gitlab.com/o/r"), null);
  assert.equal(githubRepoFromUrl(undefined), null);
});

const files: Record<string, string> = {
  "me/app1/package.json": JSON.stringify({ dependencies: { axios: "^1.6.0", left: "1.0.0" } }),
  "me/app2/package.json": JSON.stringify({ dependencies: { axios: "^1.5.0" }, devDependencies: { vitest: "^1.0.0" } }),
  "me/svc/requirements.txt": "flask==2.3.1\n",
};
const source: ManifestSource = {
  listOwnRepos: async () => [
    { owner: "me", name: "app1", pushedAt: "2026-10-01T00:00:00Z" },
    { owner: "me", name: "app2", pushedAt: "2026-09-01T00:00:00Z" },
    { owner: "me", name: "svc", pushedAt: "2026-08-01T00:00:00Z" },
    { owner: "me", name: "old", pushedAt: "2019-01-01T00:00:00Z" },
  ],
  getFile: async (o, r, f) => files[`${o}/${r}/${f}`] ?? null,
};
const registry: Registry = {
  resolve: async (_eco, pkg) =>
    ({ axios: "axios/axios", vitest: "vitest-dev/vitest", flask: "pallets/flask" })[pkg] ?? null,
};
const opts = { repos: [], maxRepos: 20, maxDependencies: 100, activeWithinDays: 365 };
const NOW = Date.parse("2026-10-18T00:00:00Z");

test("discovery aggregates usage across repos and maps packages to source repos", async () => {
  const map = await discoverDependencies(source, registry, opts, () => NOW);
  assert.deepEqual(Object.keys(map).sort(), ["axios/axios", "pallets/flask", "vitest-dev/vitest"]);
  const axios = map["axios/axios"]![0]!;
  assert.deepEqual(axios.usedBy, ["me/app1", "me/app2"]);
  assert.equal(axios.kind, "runtime");
  assert.equal(map["vitest-dev/vitest"]![0]!.kind, "dev");
  assert.equal(map["left/left"], undefined); // unresolved packages are skipped
});

test("discovery respects explicit repos and the dependency cap", async () => {
  const explicit = await discoverDependencies(source, registry, { ...opts, repos: ["me/svc"] }, () => NOW);
  assert.deepEqual(Object.keys(explicit), ["pallets/flask"]);

  const capped = await discoverDependencies(source, registry, { ...opts, maxDependencies: 1 }, () => NOW);
  assert.deepEqual(Object.keys(capped), ["axios/axios"]); // most widely used wins
});

test("cached discovery reuses fresh results and falls back to stale ones on failure", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "iw-"));
  const file = path.join(dir, "dependencies.json");
  let clock = 1_000;
  let runs = 0;
  let failing = false;
  const run = async () => {
    runs++;
    if (failing) throw new Error("github down");
    return { "a/b": [] };
  };
  const cache = new CachedDiscovery(run, file, 100, () => clock);

  assert.deepEqual(await cache.get(), { "a/b": [] });
  clock += 50;
  await cache.get();
  assert.equal(runs, 1); // still fresh

  clock += 100;
  failing = true;
  assert.deepEqual(await cache.get(), { "a/b": [] }); // stale cache beats an empty list
  assert.equal(runs, 2);
});

test("buildTargets merges starred repos and dependencies case-insensitively", () => {
  const targets = buildTargets(
    [{ owner: "Axios", name: "axios" }, { owner: "x", name: "y" }],
    {
      "axios/axios": [{ ecosystem: "npm", pkg: "axios", range: "^1", kind: "runtime", usedBy: ["me/a"] }],
      "pallets/flask": [{ ecosystem: "pypi", pkg: "flask", range: "==2", kind: "runtime", usedBy: ["me/s"] }],
    },
  );
  assert.equal(targets.length, 3);
  const axios = targets.find((t) => t.name === "axios")!;
  assert.equal(axios.owner, "Axios"); // keeps GitHub's spelling
  assert.equal(axios.starred, true);
  assert.equal(axios.dependencies.length, 1);
  assert.equal(targets.find((t) => t.name === "flask")!.starred, false);
});

test("a registry lookup survives a dropped connection and a 503, but a 404 is just 'no repo'", async () => {
  const { HttpRegistry } = await import("../deps/registry.js");
  const fail = (response?: { status: number }) => Object.assign(new Error("x"), { isAxiosError: true, response });
  const script = [fail(), fail({ status: 503 })];
  let calls = 0;
  const client = {
    get: async () => {
      calls++;
      const next = script.shift();
      if (next) throw next;
      return { data: { repository: "git+https://github.com/o/r.git" } };
    },
  } as never;
  assert.equal(await new HttpRegistry(client).resolve("npm", "pkg"), "o/r");
  assert.equal(calls, 3);

  const missing = { get: async () => { throw fail({ status: 404 }); } } as never;
  assert.equal(await new HttpRegistry(missing).resolve("npm", "nope"), null);
});

test("a registry timeout is not retried, and a map built during an outage expires early", async () => {
  const { HttpRegistry } = await import("../deps/registry.js");
  const { incompleteMaps } = await import("../deps/discovery.js");
  let calls = 0;
  const timeout = Object.assign(new Error("timeout"), { isAxiosError: true, code: "ECONNABORTED" });
  const hung = { get: async () => { calls++; throw timeout; } } as never;
  await assert.rejects(new HttpRegistry(hung).resolve("pypi", "pydantic"));
  assert.equal(calls, 1);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "iw-inc-"));
  const file = path.join(dir, "dependencies.json");
  const DAY = 24 * 3_600_000;
  let clock = 1_000_000_000;
  const incomplete = {} as import("../deps/discovery.js").DependencyMap;
  incompleteMaps.add(incomplete);
  let runs = 0;
  const cache = new CachedDiscovery(async () => (++runs === 1 ? incomplete : { "o/r": [] }), file, DAY, () => clock);
  await cache.get();
  clock += 5 * 60_000; // inside the 15-minute retry window: served from the cache
  await cache.get();
  assert.equal(runs, 1);
  clock += 11 * 60_000; // past it: rebuilt, long before a day
  await cache.get();
  assert.equal(runs, 2);
});
