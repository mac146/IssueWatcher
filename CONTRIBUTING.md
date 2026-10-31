# Contributing

Thanks for helping improve IssueWatcher.

## Development
Requires Node.js 22+.

```bash
cd mcp-server
npm install
cp .env.example .env   # fill in values; use RUN_ONCE=true while experimenting
npm run dev
```

Before opening a PR, make sure these pass (CI runs the same checks):

```bash
npm run lint
npm run typecheck
npm test
```

## Working on the MCP server
The server lives in `mcp-server/src/mcp/`. Useful commands, all from `mcp-server/`:

```bash
npm test                                   # 200+ tests; includes end-to-end runs of the compiled server over real stdio
npm run package:mcp                        # stage the lean publishable package into ./dist-mcp
npm run build:mcpb                         # build the Claude Desktop bundle (needs network)
GITHUB_TOKEN=... node build/mcp/main.js --check    # test against your real account

# Docker tests (skipped unless an image is named)
docker build --target mcp -t issuewatcher-mcp:test .
IW_DOCKER_IMAGE=issuewatcher-mcp:test node --test build/__tests__/mcp-docker.test.js
```

Rules that tests enforce: nothing but protocol messages on stdout (log to stderr); no tool may write to GitHub; everything from an issue goes through `mcp/sanitize.ts`; the published package may depend only on what the server imports. Unit tests use a fast fake network, so also run the server against your real account before releasing: two real-world problems (a slow cold start, and a cache that missed on a different time window) were only found that way. **Before every release run `npm run verify:release`** (needs `GITHUB_TOKEN` or `.env`, and Docker running; `--skip-docker`, `--skip-mcpb`, `--skip-tests` skip a phase and are reported as skipped). It tests the exact package that would be published, over real stdio, against a real account, and prints READY or NOT READY. Only publish on READY. Releasing: [docs/PUBLISHING.md](docs/PUBLISHING.md).

## Guidelines
- Add or update tests for behaviour changes. Tests use the built-in `node:test` runner and live in `src/__tests__/`; use the fakes in `helpers.ts` rather than hitting real APIs.
- Keep I/O at the edges. `poller.ts` is intentionally pure; GitHub, Gemini, SMTP and disk access sit behind interfaces so they can be faked.
- Never persist "seen" state before a digest has been delivered (see DECISIONS.md, D-001).
- Record significant design choices in [DECISIONS.md](DECISIONS.md) using the existing format.
- Keep commits focused, with a message that explains *why*.

## Reporting bugs
Open an issue with the version, your Node version, and logs with secrets and issue contents removed.
