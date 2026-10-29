import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client as V1Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport as V1Stdio } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { startStub, type Stub } from "./stub-github.js";

const MAIN = fileURLToPath(new URL("../mcp/main.js", import.meta.url));
const PKG = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")) as { version: string };
const T = { timeout: 90_000 };

/** A minimal environment, so a developer's real tokens never leak into a test. */
function envFor(stub: Stub, extra: Record<string, string> = {}): Record<string, string> {
  const base: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    ISSUEWATCHER_GITHUB_API_URL: stub.url,
    ISSUEWATCHER_NPM_URL: `${stub.url}/npm`,
    ISSUEWATCHER_PYPI_URL: `${stub.url}/pypi`,
    ISSUEWATCHER_CACHE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "iw-mcp-")),
  };
  if (process.env.SystemRoot) base.SystemRoot = process.env.SystemRoot; // required by Node on Windows
  return { ...base, ...extra };
}

async function withStub<R>(fn: (stub: Stub) => Promise<R>): Promise<R> {
  const stub = await startStub();
  try {
    return await fn(stub);
  } finally {
    await stub.close();
  }
}

type Json = { issues: Array<{ repo: string; number: number; title: string; url: string; labels: string[]; relation: { starred: boolean; dependencies: Array<{ package: string }> } }>; partial: boolean };
const textOf = (r: { content: unknown }) => (r.content as Array<{ text: string }>).map((c) => c.text).join("\n");

test("stdout carries only JSON-RPC: logs go to stderr, and closing stdin stops the server", T, async () => {
  await withStub(async (stub) => {
    const child = spawn(process.execPath, [MAIN], { env: envFor(stub, { GITHUB_TOKEN: "test-token" }), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));

    const send = (msg: unknown) => child.stdin.write(JSON.stringify(msg) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "raw", version: "1" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_ranked_issues", arguments: { since: "3d" } } });

    const deadline = Date.now() + 60_000;
    while (!out.includes('"id":3') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    child.stdin.end();
    const code = await exited;

    const lines = out.split("\n").filter(Boolean);
    assert.ok(lines.length >= 3, `expected at least 3 responses, got ${lines.length}`);
    for (const line of lines) {
      const parsed = JSON.parse(line) as { jsonrpc?: string };
      assert.equal(parsed.jsonrpc, "2.0", `stdout line is not JSON-RPC: ${line.slice(0, 80)}`);
    }
    assert.match(err, /ready/, "startup message goes to stderr");
    assert.ok(!err.includes("test-token"), "the token must never be logged");
    assert.equal(code, 0);
  });
});

test("the new SDK (v2) client lists tools and gets ranked issues over real stdio", T, async () => {
  await withStub(async (stub) => {
    const client = new Client({ name: "v2-e2e", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [MAIN], env: envFor(stub, { GITHUB_TOKEN: "test-token", SCORING_MODE: "contributor" }) }));
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name), ["get_ranked_issues", "explain_issue", "list_watched_repos"]);

      const r = await client.callTool({ name: "get_ranked_issues", arguments: { since: "3d" } });
      assert.ok(!r.isError, textOf(r));
      const s = r.structuredContent as unknown as Json;
      const names = s.issues.map((i) => `${i.repo}#${i.number}`);
      assert.ok(names.includes("acme/web#101"), `got ${names.join(", ")}`);
      assert.ok(names.includes("lib/leftpad#55"), "issues from a dependency's repo are included");
      assert.ok(!names.includes("acme/web#90"), "an issue older than the window is excluded");
      assert.equal(s.partial, false);

      const dep = s.issues.find((i) => i.repo === "lib/leftpad")!;
      assert.equal(dep.relation.starred, false);
      assert.equal(dep.relation.dependencies[0]!.package, "leftpad", "the dependency was discovered from package.json");

      // Contributor mode rates a crash-labelled bug above a plain good-first-issue; either may lead.
      const first = s.issues[0]!;
      assert.equal(first.repo, "acme/web");
      for (const i of s.issues) {
        assert.equal(i.url, `https://github.com/${i.repo}/issues/${i.number}`, "URLs are rebuilt, never copied from the API (the stub's html_url is a decoy)");
      }
      const gfi = s.issues.find((i) => i.number === 101)!;
      assert.ok(gfi.labels.includes("good first issue"));

      assert.ok(stub.requests.some((q) => q.auth === "Bearer test-token"), "the token is sent to GitHub");
    } finally {
      await client.close();
    }
  });
});

