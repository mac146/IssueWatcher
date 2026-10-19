# Decision log

Each entry records what was decided, why, what else was considered, and what would make us revisit it. New decisions are appended; superseded ones are marked, not deleted.

Status values: **Accepted**, **Superseded by D-xxx**, **Proposed** (needs the owner's confirmation).

| ID | Decision | Status |
| --- | --- | --- |
| D-001 | Persist "seen" state only after the digest is delivered | Accepted |
| D-002 | Silently seed repos seen for the first time | Accepted |
| D-003 | Failed per-repo fetches keep the previous state | Accepted |
| D-004 | Summaries degrade to "no summary" instead of failing the digest | Accepted (batching amended by D-015) |
| D-005 | Gemini only, behind a `Summarizer` interface | Superseded by D-022 |
| D-006 | Built-in `node:test` and Node >= 22 | Accepted |
| D-007 | Dependency-injected I/O, pure poll logic | Accepted |
| D-008 | Validated env config, fail fast at startup | Accepted |
| D-009 | MIT license | Proposed |
| D-010 | Container image design | Accepted |
| D-011 | CI, release and dependency-update automation | Accepted |
| D-012 | Rename package; keep the `mcp-server/` folder for now | Accepted |
| D-013 | Remove the "MCP" claim until a real MCP server exists | Accepted |
| D-014 | Use `tsx` for the dev runner | Accepted |
| D-015 | Batch issues per LLM request; rate limit; stop on exhausted quota | Accepted |
| D-016 | Per-repo high-water mark state | Accepted |
| D-017 | Watch dependency repos from the user's manifests | Accepted |
| D-018 | Rule-based relevance scoring, LLM for top tier only | Accepted (weights unvalidated) |
| D-019 | DRY_RUN preview mode | Accepted |
| D-020 | Scoring modes: consumer, contributor, both | Accepted (weights unvalidated) |
| D-021 | Junk filter and test-work exception in scoring | Accepted |
| D-022 | Provider-agnostic LLM layer with fallback | Accepted |
| D-023 | Redis summary cache with in-memory fallback | Accepted |
| D-024 | AI optional; excerpts when no summary available | Accepted |
| D-025 | Scheduled GitHub Actions run with state in the Actions cache | Accepted |
| D-020 | Scoring modes: consumer, contributor, both | Accepted (weights unvalidated) |

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

## D-015: Batch issues per LLM request, rate-limit, and stop on exhausted quota
**Context.** D-004 chose one LLM request per issue and rejected batching. A live run with 34 new issues disproved that for the free tier: Gemini's free `gemini-2.5-flash` allows about 5 requests/minute and about 20 requests/day. Only 12 of 34 issues were summarised, 22 were emailed as "No AI summary available", and a rerun hit the daily cap (retry in ~15 hours). Retries cannot fix a daily quota, and the failed issues were already marked as seen, so they never get summaries.

**Decision.**
1. **Batching.** Send up to `LLM_BATCH_SIZE` (default 8) issues per request, using Gemini's JSON response schema. Results are keyed by a per-batch id (1..n), not by issue number, which can collide across repos. The app, not the model, formats the output ("Summary: / Possible fix:"), and validates every field.
2. **Fallback.** If a batch fails or returns unusable JSON, retry its issues one by one. Entries the model skipped or garbled become "no summary" for that issue only.
3. **Rate limiter.** `LLM_RPM` (default 5) spaces requests across all workers.
4. **Retry that listens.** On HTTP 429, wait as long as the provider asks (parsed from "retry in 53s", including hours and minutes), up to 90 seconds.
5. **Circuit breaker.** If the provider asks for a longer wait, throw `QuotaExhaustedError`. The cycle stops calling the LLM, logs one warning, and still sends the digest with whatever was summarised.

**Why.** 34 issues now take 5 requests instead of 34, which fits the free tier and also reduces cost on paid plans. Failing fast on a daily quota avoids dozens of doomed calls.

**Trade-offs.**
- One bad response can affect up to 8 issues; the per-issue fallback limits the damage.
- Prompt-injection blast radius within a batch is larger than per issue. Mitigations: issues are delimited and marked as untrusted data, output is schema-constrained, validated, and rendered as escaped text, and the model cannot trigger any action.
- Summaries from a 8-issue batch may be slightly less detailed than a dedicated call.
- Issues that end up without a summary are not retried in later cycles, because they are already marked as seen. Retrying them is a possible follow-up.

**Verified live.** With `gemini-2.5-flash-lite`: 34 of 34 issues summarised in 5 requests, and the digest email was sent. `gemini-2.5-flash` was over its daily quota at the time, so batched mode has **not** been verified with that model yet. The default model stays `gemini-2.5-flash` for quality; set `GEMINI_MODEL=gemini-2.5-flash-lite` if you hit its quota. Summaries from flash-lite were noticeably shorter (average 367 characters, against about 700 from flash).

**Revisit when** a paid key is used (raise `LLM_RPM` and batch size), or when per-user quotas are needed in the multi-user phase.

## D-016: Track a per-repo high-water mark instead of every open issue number
**Context.** State held every open issue number per repo (2,749 numbers for 15 repos). Watching dependencies (React-sized repos with thousands of open issues) would need full pagination each cycle and exhaust the GitHub rate limit.

**Decision.** State is `repo -> highest issue/PR number seen`. Issue numbers only increase, so "new" means number above the mark. Polls fetch newest-first and stop paging at the first number already known, so a quiet repo costs one request. Seeding asks for a single item (`per_page=1`, state=all) to learn the mark. v1 state files migrate automatically (mark = max of the old list).

**Trade-offs.** An issue reopened or transferred in is not reported as new, and issues that were open but low-numbered are never revisited. That matches "tell me about new issues". PRs share the number space, which is harmless for a high-water mark.

## D-017: Watch dependency source repos, discovered from the user's own manifests
**Decision.** Scan the user's recently pushed, non-fork repos (or `DEPENDENCY_REPOS`) for `package.json` and `requirements.txt`; resolve each package to its GitHub repo through the npm and PyPI registries; watch those repos alongside starred ones. Results are cached for 24 h (`data/dependencies.json`), and a failed refresh falls back to the stale cache. Direct dependencies only, capped (`MAX_DEPENDENCIES`), most widely used first. Unresolvable packages are skipped.

**Why.** This is the differentiator over "email me every new issue": relevance to what you actually run.

**Limits.** npm and PyPI only; lockfiles, monorepo sub-packages, `pyproject.toml`, Go and Rust are not read yet. Version ranges are approximated by their lowest allowed version, not the locked version.

## D-018: Transparent rule-based relevance scoring, LLM only for the top tier
**Decision.** Each issue gets a 0-100 score from rules (runtime dependency +40, dev +25, starred only +20; version mentioned in the report matching your range +15/+25; severity words and labels up to +30; community attention; penalties for bots, question/docs/duplicate labels and empty bodies). Every point carries a human-readable reason, shown in the email as "Why you're seeing this". Only issues at or above `MIN_SUMMARY_SCORE` (default 30), up to `MAX_ISSUES_PER_EMAIL`, get an LLM summary; the rest are listed compactly with no LLM call.

**Why rules first.** They are free, explainable and testable, and they cut LLM calls sharply (see D-015). A model-based ranker can come later, trained on feedback.

**Not yet validated.** Weights are educated guesses. A dry run on the author's own account looked sensible at the top (version-matching bugs in real dependencies ranked first) but also surfaced weaknesses: major-only version matches are weak evidence, and a dev-tool issue can outrank a runtime-dependency issue when it has many reactions. The planned evaluation (label about 100 issues useful/noise, measure precision of the top 10) has not been done. Treat the numbers as provisional.

## D-019: `DRY_RUN` preview mode
**Decision.** `DRY_RUN=true` ranks the newest open issues per repo as if they were new and prints the digest. It makes no LLM calls, sends no email and does not touch state, and needs neither the Gemini key nor SMTP settings.

**Why.** The ranking is the product; being able to inspect it without spending quota or sending email is how weights get tuned.

## D-020: Scoring modes (`consumer`, `contributor`, `both`)
**Context.** D-018 scored issues as if the user only consumes libraries, so a plain starred repo ranked low (about 20 against 40 for a dependency). The owner pointed out the opposite is true for an open-source contributor: they star repos they want to work on, and the question they ask is "what can I pick up and fix?", not "what could break my project?".

**Decision.** `SCORING_MODE` selects the view; default `both`.
- `consumer`: unchanged D-018 rules (dependencies and version matches rank highest, a star is a weak signal).
- `contributor`: a star is a strong signal (+30), dependencies count less (+15 runtime, +8 dev), version matching is off, and these signals apply: `good first issue` +20, `help wanted`/`hacktoberfest` +15, unassigned +10 (assigned -25), opened within 48 h +10, few comments +5 (10 or more comments -5), reproduction details +5 (or a long description +3). Docs work is not penalised; questions and support requests are.
- `both`: consumer rules plus the contributor signals, with the +30 star weight.

All signals use fields already returned by the issues endpoint (labels, assignees, created_at, comments), so there is no extra API cost.

**Not done.** Checking whether someone already opened a PR for the issue needs the timeline API (one request per issue); "unassigned" and "few comments" are used as a rough stand-in. Repo health (do maintainers merge PRs?) is also not measured yet.

**Known weaknesses seen in a dry run (provisional weights).** A "regression" keyword in a request for a regression test suite counted as severity; a non-English "report a bug" template and a one-word title ("idurar") scored around 50 because they were fresh, unassigned and starred. A junk filter (title length, template-only bodies) is a candidate next step.

## D-021: Junk filter and test-work exception in scoring
**Decision.** Titles under 10 characters or with no space (for example "idurar", "test", "Assignment__1__") get -20 ("vague title"); titles that are mostly non-Latin script get -15 ("non-English title"). A severity keyword in the title is ignored when the title is about tests ("Add regression test suite").

**Why.** Found in the contributor-mode dry run (D-020): fresh, unassigned issues in starred repos with throwaway titles scored around 50, and a request for a regression test suite ranked first.

**Trade-off.** The non-English penalty assumes English-language repos; a reader who works comfortably in other languages may want it off. It is a fixed rule today and a candidate for a setting if anyone asks.

**Live verification.** Contributor-mode run on the author's account: 23 new issues, 13 in the top tier, 10 compact. `gemini-2.5-flash` was out of daily quota (the circuit breaker in D-015 skipped summaries and the digest still went out), so the final email used `gemini-2.5-flash-lite`.

## D-022: Provider-agnostic LLM layer with fallback (supersedes D-005)
**Context.** D-005 kept Gemini as the only provider. A free-tier quota outage during testing, plus the goal of being usable by students without paid keys, called for letting users bring whichever LLM they have.

**Decision.** A provider is just `complete(prompt) -> text`. Three wire protocols cover the market: Gemini (SDK), Anthropic (HTTP), and OpenAI-compatible HTTP, which also serves OpenAI, Groq, OpenRouter, and local servers such as Ollama via `CUSTOM_LLM_BASE_URL`. Prompting, rate limiting (per provider, since quotas are per key), retries and JSON parsing are shared above the provider (`LlmSummarizer`). Providers with keys are auto-detected in a fixed order, or ordered explicitly with `LLM_PROVIDERS`. `FallbackSummarizer` skips a provider that reports exhausted quota or a bad key and probes it again after the wait (capped at 1 hour); it reports quota exhaustion only when every provider is unavailable. No new SDKs: Anthropic and OpenAI-compatible calls use axios.

**Parsing.** Models other than Gemini cannot be forced to a JSON schema portably, so the parser tolerates markdown fences, text around the JSON, and an object wrapping the array. A failed batch still falls back to per-issue calls (D-004).

**Trade-offs and limits.** Only Gemini has been run against a live service; the others are tested against faked HTTP responses (request shape, headers, error mapping, fallback). Default model names for OpenAI, Anthropic, Groq and OpenRouter are best guesses that may be retired, so each is overridable. `LLM_RPM` is one value for all providers.

## D-023: Redis summary cache with in-memory fallback
**Decision.** Summaries are cached by a hash of repo, issue number, title and the truncated body (plus a format version), for 30 days by default, so each issue is summarised once and an edited issue is summarised again. Redis (`ioredis`) is used when `REDIS_URL` is set; otherwise, or if Redis cannot connect, an in-memory cache is used. Cache reads and writes never throw: a failing Redis is a miss and logs at most one warning per minute. Only finished AI summaries are cached; failures and excerpts are not, so they retry next cycle.

**Why.** It saves quota now (a retry after a failed email re-summarises nothing) and is the shared-cost mechanism for a multi-user version later: one summary per issue regardless of how many people watch the repo. Cached summaries are also served when every provider is out of quota.

**Verified live** against Redis 7: values stored with a TTL, hits after a reconnect, and a clean fall back to memory when Redis is unreachable. **Not done:** Redis is not used for watcher state (still a JSON file); `docker-compose.yml` runs the app with Redis but has not been run end to end.

## D-024: AI is optional; excerpts when no summary is available
**Decision.** No LLM key is a valid configuration. Missing AI summaries (no provider, or all providers out of quota) are replaced by a short excerpt of the issue body, labelled "Excerpt:", with code blocks, links, markup and template headings stripped. `EXTRACTIVE_FALLBACK=false` turns this off. Excerpts are never cached.

**Why.** The digest's value is the ranking and the reasons; AI summaries are a bonus. A free, dependency-free fallback means the project works for a student with no budget and keeps working when quotas run out.

**Limit.** An excerpt does not interpret the issue and offers no fix suggestion, which is why it is labelled differently from a summary.

## D-025: Scheduled GitHub Actions run, state in the Actions cache
**Context.** The goal is for a student with no budget to run this for free and publicly. Hosting a server costs money and ties every user's usage to one person's keys. GitHub Actions gives each user free scheduled compute in their own fork.

**Decision.** `watch.yml` runs `RUN_ONCE=true node build/index.js` every 3 hours (and on demand, with an optional dry-run input). Secrets and variables map to the existing environment variables; GitHub passes unset ones as empty strings, which the config treats as unset (covered by a test). State and the dependency cache (`mcp-server/data`) are restored and saved with `actions/cache` using a unique key per run and a prefix restore key, so each run starts from the latest state. A secrets check fails fast with a clear message. The job runs only on forks, or when started by hand upstream, because the upstream repository has no secrets. Runs are serialised with a concurrency group.

**Why the cache and not a state branch.** I first planned a dedicated branch, but in a public fork it would publish the dependency cache, which names the owner's repositories, including private ones scanned with the token. The Actions cache is private to the repository. **Trade-off:** caches can be evicted (after 7 days without access, or under storage pressure), unlike a branch. The failure mode is safe: the next run re-seeds silently, so nothing is re-sent, but issues opened during the gap are not reported. With a 3-hour schedule, eviction through inactivity is unlikely.

**Limits.** Scheduled workflows run late, can be skipped under load, and are disabled after 60 days of repository inactivity; the README says so. A personal access token is required because the built-in token cannot read the user's stars; it is stored as a secret and never logged. Verified: `actionlint` passes on all workflows, and the run step was simulated locally with blank optional variables (dry run, real GitHub). **Not verified:** an actual run on GitHub (it needs a fork with secrets), and the cache restore and save behaviour.
