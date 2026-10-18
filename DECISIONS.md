# Decision log

Each entry records what was decided, why, what else was considered, and what would make us revisit it. New decisions are appended; superseded ones are marked, not deleted.

Status values: **Accepted**, **Superseded by D-xxx**, **Proposed** (needs the owner's confirmation).

| ID | Decision | Status |
| --- | --- | --- |
| D-001 | Persist "seen" state only after the digest is delivered | Accepted |
| D-002 | Silently seed repos seen for the first time | Accepted |
| D-003 | Failed per-repo fetches keep the previous state | Accepted |
| D-004 | Summaries degrade to "no summary" instead of failing the digest | Accepted |
| D-005 | Gemini only, behind a `Summarizer` interface | Accepted |
| D-006 | Built-in `node:test` and Node >= 22 | Accepted |
| D-007 | Dependency-injected I/O, pure poll logic | Accepted |
| D-008 | Validated env config, fail fast at startup | Accepted |
| D-009 | MIT license | Proposed |
| D-010 | Container image design | Accepted |
| D-011 | CI, release and dependency-update automation | Accepted |
| D-012 | Rename package; keep the `mcp-server/` folder for now | Accepted |
| D-013 | Remove the "MCP" claim until a real MCP server exists | Accepted |
| D-014 | Use `tsx` for the dev runner | Accepted |

---

## D-001: Persist "seen" state only after the digest is delivered
**Context.** The original code saved state inside the poller, before summarising or emailing. A Gemini or SMTP failure marked issues as seen and they were never reported. Silent loss of the one thing the product exists to deliver is the worst failure mode.

**Decision.** `runCycle` (`watcher.ts`) computes the next state, sends the digest, and only then saves.

**Alternatives.**
- Save first, then send: simple, but loses issues on failure (the old behaviour).
- Per-issue delivery tracking in a database: more precise, but overkill for a single-user JSON file. Revisit in the multi-user phase.

**Consequences.** Delivery is at-least-once. If the process dies between sending and saving, one digest is duplicated. A duplicate is much cheaper than a missed issue. A failed SMTP send means summaries are regenerated next cycle (extra LLM cost).

**Revisit when** we move to multi-user storage, where a per-delivery record is cheap and gives exactly-once-ish semantics.

## D-002: Silently seed repos seen for the first time
**Context.** Treating the first run as "everything is new" sends a huge email and many LLM calls. The same happens whenever the user stars a new repo.

**Decision.** A repo absent from state is recorded without reporting its current open issues. Only issues opened afterwards are reported.

**Alternatives.** A first-run backfill of recent issues, e.g. the last 7 days (nice for demos, but needs a date filter and still floods busy repos). A `--backfill` flag may be added later.

**Consequences.** A user who stars a repo will not hear about its pre-existing issues, which is intended. A repo whose very first fetch fails is simply seeded on a later cycle.

## D-003: Failed per-repo fetches keep the previous state
**Context.** The old client returned `[]` on any error, which wiped that repo's state and re-reported every issue next time.

**Decision.** The GitHub client throws. The poller catches per repo, logs, and carries the repo's previous state forward. One bad repo never blocks or corrupts the others. A failure listing starred repos aborts the cycle, because there is nothing safe to compare.

**Consequences.** Transient failures are invisible except in logs. If a repo is permanently failing (e.g. it was deleted), it keeps its old state until it is unstarred.

## D-004: Summaries degrade instead of failing the digest
**Context.** One flaky LLM call should not block an otherwise useful email.

**Decision.** Each issue is summarised independently with bounded concurrency and 3 attempts with exponential backoff. If it still fails, the issue is listed with title and link and "No AI summary available". Beyond `MAX_ISSUES_PER_EMAIL`, issues are listed without a summary rather than dropped.

**Alternatives.** Fail the whole cycle and retry (keeps quality uniform but turns an LLM outage into a total outage). A single batched prompt (cheaper, but one bad issue spoils all summaries and prompt-injection blast radius grows).

**Security note.** Issue text is untrusted. The prompt marks it as data, wraps it in delimiters, truncates it (`MAX_BODY_CHARS`), and the output is only ever rendered as escaped text/HTML. This reduces prompt-injection risk but does not eliminate it.

## D-005: Gemini only, behind a `Summarizer` interface
**Context.** The original README claimed "any LLM provider"; the code only supported Gemini.

**Decision.** Keep Gemini as the one implementation, make the model configurable (`GEMINI_MODEL`), and keep the `Summarizer` interface as the extension point. Documentation now says Gemini only.

**Alternatives.** Add OpenAI/Anthropic now: more reach, but each provider adds dependencies, config and tests for no current user. Add them when a real user asks.

## D-006: Built-in `node:test` and Node >= 22
**Decision.** Use Node's built-in test runner against the compiled output (`npm test` builds, then runs `build/__tests__/*.test.js`). Require Node 22 (current LTS).

**Why.** No extra test dependency, nothing to configure, and the suite is small. Node 22 supports glob patterns in `--test` natively, which keeps the script cross-platform (Windows shells do not expand globs).

**Trade-off.** Tests run against compiled JS, so stack traces point at `build/`. Source maps are enabled. If the suite grows or we want watch mode and coverage UI, move to Vitest (a straightforward migration since tests use plain `assert`).

## D-007: Dependency-injected I/O, pure poll logic
**Decision.** `pollOnce` is a pure function over an `IssueSource` and a state value. GitHub, Gemini, SMTP and disk sit behind small interfaces (`IssueSource`, `Summarizer`, `Mailer`, `StateStore`) wired up in `index.ts`.

**Why.** It makes the delivery guarantees in D-001 to D-004 testable without network access, and it is the seam we need to swap JSON-file storage for Postgres later.

## D-008: Validated env config, fail fast at startup
**Decision.** `loadConfig` validates all environment variables once, reports every problem together, and the process exits non-zero. Intervals have a floor (1 minute) to prevent accidental API hammering. `MAIL_TO` is required; there is no baked-in default recipient.

**Consequences.** Breaking change for existing `.env` files (`MAIL_TO` is new). Documented in the README and `.env.example`. The dotenv startup banner is disabled (`quiet`) so container logs stay clean.

## D-009: MIT license (Proposed)
**Context.** With no license, nobody can legally use, fork or contribute to the project, which blocks the whole "make it public" goal.

**Decision.** MIT, copyright "Mayank Kumar Singh", year 2025.

**Alternatives.** Apache-2.0 (adds an explicit patent grant, a bit heavier); AGPL-3.0 (protects a future hosted offering from being re-hosted by others, but deters corporate contributors and users).

**Needs confirmation.** The owner should confirm the license and the copyright name/year. If a hosted paid tier is planned, this is the moment to weigh AGPL or an open-core split, because changing the license later is painful once others contribute.

## D-010: Container image design
**Decision.** Multi-stage build on `node:22-alpine`.
- A build stage compiles TypeScript; the runtime stage installs production dependencies only and copies in `build/` minus the compiled tests.
- Runs as the unprivileged `node` user.
- State lives on a `/data` volume (`STATE_FILE=/data/state.json`) so it survives container replacement.
- No HEALTHCHECK: the process exposes no port, and a fake check would hide real failures. Use the restart policy and logs for now.
- Configuration is passed as environment variables, never baked into the image (`.dockerignore` excludes `.env`).

**Trade-off.** Alpine uses musl; every current dependency is pure JavaScript, so this is safe. If a native dependency is ever added, reconsider `-slim`.

**Verified.** The image builds, exits non-zero with a clear message when config is missing, runs as `node`, and `/data` is writable. It has not been run against live GitHub, Gemini or SMTP.

## D-011: CI, release and dependency-update automation
**Decision.**
- `ci.yml`: on push to `main` and on PRs, run `npm ci`, lint, typecheck, test, then a non-pushing Docker build. Least-privilege permissions; superseded runs are cancelled.
- `release.yml`: on a `vX.Y.Z` tag, build and push `ghcr.io/<owner>/<repo>` with semver and `latest` tags. Uses only the built-in `GITHUB_TOKEN`, so no secrets to manage.
- Dependabot: weekly npm, monthly Actions and Docker updates.

**Why.** Contributors and users need a green-checkmark signal and a one-command install; maintainers need stale dependencies surfaced automatically.

**Caveat.** The workflows have not run yet (they need a push to GitHub). Expect to fix small issues on the first run. Third-party actions are pinned to major versions, not commit SHAs; pinning to SHAs is a reasonable hardening step later.

## D-012: Rename package; keep the `mcp-server/` folder for now
**Decision.** The npm package is now `issue-watcher` (marked `private`, since we do not publish to npm), with `license` and `repository` set. The folder keeps its name.

**Why.** The folder name is wrong (see D-013) but renaming it breaks every path in docs, CI and open links for no user benefit. Do it once, deliberately, together with the multi-user restructuring (likely `apps/worker` and `apps/web`).

## D-013: Remove the "MCP" claim until a real MCP server exists
**Context.** The README listed MCP as a technology, but the code never used the MCP SDK.

**Decision.** State plainly that this is a standalone service. An actual MCP server (tools such as `get_new_issues`) is on the roadmap as a thin layer over the same core, not a rename.

## D-014: Use `tsx` for the dev runner (replaces ts-node-dev)
**Context.** `npm run dev` crashed with "Must use import to load ES Module". The project is native ESM (`"type": "module"`, NodeNext) and `ts-node-dev` loads files through CommonJS hooks. The bug predates the rewrite and went unnoticed because nothing exercised the dev script. It was found by running the app for real.

**Decision.** Replace `ts-node` and `ts-node-dev` with `tsx` (`tsx watch src/index.ts`). Production still runs the compiled output with plain `node`.

**Why.** `tsx` supports ESM and the `.js`-suffixed imports used here, needs no config, and provides watch mode. Two dev dependencies become one.

**Trade-off.** `tsx` transpiles without type-checking, same as the old `--transpile-only` flag. Type safety is enforced by `npm run typecheck` and CI.

**Verified.** First real run (`RUN_ONCE=true`) against live GitHub: 15 starred repos seeded, 2,749 open issues tracked, with pagination confirmed (one repo has 1,169 open issues), no email sent, and a second run reports "No new issues". A second live run with one issue removed from state found it as new, summarised it, sent the digest, and saved state (the delivery guarantee in D-001 held).
