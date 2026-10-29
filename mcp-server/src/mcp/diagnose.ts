import { buildRuntime } from "./runtime.js";
import { classifyError } from "./radar.js";
import { SETUP_HELP, type McpSettings } from "./settings.js";

type Write = (line: string) => void;

const ok = (m: string) => `  [ok]   ${m}`;
const bad = (m: string) => `  [FAIL] ${m}`;
const info = (m: string) => `  [info] ${m}`;

/**
 * `issuewatcher-mcp --check`: confirms in plain words that the token works and what will be watched,
 * so a first-time user can fix problems in a terminal instead of guessing why an AI app shows nothing.
 * Returns the process exit code.
 */
export async function runCheck(
  settings: McpSettings,
  problems: string[],
  version: string,
  write: Write = (l) => console.log(l),
): Promise<number> {
  write(`IssueWatcher MCP server v${version}: setup check\n`);
  let failed = false;

  for (const p of problems) write(info(p));

  if (!settings.githubToken) {
    write(bad("No GitHub token found (GITHUB_TOKEN)."));
    write(`\n${SETUP_HELP}`);
    return 1;
  }
  write(ok("GitHub token found."));

  const { github, targets } = buildRuntime({ ...settings, githubToken: settings.githubToken });

  try {
    const login = await github.getLogin();
    write(ok(`Token works: signed in as ${login}.`));
  } catch (err) {
    write(bad(classifyError(err).message));
    return 1;
  }

  try {
    const rate = await github.getRateLimit();
    const resets = rate.resetAt.toLocaleTimeString();
    write(
      rate.remaining > 100
        ? ok(`API budget: ${rate.remaining} of ${rate.limit} requests left (resets ${resets}).`)
        : bad(`API budget is low: ${rate.remaining} of ${rate.limit} left (resets ${resets}).`),
    );
    if (rate.remaining <= 100) failed = true;
  } catch (err) {
    write(info(`Could not read the rate limit: ${classifyError(err).message}`));
  }

  try {
    const started = Date.now();
    const all = await targets();
    const starred = all.filter((t) => t.starred).length;
    const fromDeps = all.filter((t) => t.dependencies.length > 0).length;
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (all.length === 0) {
      write(bad("No repositories to watch. Star a few repositories on GitHub, then run this again."));
      failed = true;
    } else {
      write(ok(`Watching ${all.length} repos: ${starred} starred, ${fromDeps} from libraries your projects use (${seconds}s).`));
    }
    if (!settings.dependencyScan) write(info("Dependency scanning is off (DEPENDENCY_SCAN=false)."));
    else if (fromDeps === 0) {
      write(info("No dependencies found. This needs a package.json or requirements.txt in your recently pushed repos."));
    }
  } catch (err) {
    write(bad(classifyError(err).message));
    return 1;
  }

  write(`\nMode: ${settings.mode}. Cache folder: ${settings.cacheDir}`);
  write(failed ? "\nSetup needs attention (see above)." : "\nAll good. Add this server to your AI app, then ask: \"What should I work on today?\"");
  return failed ? 1 : 0;
}
