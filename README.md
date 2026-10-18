# IssueWatcher

Watches the GitHub repositories you have starred, detects newly opened issues, and emails you a digest with an AI-generated summary and a suggested fix for each one.

## How it works
1. Lists your starred repos and their open issues (fully paginated, with retry and rate-limit handling).
2. Compares them against a local state file to find issues you have not been told about.
3. Summarises each new issue with Gemini (summary + possible fix).
4. Sends one HTML/plain-text email, then records the issues as seen.

Behaviour worth knowing:
- **No flood on first run.** A repo seen for the first time (including a newly starred one) is recorded silently; only issues opened afterwards are reported.
- **No lost issues.** State is saved only after the email is delivered. If GitHub, Gemini or SMTP fails, the issues are retried next cycle. If only the summary fails, the issue is still emailed without one.
- **Bounded cost.** At most `MAX_ISSUES_PER_EMAIL` issues are summarised per digest (the rest are still listed), and issue bodies are truncated before being sent to the model.

## Setup
Requires Node.js 22+.

```bash
git clone https://github.com/mac146/IssueWatcher
cd IssueWatcher/mcp-server
npm install
```

Create `mcp-server/.env`:

```env
# Required
GITHUB_TOKEN=ghp_xxx            # PAT; needs read access to your starred repos and their issues
GOOGLE_API_KEY=xxx              # Gemini API key
SMTP_USER=you@gmail.com
SMTP_PASS=app-password          # for Gmail use an App Password
MAIL_TO=you@example.com         # comma-separated for several recipients

# Optional (defaults shown)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true                # defaults to true when port is 465
MAIL_FROM=                      # defaults to SMTP_USER
GEMINI_MODEL=gemini-2.5-flash
WATCH_INTERVAL=1800000          # ms between polls, minimum 60000 (default 30 min)
STATE_FILE=data/state.json      # resolved relative to the working directory
MAX_ISSUES_PER_EMAIL=50
MAX_BODY_CHARS=4000
LLM_CONCURRENCY=3
RUN_ONCE=false                  # true: run a single cycle and exit (handy for cron)
```

Configuration is validated at startup; every missing or invalid variable is reported at once.

## Commands
Run in `mcp-server/`:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run with hot reload |
| `npm run build` | Compile TypeScript to `build/` |
| `npm start` | Run the compiled service |
| `npm test` | Build and run the test suite |
| `npm run typecheck` | Type-check without emitting |
| `npm run lint` | ESLint |
| `npm run format` | Prettier |

The process handles SIGINT/SIGTERM by finishing the current cycle and exiting. Keep `STATE_FILE` on persistent storage if you run it in a container.

## Layout
```
mcp-server/src/
  config.ts          env parsing and validation
  index.ts           wiring and process lifecycle
  watcher.ts         one poll cycle + non-overlapping scheduler
  github/api.ts      paginated GitHub client with retry/rate-limit handling
  poller/poller.ts   pure new-issue detection
  llm/summarizer.ts  Gemini summaries with bounded concurrency
  mail/mailer.ts     SMTP digest (HTML + text)
  utils/state.ts     atomic JSON state persistence
  __tests__/         node:test suites
```

## Notes
- Despite the repo's earlier naming, this is a standalone service and does not run an MCP server.
- Only Gemini is supported as the LLM; the `Summarizer` interface in `llm/summarizer.ts` is the extension point for others.
