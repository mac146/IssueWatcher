import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string };

/** Stages the publishable package into a temp folder, exactly as `npm run package:mcp` does. */
function stage(): string {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "iw-stage-"));
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stage-mcp.ts", out], { cwd: ROOT, stdio: "pipe" });
  return out;
}

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

test("the publishable package has only the server's dependencies, not the email digest's", { timeout: 60_000 }, () => {
  const out = stage();
  const pkg = JSON.parse(fs.readFileSync(path.join(out, "package.json"), "utf8")) as Record<string, unknown> & {
    dependencies: Record<string, string>;
  };

  // If this fails, something in the MCP server started importing a library it should not.
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ["@modelcontextprotocol/server", "axios", "zod"]);
  for (const heavy of ["nodemailer", "ioredis", "@google/generative-ai", "dotenv"]) {
    assert.ok(!(heavy in pkg.dependencies), `${heavy} must not ship with the MCP server`);
  }

  assert.equal(pkg.name, "issuewatcher-mcp");
  assert.equal(pkg.version, rootPkg.version, "package version follows the repo version");
  assert.equal(pkg.mcpName, "io.github.mac146/issuewatcher");
  assert.deepEqual(pkg.bin, { "issuewatcher-mcp": "build/mcp/main.js" });
  assert.equal(pkg.type, "module");
});

test("the package contains the server code and none of the digest, tests or secrets", { timeout: 60_000 }, () => {
  const out = stage();
  const files = walk(out).map((f) => path.relative(out, f).split(path.sep).join("/")).sort();

  for (const needed of ["build/mcp/main.js", "build/mcp/server.js", "build/mcp/radar.js", "build/scoring/score.js", "package.json", "LICENSE", "README.md"]) {
    assert.ok(files.includes(needed), `missing ${needed}`);
  }
  for (const f of files) {
    assert.ok(!/__tests__|\.test\.|\.map$|\.env|eval\//.test(f), `unexpected file in package: ${f}`);
    assert.ok(!/build\/(index|config|watcher|digest)\.js$|build\/mail\/|build\/llm\/(provider|providers|cache|factory|summarizer)\.js$/.test(f), `digest-only code in package: ${f}`);
  }
  assert.ok(files.length < 40, `package grew to ${files.length} files`);
});

test("the staged entry point carries a shebang and no dangling source-map comments", { timeout: 60_000 }, () => {
  const out = stage();
  const main = fs.readFileSync(path.join(out, "build/mcp/main.js"), "utf8");
  assert.ok(main.startsWith("#!/usr/bin/env node"), "bin script needs a shebang");
  assert.ok(!/sourceMappingURL/.test(main));
});

test("the staged README has no relative links, which would break on npm", { timeout: 60_000 }, () => {
  const out = stage();
  const readme = fs.readFileSync(path.join(out, "README.md"), "utf8");
  const relative = [...readme.matchAll(/\]\((?!https?:|#|mailto:)([^)\s]+)\)/g)].map((m) => m[1]);
  assert.deepEqual(relative, []);
});

test("the Claude Desktop manifest lists exactly the tools the server exposes, and asks for the token as a secret", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "packaging/mcpb/manifest.json"), "utf8")) as {
    tools: Array<{ name: string }>;
    user_config: Record<string, { sensitive?: boolean; required?: boolean; default?: string }>;
    server: { mcp_config: { env: Record<string, string> } };
  };
  assert.deepEqual(manifest.tools.map((t) => t.name), ["get_ranked_issues", "explain_issue", "list_watched_repos"]);
  assert.equal(manifest.user_config.github_token?.sensitive, true);
  assert.equal(manifest.user_config.github_token?.required, true);
  assert.equal(manifest.user_config.scoring_mode?.default, "both", "an unset optional setting must not reach the server as a literal placeholder");
  assert.equal(manifest.server.mcp_config.env.GITHUB_TOKEN, "${user_config.github_token}");
});

test("the registry entry matches the package it describes", () => {
  const server = JSON.parse(fs.readFileSync(path.join(ROOT, "packaging/server.json"), "utf8")) as {
    name: string;
    description: string;
    version: string;
    packages: Array<{ identifier: string; version: string; transport: { type: string }; environmentVariables: Array<{ name: string; isSecret?: boolean; isRequired?: boolean }> }>;
  };
  assert.equal(server.name, "io.github.mac146/issuewatcher");
  assert.ok(server.description.length <= 100, "the registry rejects descriptions over 100 characters");
  assert.equal(server.version, rootPkg.version, "server.json version must follow package.json");
  const pkg = server.packages[0]!;
  assert.equal(pkg.identifier, "issuewatcher-mcp");
  assert.equal(pkg.version, rootPkg.version);
  assert.equal(pkg.transport.type, "stdio");
  const token = pkg.environmentVariables.find((v) => v.name === "GITHUB_TOKEN");
  assert.ok(token?.isSecret && token.isRequired, "the token is a required secret");
});
