import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { startStub } from "./stub-github.js";

/**
 * Runs the real MCP Docker image over stdio (`docker run -i`), the way a user's AI app would.
 * Skipped unless an image is named, so the normal test run needs no Docker:
 *
 *   docker build --target mcp -t issuewatcher-mcp:test mcp-server
 *   IW_DOCKER_IMAGE=issuewatcher-mcp:test npm test
 */
const IMAGE = process.env.IW_DOCKER_IMAGE;
const skip = IMAGE ? false : "set IW_DOCKER_IMAGE to run the Docker tests";
const T = { timeout: 120_000, skip };

const textOf = (r: { content: unknown }) => (r.content as Array<{ text: string }>).map((c) => c.text).join("\n");

function dockerArgs(stubPort: number, extra: string[] = []): string[] {
  return [
    "run", "-i", "--rm",
    "--add-host", "host.docker.internal:host-gateway", // lets the container reach the stub on this machine
    "-e", `ISSUEWATCHER_GITHUB_API_URL=http://host.docker.internal:${stubPort}`,
    "-e", `ISSUEWATCHER_NPM_URL=http://host.docker.internal:${stubPort}/npm`,
    "-e", `ISSUEWATCHER_PYPI_URL=http://host.docker.internal:${stubPort}/pypi`,
    ...extra,
    IMAGE!,
  ];
}

const clientEnv = (): Record<string, string> => ({ PATH: process.env.PATH ?? "", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) });

test("the Docker image answers MCP over stdio: tools, ranking and dependency discovery", T, async () => {
  const stub = await startStub("test-token", "0.0.0.0");
  const client = new Client({ name: "docker-e2e", version: "1" });
  try {
    await client.connect(
      new StdioClientTransport({ command: "docker", args: dockerArgs(stub.port, ["-e", "GITHUB_TOKEN=test-token", "-e", "SCORING_MODE=contributor"]), env: clientEnv() }),
    );
    assert.equal((await client.listTools()).tools.length, 3);

    const r = await client.callTool({ name: "get_ranked_issues", arguments: { since: "3d" } });
    assert.ok(!r.isError, textOf(r));
    assert.match(textOf(r), /acme\/web#10[12]/);
    assert.match(textOf(r), /lib\/leftpad#55/, "dependency repos are found from package.json inside the container");
    assert.ok(!JSON.stringify(r).includes("evil.example"), "hostile text is neutralised inside the container too");
  } finally {
    await client.close();
    await stub.close();
  }
});

test("the Docker image without a token starts and explains how to set one up", T, async () => {
  const stub = await startStub("test-token", "0.0.0.0");
  const client = new Client({ name: "docker-notoken", version: "1" });
  try {
    await client.connect(new StdioClientTransport({ command: "docker", args: dockerArgs(stub.port), env: clientEnv() }));
    const r = await client.callTool({ name: "get_ranked_issues", arguments: {} });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /GITHUB_TOKEN/);
  } finally {
    await client.close();
    await stub.close();
  }
});

test("the Docker image runs as a non-root user and --check works", T, async () => {
  const id = spawnSync("docker", ["run", "--rm", "--entrypoint", "id", IMAGE!, "-u"], { encoding: "utf8" });
  assert.notEqual(id.stdout.trim(), "0", "must not run as root");

  const stub = await startStub("test-token", "0.0.0.0");
  try {
    // Async on purpose: the stub runs in this process, so a blocking call would stop it answering the container.
    const check = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile("docker", [...dockerArgs(stub.port, ["-e", "GITHUB_TOKEN=test-token"]), "--check"], { encoding: "utf8" }, (err, stdout, stderr) => {
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr });
      });
    });
    assert.equal(check.code, 0, check.stdout + check.stderr);
    assert.match(check.stdout, /Token works: signed in as stubuser/);
  } finally {
    await stub.close();
  }
});
