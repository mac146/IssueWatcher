/* eslint-disable @typescript-eslint/no-explicit-any -- this script inspects untyped JSON returned by the server under test */
/**
 * Pre-release check: everything that can be verified on this machine, before anything is published.
 *
 *   npm run verify:release                 all phases (needs GITHUB_TOKEN or a .env file for the live ones)
 *   npm run verify:release -- --skip-docker --skip-mcpb --skip-tests
 *
 * 1. tests     typecheck, lint, the full test suite
 * 2. package   stage and pack exactly what npm would publish, install the tarball in an empty folder
 * 3. live      drive the INSTALLED package over real stdio against the real account (the tests use a fake
 *              network, which hid a slow cold start and a cache miss; see D-040, D-042, D-044, D-045)
 * 4. docker    build the image, run the Docker tests, repeat the live checks through the container
 * 5. mcpb      build the Claude Desktop bundle, unpack it, repeat the live checks the way Claude Desktop launches it
 *
 * Exits 1 if anything fails. A skipped phase is reported as skipped, never as passed.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = path.resolve(import.meta.dirname, "..");
const args = new Set(process.argv.slice(2));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };
const token = process.env.GITHUB_TOKEN ?? dotenv.parse(fs.existsSync(path.join(root, ".env")) ? fs.readFileSync(path.join(root, ".env")) : "")["GITHUB_TOKEN"];

type Level = "pass" | "FAIL" | "warn" | "skip";
const results: Array<{ level: Level; name: string; detail: string }> = [];
function record(level: Level, name: string, detail = "") {
  results.push({ level, name, detail });
  console.log(`  ${level === "pass" ? "[ok]  " : level === "FAIL" ? "[FAIL]" : level === "warn" ? "[warn]" : "[skip]"} ${name}${detail ? ` - ${detail}` : ""}`);
}
const check = (ok: boolean, name: string, detail = "") => record(ok ? "pass" : "FAIL", name, detail);
/** Speed and completeness depend on the network, so on a slow connection they warn instead of failing. */
let slowNetwork = false;
let misses: number[] = [];
const perf = (ok: boolean, name: string, detail = "") => {
  if (ok) return record("pass", name, detail);
  misses.push(results.length);
  record("warn", name, slowNetwork ? `${detail} (network is slow right now)` : detail);
};
const heading = (s: string) => console.log(`\n== ${s}`);
const q = (s: string) => `"${s}"`;

