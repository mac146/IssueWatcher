# IssueWatcher for your AI assistant

**Ask your AI assistant "What should I work on today?" and get back the GitHub issues that are actually worth your time, with the reason for each.**

IssueWatcher is an [MCP](https://modelcontextprotocol.io) server. It watches the repositories you starred and the open-source libraries your own projects depend on, ranks their newest issues, and explains every score. It works inside Claude, Cursor, VS Code and other apps that support MCP.

- **Pick up something to fix:** good first issues that are unassigned, fresh, and not already being fixed by someone else.
- **See what may break your projects:** problems reported in the libraries you use, matched to the versions you use.
- **Know why:** every issue comes with plain-language reasons, and `explain_issue` shows each signal and its points.
- **Safe:** every tool is read-only. It never comments on, assigns or changes anything on GitHub.
- **Free, and no AI key needed:** your assistant does the reasoning with its own model. IssueWatcher only needs a GitHub token.

> Status: early version (0.x). The ranking is rule-based and hand-tuned; it has been checked by reading real results, not yet against a large labelled data set. Feedback is very welcome: [open an issue](https://github.com/mac146/IssueWatcher/issues).

## Quick start (about two minutes)

### 1. Get a GitHub token

IssueWatcher reads your list of starred repositories, so it needs a token. Read-only is enough.

1. Open <https://github.com/settings/personal-access-tokens/new> (GitHub, then Settings, Developer settings, Personal access tokens, Fine-grained tokens).
2. **Token name:** `IssueWatcher`. **Expiration:** 90 days is a good choice (you can regenerate it).
3. **Repository access:**
   - *Public repositories (read-only)* is enough to watch your stars and public dependencies.
   - To also read the `package.json` / `requirements.txt` of **your private repositories**, choose *All repositories* (or select the ones you want) and under *Repository permissions* set **Contents: Read-only**.
4. Click **Generate token** and copy it (it starts with `github_pat_`). You will not be able to see it again.

A classic token (starts with `ghp_`) with the `public_repo` scope also works. Never paste a token into a chat or commit it to a repository.

### 2. Add IssueWatcher to your AI app

Pick your app:

<details>
<summary><b>Claude Desktop (one click)</b></summary>

1. Download `issuewatcher-<version>.mcpb` from the [latest release](https://github.com/mac146/IssueWatcher/releases).
2. Open it with Claude Desktop (double-click it, or drag it into Claude Desktop's settings under Extensions).
3. When asked, paste your GitHub token. It is stored in your computer's secure keychain.
4. Turn the extension on.

</details>

<details>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add issuewatcher -e GITHUB_TOKEN=github_pat_xxxxxxxx -- npx -y issuewatcher-mcp
```

Then run `/mcp` inside Claude Code to see it connected.

</details>

<details>
<summary><b>Cursor</b></summary>

Add this to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "issuewatcher": {
      "command": "npx",
      "args": ["-y", "issuewatcher-mcp"],
      "env": { "GITHUB_TOKEN": "github_pat_xxxxxxxx" }
    }
  }
}
```

</details>

<details>
<summary><b>VS Code (GitHub Copilot agent mode)</b></summary>

Add this to `.vscode/mcp.json`. VS Code will ask for the token when the server starts, so it is not stored in the file:

```json
{
  "inputs": [
    { "type": "promptString", "id": "github_token", "description": "GitHub token", "password": true }
  ],
  "servers": {
    "issuewatcher": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "issuewatcher-mcp"],
      "env": { "GITHUB_TOKEN": "${input:github_token}" }
    }
  }
}
```

</details>

<details>
<summary><b>Any other MCP app (Windsurf, Zed, Cline, ...)</b></summary>

Use the same command in the app's MCP settings: command `npx`, arguments `-y issuewatcher-mcp`, environment variable `GITHUB_TOKEN`.

</details>

> **Windows:** if an app says it cannot start `npx`, use `"command": "cmd"` and `"args": ["/c", "npx", "-y", "issuewatcher-mcp"]`.

### 3. Check it works (optional but recommended)

```bash
GITHUB_TOKEN=github_pat_xxxxxxxx npx -y issuewatcher-mcp --check
```

(On Windows PowerShell: `$env:GITHUB_TOKEN="github_pat_xxxxxxxx"; npx -y issuewatcher-mcp --check`.)

You should see:

```
  [ok]   GitHub token found.
  [ok]   Token works: signed in as <you>.
  [ok]   API budget: 4994 of 5000 requests left (resets ...).
  [ok]   Watching 51 repos: 16 starred, 35 from libraries your projects use (7.2s).

All good. Add this server to your AI app, then ask: "What should I work on today?"
```

### 4. Ask

Restart your AI app, then try:

- *"What should I work on today?"*
- *"Show me good first issues from the last 24 hours."*
- *"What broke in my dependencies this week?"*
- *"Why did you rank the first one so high?"*
- *"Only show issues in nodejs/node and pydantic/pydantic."*
- *"What repos are you watching for me?"*

IssueWatcher starts loading your repositories as soon as your AI app starts it, so by the time you type your first question the answer is usually instant. If you ask within the first few seconds it may take up to about ten (longer on a slow connection); follow-up questions are instant for the next ten minutes. It looks at the 20 newest issues per repository in the time window.

## What the assistant can do (the tools)

| Tool | What it does |
| --- | --- |
| `get_ranked_issues` | Ranks recent issues. Options: `mode` (`contributor`, `consumer`, `both`), `since` (`24h`, `3d`, `7d`, up to `30d`), `limit` (1-25), `min_score`, `source` (`starred`, `dependencies`, `both`), `repos`. |
| `explain_issue` | Shows every signal behind one issue's score, how it relates to your repos and dependencies, and (only if asked) a short excerpt of the issue text. |
| `list_watched_repos` | Shows which repos are watched and why, including which of your projects use which library. |

There is also a prompt, `issue_radar`, that some apps show as a shortcut.

## How the ranking works

Every issue gets a score from 0 to 100 from transparent rules, each with a reason you can read:

- **Why it is on your radar:** a repo you starred, or a library one of your projects depends on (runtime counts more than dev tools).
- **Could you pick it up?** `good first issue` or `help wanted` labels, unassigned, opened recently, few comments, reproduction steps. Issues already assigned, claimed by a team, or where the reporter says they are opening a PR are scored down.
- **Could it break you?** the issue mentions a version in your range, or words like crash, regression, CVE.
- **Noise is scored down:** bots, questions, duplicates, vague or throwaway titles.

The rules and the reasoning behind them are written down in [DECISIONS.md](../DECISIONS.md). They are tuned by hand and still being validated, so use the reasons to judge each result yourself.

## Settings

Set these as environment variables for the server (all optional except the token):

| Variable | Default | Meaning |
| --- | --- | --- |
| `GITHUB_TOKEN` | none | Required. A GitHub token (`GH_TOKEN` also works). |
| `SCORING_MODE` | `both` | `contributor`, `consumer` or `both`. The assistant can override it per question. |
| `DEPENDENCY_SCAN` | `true` | Set `false` to watch only starred repos. |
| `DEPENDENCY_REPOS` | your recently pushed repos | Comma-separated `owner/name` list of your projects to scan for dependencies. |
| `IGNORE_REPOS` | none | Repos to never show, with `*` wildcards, e.g. `bootcamp-*/*`. |
| `IGNORE_LABELS` | none | Labels to hide, e.g. `question,duplicate`. |
| `ISSUEWATCHER_CACHE_DIR` | `~/.issuewatcher` | Where the dependency list is cached (for 24 hours). |
| `ISSUEWATCHER_PREFETCH` | `true` | Load your repos and recent issues in the background when the server starts, so your first question is fast. Set `false` to load only when asked. |

## Security and privacy

- **Read-only.** No tool can write to GitHub. Your token can be read-only too, and should be.
- **Your token stays on your computer** and is only sent to GitHub. It is never written to logs or included in any tool result.
- **No telemetry.** IssueWatcher sends nothing to its author. It contacts only `api.github.com`, and the npm and PyPI registries to find where your dependencies live.
- **What your AI app sees:** issue titles, labels, scores and links. Issue bodies are **not** included unless you ask for an excerpt.
- **Issue text is written by strangers.** A malicious issue could try to trick an AI into following instructions hidden in it ("prompt injection"). IssueWatcher strips hidden characters, link targets and markup, caps lengths, labels excerpts as untrusted, and tells the model never to obey them. This lowers the risk, it cannot remove it. If you also give your assistant tools that can write to GitHub, use a **separate read-only token** for IssueWatcher and keep write actions behind confirmation. See [D-033](../DECISIONS.md) for the full reasoning.

See also [PRIVACY.md](PRIVACY.md).

## Do I need an LLM API key?

**No.** IssueWatcher itself never calls an AI model. Your assistant (Claude, Cursor's models, Copilot, ...) reads the ranked list with its own model and its own login. Nothing to configure here.

LLM API keys (Gemini, OpenAI, Claude, Groq, ...) are only used by the *separate* [email digest](../README.md) part of this project, which can send you a daily email of summaries.

## Troubleshooting

| Symptom | What to try |
| --- | --- |
| App shows "server disconnected" or no tools | Run the `--check` command from step 3 in a terminal; it prints the exact problem. Make sure Node.js 20 or newer is installed (`node --version`). |
| "needs a GitHub token" | The token is missing or not passed to the server. Re-check the `env` / `-e` setting and restart the app. |
| "GitHub rejected the token (401)" | The token expired or was copied wrongly. Create a new one. |
| "No repositories to watch" | You have not starred any repositories yet. Star a few and try again. |
| No dependencies found | Dependency matching reads `package.json` / `requirements.txt` in your recently pushed repos. For private repos the token needs **Contents: Read-only**. Or list projects with `DEPENDENCY_REPOS`. |
| First answer is slow, or says "still loading" | The first load of ~50 repos takes up to ten seconds, longer on a slow connection. Ask again in a few seconds: the work continues in the background. If a scan runs out of its 20-second limit the answer says so and lists how many repos it did not reach. |
| Results look wrong | Ask "explain the first one" and read the signals; then [tell us](https://github.com/mac146/IssueWatcher/issues). That feedback is how the ranking improves. |

## Run it another way

**From source:**

```bash
git clone https://github.com/mac146/IssueWatcher && cd IssueWatcher/mcp-server
npm ci && npm run build
GITHUB_TOKEN=github_pat_xxxxxxxx node build/mcp/main.js --check
```

Use `node /full/path/to/IssueWatcher/mcp-server/build/mcp/main.js` as the command in your app's config.

**With Docker** (the server speaks MCP over stdio, so keep `-i`):

```bash
docker build --target mcp -t issuewatcher-mcp mcp-server
docker run -i --rm -e GITHUB_TOKEN=github_pat_xxxxxxxx issuewatcher-mcp
```

## Uninstall

Remove it from your AI app's settings, then delete the cache folder (`~/.issuewatcher`) and revoke the token at <https://github.com/settings/personal-access-tokens>.
