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

## Guidelines
- Add or update tests for behaviour changes. Tests use the built-in `node:test` runner and live in `src/__tests__/`; use the fakes in `helpers.ts` rather than hitting real APIs.
- Keep I/O at the edges. `poller.ts` is intentionally pure; GitHub, Gemini, SMTP and disk access sit behind interfaces so they can be faked.
- Never persist "seen" state before a digest has been delivered (see DECISIONS.md, D-001).
- Record significant design choices in [DECISIONS.md](DECISIONS.md) using the existing format.
- Keep commits focused, with a message that explains *why*.

## Reporting bugs
Open an issue with the version, your Node version, and logs with secrets and issue contents removed.