function sh(command: string, cwd = root, env: NodeJS.ProcessEnv = process.env) {
  const r = spawnSync(command, { cwd, shell: true, encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// ---------------------------------------------------------------------------------------------------
// The live scenario: what a person does in the first half hour, with budgets for each step.

type Launch = { command: string; args: string[]; env: Record<string, string> };
type Call = { ms: number; error: boolean; text: string; data: any };

async function scenario(label: string, launch: Launch, opts: { wait: number; warm: boolean }) {
  heading(`Live checks: ${label}`);
  let stderr = "";
  const transport = new StdioClientTransport({ ...launch, stderr: "pipe" });
  transport.stderr?.on("data", (d) => (stderr += String(d)));
  const client = new Client({ name: "verify-release", version: "1" });
  const outputs: string[] = [];

  const call = async (name: string, a: Record<string, unknown>): Promise<Call> => {
    const t = Date.now();
    try {
      const r = await client.callTool({ name, arguments: a });
      const text = ((r.content as Array<{ text?: string }>) ?? []).map((c) => c.text ?? "").join("\n");
      outputs.push(text, JSON.stringify(r.structuredContent ?? {}));
      return { ms: Date.now() - t, error: Boolean(r.isError), text, data: r.structuredContent };
    } catch (e) {
      const text = String(e);
      outputs.push(text);
      return { ms: Date.now() - t, error: true, text, data: undefined };
    }
  };
  const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

  try {
    const connectStart = Date.now();
    await client.connect(transport);
    check(Date.now() - connectStart < 5000, "connects quickly", secs(Date.now() - connectStart));

    const tools = (await client.listTools()).tools;
    check(
      JSON.stringify(tools.map((t) => t.name).sort()) === JSON.stringify(["explain_issue", "get_ranked_issues", "list_watched_repos"]),
      "exposes exactly the three tools",
      tools.map((t) => t.name).join(", "),
    );
    check(tools.every((t) => t.annotations?.readOnlyHint === true), "every tool is declared read-only");

    if (opts.wait > 0) {
      console.log(`  ... waiting ${opts.wait}s like a person typing their first question`);
      await new Promise((r) => setTimeout(r, opts.wait * 1000));
    }

    const watched = await call("list_watched_repos", {});
    check(!watched.error && watched.data?.total_repos > 0, "lists watched repos", watched.error ? watched.text.slice(0, 120) : `${watched.data.total_repos} repos, ${secs(watched.ms)}`);

    const week = await call("get_ranked_issues", { since: "7d", limit: 10 });
    const issues: any[] = week.data?.issues ?? [];
    if (opts.warm) perf(week.ms <= 4000, "first question after the warm-up is fast", secs(week.ms));
    else check(week.ms <= 30000, "cold first question answers inside 30 s", secs(week.ms));
    check(!week.error, "7-day question succeeds", week.error ? week.text.slice(0, 160) : `${week.data.returned} of ${week.data.total_matching} issues, ${week.data.repos_checked} repos`);
    if (opts.warm) perf(week.data?.partial === false, "7-day answer is complete", week.data?.notice ?? "");
    else if (week.data?.partial) record("warn", "cold 7-day answer was partial (honest notice shown)", (week.data.notice ?? "").slice(0, 100));
    else record("pass", "cold 7-day answer is complete", secs(week.ms));
    if (week.data?.partial) check(typeof week.data?.notice === "string" && week.data.notice.length > 0, "a partial answer always says so");
    perf(issues.length > 0, "returns issues");
    check(issues.every((i) => /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/.test(i.url)), "every link is a plain github.com issue URL");
    check(issues.every((i) => Number.isInteger(i.score) && i.score >= 0 && i.score <= 100), "scores are whole numbers from 0 to 100");
    check(issues.every((_, n) => n === 0 || issues[n - 1].score >= issues[n].score), "sorted by score, highest first");
    check(issues.every((i) => Array.isArray(i.reasons) && i.reasons.length > 0), "every issue comes with a reason");
    check(!JSON.stringify(week.data ?? {}).includes('"body"'), "no issue body in the answer");

    const day = await call("get_ranked_issues", { since: "24h", mode: "contributor", limit: 5 });
    check(!day.error, "24h contributor question succeeds", day.error ? day.text.slice(0, 160) : "");
    perf(day.ms <= 4000, "a different window and mode answers from the cache", secs(day.ms));
    perf(day.data?.partial === false, "24h answer is complete", day.data?.notice ?? "");

    const deps = await call("get_ranked_issues", { since: "30d", mode: "consumer", source: "dependencies", min_score: 60, limit: 10 });
    check(!deps.error, "30-day dependency question succeeds", deps.error ? deps.text.slice(0, 160) : secs(deps.ms));
    perf(deps.data?.partial === false, "30-day dependency answer is complete (no skipped repos)", deps.data?.notice ?? "");
    check((deps.data?.issues ?? []).every((i: any) => i.score >= 60), "min_score is respected");

    const huge = await call("get_ranked_issues", { since: "365d" });
    check(huge.error || (huge.data?.since_hours ?? 0) <= 720, "a 365-day window is refused or clamped, not obeyed", huge.text.slice(0, 80));

    const bad = await call("get_ranked_issues", { since: "last tuesday" });
    check(bad.error, "a malformed window gives a helpful error", bad.text.slice(0, 100));

    if (issues[0]) {
      const only = await call("get_ranked_issues", { since: "7d", repos: [issues[0].repo] });
      check(!only.error && (only.data?.issues ?? []).every((i: any) => i.repo === issues[0].repo), "repo filter returns only that repo", issues[0].repo);

      const ex = await call("explain_issue", { repo: issues[0].repo, number: issues[0].number });
      const parts: Array<{ points: number }> = ex.data?.breakdown ?? [];
      const sum = parts.reduce((a, p) => a + p.points, 0);
      check(!ex.error, "explain_issue succeeds", ex.error ? ex.text.slice(0, 160) : "");
      check(!ex.error && (ex.data?.score === sum || (ex.data?.score === 100 && sum >= 100) || (ex.data?.score === 0 && sum <= 0)), "explanation adds up to the score", `${ex.data?.score} = ${sum}`);
      check(ex.data?.untrusted_excerpt === undefined, "no issue text unless asked");
      const withText = await call("explain_issue", { repo: issues[0].repo, number: issues[0].number, include_excerpt: true });
      check(!withText.error, "explain_issue with an excerpt succeeds", withText.error ? withText.text.slice(0, 160) : "");
      check(!withText.error && (withText.data?.untrusted_excerpt === undefined || /third.party|do not follow/i.test(withText.data.untrusted_excerpt.note)), "excerpt, when asked for, is labelled untrusted");
    }

    const missing = await call("explain_issue", { repo: "octocat/Hello-World", number: 999999999 });
    check(missing.error, "a missing issue gives an error, not a crash", missing.text.slice(0, 100));
  } catch (e) {
    record("FAIL", "scenario ran to the end", String(e).slice(0, 200));
  } finally {
    await client.close().catch(() => undefined);
  }

  const leaked = token ? [...outputs, stderr].some((s) => s.includes(token) || s.includes(token.slice(0, 20))) : false;
  check(!leaked, "the token appears in no output and no log");
  check(!/\bat .*\(.*:\d+:\d+\)/.test(stderr), "no stack trace in the server log");
}

/**
 * Speed varies with the network from minute to minute, so a missed speed check gets one more try with a
 * fresh server. It fails the release only if the second attempt misses too (and the network is not slow).
 */
async function scenarioStable(label: string, launch: () => Launch, opts: { wait: number; warm: boolean }) {
  misses = [];
  await scenario(label, launch(), opts);
  if (misses.length === 0) return;
  console.log("  Speed checks missed; trying once more because network speed varies.");
  misses = [];
  await scenario(`${label} (second attempt)`, launch(), opts);
  if (!slowNetwork) {
    for (const i of misses) {
      results[i]!.level = "FAIL";
      console.log(`  [FAIL] still missed on the second attempt: ${results[i]!.name}`);
    }
  }
}

function liveLaunch(command: string, cmdArgs: string[], extra: Record<string, string> = {}): Launch {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    SystemRoot: process.env.SystemRoot ?? "",
    HOME: process.env.HOME ?? "",
    USERPROFILE: process.env.USERPROFILE ?? "",
    APPDATA: process.env.APPDATA ?? "",
    GITHUB_TOKEN: token ?? "",
    ISSUEWATCHER_CACHE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "iw-verify-")),
    ...extra,
  };
  return { command, args: cmdArgs, env };
}