test("an older client generation (SDK v1, which sends initialize) works against the same server", T, async () => {
  await withStub(async (stub) => {
    const client = new V1Client({ name: "v1-e2e", version: "1" });
    await client.connect(new V1Stdio({ command: process.execPath, args: [MAIN], env: envFor(stub, { GITHUB_TOKEN: "test-token" }) }));
    try {
      assert.equal(client.getServerVersion()?.name, "issuewatcher");
      assert.equal((await client.listTools()).tools.length, 3);
      const r = await client.callTool({ name: "get_ranked_issues", arguments: { limit: 3 } });
      assert.ok(!r.isError, textOf(r as { content: unknown }));
      assert.match(textOf(r as { content: unknown }), /acme\/web#101/);

      const e = await client.callTool({ name: "explain_issue", arguments: { repo: "acme/web", number: 101, mode: "contributor" } });
      assert.match(textOf(e as { content: unknown }), /\+20 {2}good first issue/);

      const w = await client.callTool({ name: "list_watched_repos", arguments: {} });
      assert.match(textOf(w as { content: unknown }), /lib\/leftpad: leftpad \^1\.6\.0 \(runtime, used by stubuser\/myapp\)/);
    } finally {
      await client.close();
    }
  });
});

test("hostile issue text from GitHub is neutralised in the real server's output", T, async () => {
  await withStub(async (stub) => {
    const client = new Client({ name: "security-e2e", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [MAIN], env: envFor(stub, { GITHUB_TOKEN: "test-token" }) }));
    try {
      const r = await client.callTool({ name: "get_ranked_issues", arguments: { repos: ["acme/tool"] } });
      const everything = JSON.stringify(r);
      assert.ok(everything.includes("acme/tool"), "the issue is returned");
      assert.ok(!everything.includes("evil.example"), "no attacker URL survives anywhere in the result");
      assert.ok(!everything.includes("exfil"), "issue bodies are not returned by default");
      assert.ok(!everything.includes("ignore all previous"), "the body text is not in the default response");
    } finally {
      await client.close();
    }
  });
});

test("without a token the server still starts and tells the user how to fix it", T, async () => {
  await withStub(async (stub) => {
    const client = new Client({ name: "notoken-e2e", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [MAIN], env: envFor(stub) }));
    try {
      assert.equal((await client.listTools()).tools.length, 3);
      const r = await client.callTool({ name: "get_ranked_issues", arguments: {} });
      assert.equal(r.isError, true);
      assert.match(textOf(r), /GITHUB_TOKEN/);
      assert.match(textOf(r), /--check/);
    } finally {
      await client.close();
    }
  });
});

test("a wrong token gives a clear message and never echoes the token", T, async () => {
  await withStub(async (stub) => {
    const client = new Client({ name: "badtoken-e2e", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [MAIN], env: envFor(stub, { GITHUB_TOKEN: "wrong-token-XYZ" }) }));
    try {
      const r = await client.callTool({ name: "get_ranked_issues", arguments: {} });
      assert.equal(r.isError, true);
      assert.match(textOf(r), /rejected the token/);
      assert.ok(!JSON.stringify(r).includes("wrong-token-XYZ"));
    } finally {
      await client.close();
    }
  });
});

test("the dependency list is cached on disk, so a second run does not rescan the user's repos", T, async () => {
  await withStub(async (stub) => {
    const env = envFor(stub, { GITHUB_TOKEN: "test-token" });
    const run = async () => {
      const client = new Client({ name: "cache-e2e", version: "1" });
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [MAIN], env }));
      try {
        await client.callTool({ name: "list_watched_repos", arguments: {} });
      } finally {
        await client.close();
      }
    };
    await run();
    assert.equal(stub.count("contents/package.json"), 1);
    assert.ok(fs.existsSync(path.join(env.ISSUEWATCHER_CACHE_DIR!, "dependencies.json")), "cache file written");

    await run();
    assert.equal(stub.count("contents/package.json"), 1, "second process must read the cache, not GitHub");
  });
});

function runCli(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MAIN, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("exit", (code) => resolve({ code, out, err }));
  });
}

test("--version and --help print and exit without starting a server", T, async () => {
  await withStub(async (stub) => {
    const v = await runCli(["--version"], envFor(stub));
    assert.equal(v.out.trim(), PKG.version);
    assert.equal(v.code, 0);
    const h = await runCli(["--help"], envFor(stub));
    assert.match(h.out, /issuewatcher-mcp --check/);
    assert.match(h.out, /GITHUB_TOKEN/);
    assert.equal(h.code, 0);
  });
});

test("--check confirms a working setup in plain words and exits 0", T, async () => {
  await withStub(async (stub) => {
    const r = await runCli(["--check"], envFor(stub, { GITHUB_TOKEN: "test-token" }));
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /Token works: signed in as stubuser/);
    assert.match(r.out, /API budget: 4990 of 5000/);
    assert.match(r.out, /Watching 3 repos: 2 starred, 1 from libraries your projects use/);
    assert.match(r.out, /All good/);
    assert.ok(!r.out.includes("test-token"));
  });
});

test("--check reports a missing token and a rejected token, each with a non-zero exit", T, async () => {
  await withStub(async (stub) => {
    const none = await runCli(["--check"], envFor(stub));
    assert.equal(none.code, 1);
    assert.match(none.out, /\[FAIL\] No GitHub token/);
    assert.match(none.out, /personal-access-tokens/);

    const bad = await runCli(["--check"], envFor(stub, { GITHUB_TOKEN: "nope" }));
    assert.equal(bad.code, 1);
    assert.match(bad.out, /rejected the token/);
  });
});

test("--check surfaces invalid settings instead of ignoring them", T, async () => {
  await withStub(async (stub) => {
    const r = await runCli(["--check"], envFor(stub, { GITHUB_TOKEN: "test-token", SCORING_MODE: "chaos" }));
    assert.match(r.out, /SCORING_MODE must be/);
  });
});