// ---------------------------------------------------------------------------------------------------

async function main() {
  console.log(`Verifying issuewatcher-mcp ${pkg.version} on ${os.platform()} (node ${process.version})`);
  const live = Boolean(token);
  if (!live) console.log("No GITHUB_TOKEN (environment or .env): the live phases cannot run.");

  heading("1. Tests");
  if (args.has("--skip-tests")) record("skip", "typecheck, lint, tests", "--skip-tests");
  else {
    for (const [name, cmd] of [["typecheck", "npx tsc --noEmit"], ["lint", "npm run lint"], ["tests", "npm test"]] as const) {
      const r = sh(cmd);
      const summary = /# pass (\d+)/.exec(r.out)?.[1];
      check(r.ok, name, r.ok ? (summary ? `${summary} passed` : "") : r.out.split("\n").filter((l) => /not ok|error/i.test(l)).slice(0, 4).join(" | "));
    }
  }

  heading("2. Package (exactly what npm would publish)");
  const staged = sh("npm run package:mcp");
  check(staged.ok, "stage the lean package", staged.out.split("\n").find((l) => l.includes("Staged")) ?? "");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "iw-pack-"));
  const packed = sh(`npm pack --json --pack-destination ${q(work)}`, path.join(root, "dist-mcp"));
  let tarball = "";
  try {
    const info = JSON.parse(packed.out.slice(packed.out.indexOf("["))) as Array<{ filename: string; version: string; files: Array<{ path: string }>; size: number }>;
    tarball = path.join(work, info[0]!.filename);
    check(info[0]!.version === pkg.version, "package version matches", info[0]!.version);
    check(!info[0]!.files.some((f) => /\.env|__tests__|\.test\.|eval\/|DECISIONS/.test(f.path)), "no secrets, tests or notes in the package", `${info[0]!.files.length} files, ${(info[0]!.size / 1024).toFixed(1)} kB`);
  } catch {
    check(false, "pack", packed.out.slice(0, 200));
  }
  const prefix = path.join(work, "install");
  fs.mkdirSync(prefix);
  const installed = tarball ? sh(`npm install ${q(tarball)} --prefix ${q(prefix)} --no-audit --no-fund --loglevel=error`) : { ok: false, out: "" };
  check(installed.ok, "install the tarball in an empty folder", installed.ok ? "" : installed.out.slice(0, 200));
  const main = path.join(prefix, "node_modules", "issuewatcher-mcp", "build", "mcp", "main.js");
  const version = sh(`node ${q(main)} --version`);
  check(version.ok && version.out.trim() === pkg.version, "installed server reports the right version", version.out.trim());
  const noToken = spawnSync(process.execPath, [main, "--check"], { encoding: "utf8", env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
  check(noToken.status !== 0 && /token/i.test(`${noToken.stdout}${noToken.stderr}`), "--check without a token explains what to do");

  if (live) {
    const times: number[] = [];
    for (let i = 0; i < 4; i++) {
      const t = Date.now();
      await fetch("https://api.github.com/zen", { headers: { Authorization: `Bearer ${token}`, "User-Agent": "verify-release" } }).catch(() => undefined);
      times.push(Date.now() - t);
    }
    times.sort((a, b) => a - b);
    const median = (times[1]! + times[2]!) / 2;
    slowNetwork = median > 1200;
    console.log(`
Network: api.github.com answers in a median ${median.toFixed(0)} ms (${times.join(", ")}); ${slowNetwork ? "SLOW: speed checks will only warn" : "fine"}.`);
  }

  let seed = "";
  const seededCache = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iw-verify-seeded-"));
    if (seed && fs.existsSync(seed)) fs.copyFileSync(seed, path.join(dir, "dependencies.json"));
    return dir;
  };

  heading("3. Live (the installed package, the real account)");
  if (!live) record("FAIL", "live checks", "no token: set GITHUB_TOKEN or fill .env, then run again");
  else if (!fs.existsSync(main)) record("FAIL", "live checks", "the installed package is missing");
  else {
    const chk = sh(`node ${q(main)} --check`, root, { ...process.env, GITHUB_TOKEN: token });
    check(chk.ok && chk.out.includes("All good"), "--check passes with the real token", chk.out.split("\n").find((l) => l.includes("Watching")) ?? chk.out.slice(0, 160));
    // A new user's first question (nothing cached, no warm-up), then the same user's next session (dependency list cached).
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "iw-verify-home-"));
    await scenario("first ever question: empty cache, no warm-up", liveLaunch(process.execPath, [main], { ISSUEWATCHER_PREFETCH: "false", ISSUEWATCHER_CACHE_DIR: home }), { wait: 0, warm: false });
    await scenarioStable("returning user: dependency list cached, warm-up on", () => liveLaunch(process.execPath, [main], { ISSUEWATCHER_CACHE_DIR: home }), { wait: 25, warm: true });
    seed = path.join(home, "dependencies.json");
  }

  heading("4. Docker");
  const dockerUp = sh("docker info").ok;
  if (args.has("--skip-docker")) record("skip", "docker", "--skip-docker");
  else if (!dockerUp) record("FAIL", "docker", "Docker is not running (start it, or pass --skip-docker)");
  else {
    const image = "issuewatcher-mcp:verify";
    const built = sh(`docker build --target mcp -t ${image} .`);
    check(built.ok, "build the mcp image", built.ok ? "" : built.out.slice(-200));
    if (built.ok) {
      const t = sh(`node --test build/__tests__/mcp-docker.test.js`, root, { ...process.env, IW_DOCKER_IMAGE: image });
      check(t.ok && !/# fail [1-9]/.test(t.out), "Docker tests pass", /# pass (\d+)/.exec(t.out)?.[0] ?? "");
      if (live) {
        // Docker Desktop routes traffic through a virtual network that can be much slower than the host's,
        // so the speed checks are judged against the container's own network.
        const probe = spawnSync(
          "docker",
          ["run", "--rm", "--entrypoint", "node", image, "-e", "(async()=>{const t=[];for(let i=0;i<4;i++){const s=Date.now();await fetch('https://api.github.com/zen',{headers:{'User-Agent':'verify'}}).catch(()=>0);t.push(Date.now()-s)}t.sort((a,b)=>a-b);console.log((t[1]+t[2])/2)})()"],
          { encoding: "utf8" },
        );
        const containerMedian = Number(probe.stdout.trim());
        const hostSlow = slowNetwork;
        slowNetwork = slowNetwork || !(containerMedian < 1200);
        console.log(`
Network inside the container: median ${Number.isFinite(containerMedian) ? containerMedian.toFixed(0) + " ms" : "unmeasurable"}; ${slowNetwork ? "SLOW: speed checks will only warn" : "fine"}.`);
        await scenarioStable("Docker image", () => ({ command: "docker", args: ["run", "-i", "--rm", "-e", "GITHUB_TOKEN", image], env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", USERPROFILE: process.env.USERPROFILE ?? "", GITHUB_TOKEN: token!, ISSUEWATCHER_CACHE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "iw-verify-docker-")) } }), { wait: 45, warm: true });
        slowNetwork = hostSlow;
      }
    }
  }

  heading("5. Claude Desktop bundle (.mcpb)");
  if (args.has("--skip-mcpb")) record("skip", "mcpb", "--skip-mcpb");
  else {
    const built = sh("npm run build:mcpb");
    const file = path.join(root, "dist-mcpb", `issuewatcher-${pkg.version}.mcpb`);
    check(built.ok && fs.existsSync(file), "build and validate the bundle", fs.existsSync(file) ? `${(fs.statSync(file).size / 1_048_576).toFixed(1)} MB` : built.out.slice(-200));
    if (fs.existsSync(file)) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iw-mcpb-"));
      const un = sh(`npx mcpb unpack ${q(file)} ${q(dir)}`);
      check(un.ok && fs.existsSync(path.join(dir, "manifest.json")), "unpack the bundle");
      if (un.ok && live) {
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
        check(manifest.version === pkg.version, "bundle manifest version matches", manifest.version);
        const cfg = manifest.server.mcp_config;
        const userConfig: Record<string, string> = { github_token: token!, scoring_mode: manifest.user_config?.scoring_mode?.default ?? "both" };
        const sub = (s: string) => s.replace("${__dirname}", dir).replace(/\$\{user_config\.(\w+)\}/g, (_m, k) => userConfig[k] ?? "");
        const extra: Record<string, string> = {};
        for (const [k, v] of Object.entries((cfg.env ?? {}) as Record<string, string>)) extra[k] = sub(v);
        await scenarioStable("Claude Desktop bundle, launched from its manifest", () => liveLaunch(cfg.command === "node" ? process.execPath : cfg.command, (cfg.args as string[]).map(sub), { ...extra, ISSUEWATCHER_CACHE_DIR: seededCache() }), { wait: 25, warm: true });
      } else if (!live) record("FAIL", "bundle live checks", "no token");
    }
  }

  heading("Summary");
  const count = (l: Level) => results.filter((r) => r.level === l).length;
  console.log(`  ${count("pass")} passed, ${count("FAIL")} failed, ${count("warn")} warnings, ${count("skip")} skipped`);
  for (const r of results.filter((x) => x.level === "FAIL")) console.log(`  FAILED: ${r.name}${r.detail ? ` - ${r.detail}` : ""}`);
  if (count("skip")) console.log("  Skipped phases are NOT verified.");
  console.log(count("FAIL") === 0 ? `\n  READY: ${pkg.version} can be published.` : `\n  NOT READY: fix the failures above, then run again.`);
  process.exit(count("FAIL") === 0 ? 0 : 1);
}

await main();
