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
| D-009 | MIT license | Accepted |
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
| D-026 | Blind labelling evaluation for the ranking | Accepted (re-scoring by D-027) |
| D-027 | Scoring fixes from reading a real digest; eval re-scores | Accepted |
| D-028 | Second round of scoring fixes; mode-aware summary threshold | Accepted |
| D-029 | Build an MCP server before an agent | Accepted |
| D-030 | Architecture: shared core, stateless pull tools, second entry point | Accepted |
| D-031 | MCP SDK v2 behind a client-compatibility spike (v1 fallback) | Accepted (spike passed) |
| D-032 | Tool surface: four task-shaped, read-only tools | Accepted |
| D-033 | Security posture against indirect prompt injection | Accepted |
| D-034 | Transport and auth: stdio with the user's own token first | Accepted |
| D-035 | Distribution and install experience | Accepted |
| D-036 | Launch plan, success metrics and kill criteria | Accepted |
| D-037 | The published package is generated from the server's import closure | Accepted |
| D-038 | stdio hygiene and failure behaviour of the MCP server | Accepted |
| D-039 | Radar mechanics, measured behaviour and one bug found | Accepted |
| D-040 | Test strategy and verification status of the MCP server | Accepted |
| D-041 | Severity words inside file paths are ignored | Accepted |
| D-042 | Warm-up, shared loads and window-reuse cache (found by running it for real) | Accepted |
| D-043 | A title about a newer major than you run is scored down; no version match from its body | Accepted |
| D-044 | Recommend a global install because npx can exceed the 30 s startup limit | Accepted |

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

## D-009: MIT license
**Context.** With no license, nobody can legally use, fork or contribute to the project, which blocks the whole "make it public" goal.

**Decision.** MIT, copyright "Mayank Kumar Singh", year 2025.

**Alternatives.** Apache-2.0 (adds an explicit patent grant, a bit heavier); AGPL-3.0 (protects a future hosted offering from being re-hosted by others, but deters corporate contributors and users).

**Confirmed by the owner on 2026-10-22: MIT, copyright "Mayank Kumar Singh".** Originally flagged for confirmation: The owner should confirm the license and the copyright name/year. If a hosted paid tier is planned, this is the moment to weigh AGPL or an open-core split, because changing the license later is painful once others contribute.

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

**Limits.** Scheduled workflows run late, can be skipped under load, and are disabled after 60 days of repository inactivity; the README says so. A personal access token is required because the built-in token cannot read the user's stars; it is stored as a secret and never logged. Verified: `actionlint` passes on all workflows, and the run step was simulated locally with blank optional variables (dry run, real GitHub). **Verified on GitHub** in a throwaway private repository (a repo cannot be forked onto its own owner's account), with real GH_PAT and fake SMTP values so no email could be sent: a dry run passed and skipped the cache save as designed; a first real run seeded all 50 watched repos and saved the cache entry `issuewatcher-state-<run id>`; a second real run restored that entry through the restore-key prefix, logged no seeding and no dependency re-scan (both files came from the cache) and saved a fresh entry. **Not verified:** a run triggered by the schedule itself, behaviour after a cache eviction, and sending an email from Actions with real SMTP secrets.

## D-026: Blind labelling evaluation for the ranking
**Context.** D-018 and D-020 say the scoring weights are unvalidated guesses. Tuning them by eye on dry runs risks fitting my own impressions.

**Decision.** `npm run eval:export` collects the newest open issues from every watched repo, draws a seeded random sample (default 100, de-duplicated), and writes `eval/labels.csv` with no scores and in shuffled order, plus the scores in a separate `eval/scores.json`. The user marks each issue `u` (useful) or `n` (noise) and leaves unsure ones blank. `npm run eval:report` then reports precision of the top 5, 10 and 20 against two baselines (newest-first, which is what GitHub shows, and random), the AUC (chance that a useful issue outranks a noise one), and, for each signal that appears in at least 5 labelled issues, the useful rate with and without it.

**Why blind and random.** Seeing the score biases the label, and labelling only the top of the ranking cannot reveal what the ranking buries.

**Limits.** One person's taste is not everyone's; the sample is only the newest few issues per repo, not the whole stream; with fewer than about 60 labels the signal-level numbers are noise (the report says so, and refuses to print numbers under 20). The report is diagnostic: it does not tune the weights automatically. Whoever changes the weights should re-label a fresh sample (a different seed) so the tuned weights are not graded on the issues they were tuned on.

**Status.** The tooling is tested (107 tests) and a first sample has been generated, but no labels exist yet, so the ranking is still unvalidated.

## D-027: Scoring fixes from reading a real digest; the evaluation re-scores
**Context.** The first real contributor-mode digest (76 issues) showed five wrong signals: (1) body keywords firing on incidental text: "add a regression test" counted as a regression, PostgreSQL's PANIC log level as a panic, "built-in security headers" as security; (2) generic titles such as "Report a bug" ranking 55-60; (3) issues a contributor cannot take still ranking high: `status:team-assigned` labels, reporters saying they will send a PR or that a fix is already in a PR; (4) "has reproduction details" firing on empty template headings; (5) dev-dependency issues about newer versions than the user runs (left as is: they are real, open bugs).

**Decision.**
- Body severity ignores "regression test/suite/coverage" and no longer uses "panic" or "security" (the title and labels still may).
- Generic titles ("Report a bug", "Bug report", "Not working", "Help", ...) count as a vague title (-20).
- Contributor mode: a claimed-work label (team-assigned, in progress, has PR, claimed, WIP) is -20 "team already on it"; text such as "I can submit a PR", "a PR is already prepared", "assign this to me", or a fix tracked in #123 / a PR is -15 "a fix is already planned or open".
- "Has reproduction details" needs at least 100 characters of real text besides headings.
- `eval:report` re-scores the stored sample with the current code instead of reading frozen scores, so weight changes can be judged on the same labels. `eval:export` refuses to overwrite labelled sheets; `eval:rebuild` upgrades an older sheet by re-fetching its issues.

**Effect, on the actual issues:** the real regression stayed first (80 to 80); the incidental-keyword issues dropped 8 points; "Report a bug" issues, team-assigned and already-claimed issues dropped 15-23 points.

**Limits.** These are heuristics read off one digest and are still not validated by labels. "I can fix ..." phrasing can also describe a workaround, which would be penalised wrongly. Claimed-work labels are repository conventions, so only common spellings are matched. The re-scoring report is more convenient but makes over-fitting easy; confirm on a fresh sample.

## D-028: Second round of scoring fixes; mode-aware summary threshold
**Context.** The final end-to-end digest (22 issues) still showed four problems: (1) a TypeScript panic report was marked "a fix is already planned" because its body said "extend existing fixes for similar panic issues (like #64668)", which refers to a different issue; (2) composio#5032, where the reporter wrote "I'm opening a small PR", was not flagged because the pattern did not allow an adjective between "a" and "PR"; (3) a DefinitelyTyped issue about `@types/sinon` was credited as "dev dependency @types/express", because that monorepo maps every `@types/*` package to one repository; (4) all 22 issues were "worth a look" and the compact list was empty, because in contributor mode nothing scores below about 33, so `MIN_SUMMARY_SCORE=30` filtered nothing.

**Decision.**
- "A fix is already open" now requires wording that ties a PR or issue number to this issue ("fixed in #123", "proposed fix is in PR #123", "tracked in #123"); loose "fix ... #123" proximity no longer counts. Reporter phrases cover "I'm/we are opening/preparing/submitting/working on (a small) PR/fix".
- DefinitelyTyped issues whose title names a `@types/x` package are matched against the user's dependencies: the matching dependency is credited, and a package the user does not use gets -25 ("types for x, which you do not use") with no credit from unrelated dependencies. Titles that name no package are unaffected.
- `MIN_SUMMARY_SCORE` defaults to 45 in contributor mode and 30 otherwise; an explicit value always wins.

**Effect on the real issues:** TypeScript#64895 33 to 48 (no longer wrongly penalised); composio#5032 60 to 45; DefinitelyTyped#75803 46 to 13; the controls (composio#5022 at 70, pymupdf#5200 at 65) did not move.

**Limits.** The DefinitelyTyped rule is specific to that one repository. Phrase lists will keep missing wording (see the "small PR" miss), so they need the labelled evaluation to be tuned systematically rather than one digest at a time.

## D-029: Build an MCP server before an agent
**Context.** The X launch got almost no traction. Likely causes, in order of confidence: (1) no existing audience, so any post starts from zero; (2) high adoption friction: fork the repo, create a personal access token, add four secrets, set up SMTP, wait for a 3-hour schedule; (3) the problem-solution fit was never validated with real users (Phase 0 was skipped); (4) there was no 30-second demo. An MCP server fixes (2) and part of (4) and opens discovery channels, but it does not fix (1) or (3) on its own, so it is a bet, not a cure.

**Research (primary sources read on 2026-10-29).** The official GitHub MCP server (github/github-mcp-server) has issue, notification and stargazer toolsets but no scoring or prioritisation, and it does not analyse the user's package dependencies; `list_issues` and `search_issues` only sort. The gap between "list issues" and "which issues matter to me, and why" is exactly what this project does, so an IssueWatcher server complements the GitHub server instead of competing with it. Tool support is near-universal across clients (Claude Desktop and Code, Cursor, VS Code, Windsurf and others per secondary sources); resources, prompts and sampling are uneven, so tools are the safe surface.

**Decision.** Ship an MCP server that exposes the existing ranking to AI assistants. Do not build an agent now.

**Why not an agent.** The pipeline needs no model decisions today; an agent adds per-run cost, latency and failure modes to something that works as plain code, and it needs a use case people want (for example "pick an issue and draft a fix plan") that nobody has asked for yet. The user's own assistant can already act as the agent: it calls our tools, reasons over the results, and pays for its own tokens.

**Alternatives considered.** A hosted web app (cost, accounts, privacy burden); more delivery channels such as Slack or Discord (more of the same push model that did not get traction); an agent (above).

**Trade-offs.** MCP directories are crowded (secondary sources quote 17,000 to 50,000 servers, numbers disagree), so listing is table stakes, not growth. The audience (people who use an MCP-capable assistant and care about open-source issues) is narrower than "developers".

**Revisit when** four weeks after launch the success criteria in D-036 are not met, or users ask for "do something about this issue" rather than "tell me which issue".

## D-030: Architecture: shared core, stateless pull tools, second entry point
**Decision.** Keep one repository and one codebase. Extract a `radar` function (inputs: mode, time window, limit, repo filters; output: ranked issues with a per-signal score breakdown) out of the current digest flow. The digest app and the MCP server both call it. The MCP server has its own entry point and its own bin (`issuewatcher-mcp`); the digest CLI, Docker image and Actions workflow stay as they are.

**Why pull instead of the digest's "new since last run".** An assistant asks "what is new in the last 3 days?", not "what changed since my last poll", and the 2026-07-28 spec removes protocol-level sessions, so a server that depends on a per-connection high-water mark would fit badly. Tools take a time window, store no per-user state, and are safe to call repeatedly.

**Performance.** The digest polls 50 repos one after another (about 30 seconds), which is too slow for an interactive tool. The radar fetches repos with bounded concurrency (about 8), caches results briefly (about 10 minutes, in memory and on disk, keyed by repo and window), and enforces a time budget (about 20 seconds); if the budget runs out it returns what it has with `partial: true` and says which repos were skipped. GitHub's authenticated limit (5,000 requests/hour) is ample for one request per repo per call.

**Scoring change needed.** `scoreIssue` returns reason strings only. It must also return a structured breakdown (signal, points, reason) so `explain_issue` can show exactly where a score came from. This is additive, and the existing tests and digest keep working.

**Packaging.** Publish the unscoped npm package `issuewatcher-mcp` (checked: the name is free) so the install line is `npx -y issuewatcher-mcp`. Splitting into a monorepo of packages is deferred until a second consumer exists.

## D-031: MCP SDK v2 behind a client-compatibility spike (v1 fallback)
**Facts (verified).** The current spec revision is 2026-07-28. It makes the protocol stateless: no `initialize` handshake, no `Mcp-Session-Id`, every request carries its version and capabilities, servers must implement `server/discover`, tasks became an extension, and Roots, Sampling and Logging are deprecated. The TypeScript SDK v2 (`@modelcontextprotocol/server` 2.4.0, updated 2026-10-23, Node 20 or newer, zod 4) implements it; the v1 package `@modelcontextprotocol/sdk` (1.32.2) is still maintained and is promised bug and security fixes for at least six months after the v2 release on 2026-07-27. MCP Inspector is at 2.13.0.

**Decision.** Target v2, but do not commit until a half-day spike proves it works. The spike builds a trivial one-tool stdio server on v2 and connects it from MCP Inspector and from the real clients (Claude Code, Claude Desktop, Cursor, VS Code). If any major client cannot connect, build on v1 and migrate later; the tool layer is written to be SDK-agnostic so the switch is cheap.

**Why gate it.** The unknown that can sink the launch is not our code but whether the clients users already have speak the new protocol. A server that works in the Inspector and fails in Claude Desktop is worse than no server. Not verified: which client versions support 2026-07-28, and whether a v2 server negotiates down for clients on older revisions.

**Also not verified:** the exact v2 API for tool annotations and Streamable HTTP (the docs pages were not readable in research); this is checked against the installed package types during the spike.

## D-032: Tool surface: four task-shaped, read-only tools
**Principle.** Few tools, named for what the user wants to do, not mirrors of API endpoints (the consistent advice in MCP design guides: a model picks poorly from long lists and does not know call sequences). All tools are read-only and carry `readOnlyHint: true`, `idempotentHint: true` and `openWorldHint: true` (they reach GitHub). Results are deterministically ordered, with structured output plus a short text rendering, and every list has a limit (default 10, maximum 25).

1. `get_ranked_issues`: new issues ranked for the user. Inputs: `mode` (`contributor`, `consumer`, `both`), `since` (for example `24h`, `3d`, `7d`), `limit`, `min_score`, optional `repos` filter, `source` (`starred`, `dependencies`, `both`). Output per issue: repo, number, title, url, score, reasons, labels, age, why-watched (starred or which dependency and range).
2. `explain_issue`: the per-signal score breakdown for one issue, and optionally a short excerpt (opt-in, see D-033).
3. `list_watched_repos`: which repos are watched and why (starred, or which of your projects depends on which package).
4. `find_issues_for_skill` is deliberately **not** included; skill matching is a separate, unvalidated idea.

One MCP **prompt**, "issue radar for today", is added as a convenience for clients that support prompts; nothing depends on it.

**Not exposed in v1:** any write tool (comment, assign, close), email sending, and state changes such as ignore lists. Writes would break the read-only security story in D-033 and are not what users asked for.

**Why `since` and not "new since last call".** See D-030.

## D-033: Security posture against indirect prompt injection
**Threat (documented).** Invariant Labs showed in 2025 a "toxic agent flow" against the GitHub MCP server: an attacker files a malicious issue in a public repo; when the owner asks their agent to review issues, the issue text steers the agent into using its other tools (reading private repos, opening pull requests) and leaking data. The tools were not compromised; trusted tools plus untrusted content were the problem. Our server returns issue text from arbitrary public repos to a model that often has other, more powerful tools, so we are in the same exposure class.

**Decisions.**
- **Default responses carry no issue bodies.** Titles, labels, scores and reasons only; this also keeps responses small. Titles are attacker-controlled too, so they are length-capped and stripped of control characters and markdown link syntax.
- **Excerpts are opt-in** (`include_excerpt` on `explain_issue`), length-capped, and returned inside a field named `untrusted_excerpt` with an explicit marker, never merged into the instructions or reasons.
- The server's `instructions` string tells the model that issue text is third-party data to be reported, never obeyed.
- **Read-only tools only**, so this server cannot be the part that performs the harmful action.
- **Token handling:** the user's GitHub token is read from the environment, never logged and never returned in any tool output or error message. Documentation recommends a fine-grained, read-only token.
- **README warning** for users who also run write-capable GitHub MCP tools: use a separate token without private-repo access for the assistant session, or require confirmation on write tools.
- Adversarial tests: issue titles and excerpts containing instructions, markdown links, very long text and control characters must come out inert, capped and labelled.

**Limits.** None of this makes injection impossible; the model still reads the titles. It reduces the surface, keeps this server from being the weak link, and is honest about the residual risk.

## D-034: Transport and auth: stdio with the user's own token first
**Decision.** Version 1 supports stdio only. The user supplies their own GitHub token through an environment variable; the server never sees a password and stores nothing remotely. Remote Streamable HTTP with OAuth is deferred.

**Why.** Stdio covers Claude Desktop, Claude Code, Cursor, VS Code, Windsurf and similar local clients, which is the target audience. A hosted remote server would require running infrastructure, a GitHub OAuth app, token storage and a privacy policy, and it would make this project the custodian of users' GitHub tokens. The benefit (reaching claude.ai web and ChatGPT-style remote-only clients, per secondary sources) is real but is not worth that cost before anyone uses the local version. The code is transport-independent, so adding HTTP later is a small change; the stateless protocol makes a later remote deployment simple.

**Token guidance.** Stars and public issues need no special scope; reading manifests of private repos (dependency discovery) needs read access to their contents. Without a token the tools return a clear setup message instead of failing; unauthenticated GitHub limits (60 requests/hour) are too low to be useful.

## D-035: Distribution and install experience
**Goal.** From "interesting" to "working in my assistant" in under two minutes, with no config-file editing for the common case.

| Client | Install path | Notes |
|---|---|---|
| Claude Desktop | One-click `.mcpb` bundle (built with `@anthropic-ai/mcpb` 2.1.2) | The bundle declares the token as a sensitive `user_config` field, stored in the OS keychain; the best experience for non-technical users. Directory listing is a separate, reviewed step. |
| Claude Code | `claude mcp add issuewatcher --env GITHUB_TOKEN=... -- npx -y issuewatcher-mcp` | From product knowledge; verify the exact flags before publishing the README. |
| Cursor, VS Code | Install deeplinks plus a copy-paste JSON snippet | One forum report says Cursor deeplinks broke in a recent version, so the JSON snippet is always shown too. |
| Any other client | Generic JSON config using `npx -y issuewatcher-mcp` | |

**Listings.** Publish to npm first, then the official MCP Registry (preview; `mcp-publisher`, name `io.github.mac146/issuewatcher`, `mcpName` in package.json must match `server.json`, description at most 100 characters, GitHub login or GitHub Actions OIDC for namespace ownership; not done by pull request), then Glama, PulseMCP, mcp.so and the awesome-mcp-servers list. Smithery is optional because it is a hosting platform first. These are discovery aids, not a growth plan (see D-029 and D-036).

**Required assets:** a 30 to 45 second screen recording at the top of the README, a 512 by 512 icon, a privacy statement ("runs locally; your token goes only to GitHub; no telemetry"), and an example-prompts section.

**Not verified:** current Claude Connectors Directory submission requirements (secondary sources only; remote servers are the recommended path), and the ChatGPT MCP availability (sources conflict).

## D-036: Launch plan, success metrics and kill criteria
**Principles.** Fix the product before the post; show the result, not the architecture; be honest about what is unvalidated; ask for feedback, not stars.

**Sequence.**
1. **Week 0 (before building much):** label the 100-issue sample (about 30 minutes) and run `npm run eval:report`. This produces the one sentence that can carry the launch ("the top 10 were X% useful vs Y% for newest-first"). If the ranking does not beat newest-first, fix it before shipping a server that exposes it.
2. **Week 1:** the compatibility spike (D-031), the radar refactor (D-030), the four tools (D-032) and the security tests (D-033).
3. **Week 2:** packaging (npm, mcpb, registry, install snippets), demo recording, README.
4. **Week 3:** soft launch to the communities where the target user already is: assistant-specific communities (Claude, Cursor), open-source and contributor communities, and the existing Reddit posts. One post per community, spaced out, with the demo first. A technical write-up ("an MCP server on the stateless 2026-07-28 spec: lessons") is the secondary asset and the one that can travel to Hacker News once there are real numbers.
5. **Week 4:** read the feedback, fix what people hit, decide.

**Success (4 weeks after launch).** At least 25 installs (npm downloads of `issuewatcher-mcp` excluding bots are a rough proxy), at least 5 people who used it on more than one day and can say what they used it for, at least 10 substantive pieces of feedback, and no unfixed install failure on a major client.

**Kill or pivot.** If after four weeks fewer than about 10 installs and no repeat users, stop adding features to the MCP surface. The likely reasons would then be audience or problem fit, not engineering, and the next step is user conversations, not code. Telemetry stays off by default (trust); signals are npm downloads, GitHub stars and issues, registry views and direct feedback.

**Honest expectation.** MCP gives a better product shape and discovery channels. It does not create an audience. Expect a slow start and judge it by repeat use, not first-day spikes.

## D-031 addendum: spike result (2026-10-29)
**Passed.** A one-tool stdio server on `@modelcontextprotocol/server` 2.4.0 (spec 2026-07-28) was connected from: the new v2 client; the old v1 client (`@modelcontextprotocol/sdk` 1.32.2, which still sends `initialize`); the official Inspector CLI (npx resolved version 1.0.3, a v1-era build); and **Claude Code 2.1.170**, a real product, which called the tool and returned the right values. The v2 server negotiates down for older-protocol clients, which was the main unknown. Annotations (`readOnlyHint` and the rest) and `structuredContent` with an output schema round-tripped intact.

**Decision confirmed:** build on v2. The tool layer stays SDK-agnostic anyway, so a fallback to v1 would be a small change.

**Not tested** (needs a person at a desktop): Claude Desktop, Cursor and VS Code as GUI apps. Their MCP stacks are the same protocol, but this is unproven until someone installs it; the Windsurf/Zed-style apps are likewise untested.

## D-032 correction and final tool surface
D-032 was titled "four task-shaped tools" but listed three tools plus one explicitly excluded idea. The correct and built surface is **three read-only tools** (`get_ranked_issues`, `explain_issue`, `list_watched_repos`) **plus one prompt** (`issue_radar`). Details settled during the build: tool inputs use zod schemas whose error messages tell the model how to correct itself (for example a bad time window says "Use a number plus h or d, for example 24h, 3d or 7d", found because the first version returned "Too big: expected string to have <=8 characters"); every tool declares an output schema, and results carry both structured data and a plain-text rendering for clients that read only text; URLs are rebuilt from repo and number and never copied from API data.

## D-037: The published package is generated from the server's import closure
**Context.** The repository holds two products: the email digest (nodemailer, Redis, Gemini, dotenv) and the MCP server. Publishing the repo's `package.json` would make `npx issuewatcher-mcp` install the digest's libraries too: slower first run (it is the first thing a new user waits for) and a larger supply-chain surface.

**Decision.** `scripts/stage-mcp.ts` starts at `build/mcp/main.js`, follows every relative import, collects the third-party packages those files import, and writes a package containing only those files and only those dependencies (3: `@modelcontextprotocol/server`, `axios`, `zod`). It fails if the server imports something that is not a declared dependency. It rewrites the README's relative links to absolute GitHub URLs (npm shows the README away from the repo), sets `mcpName`, and the same staged package feeds the npm tarball, the Docker `mcp` image and the Claude Desktop bundle.

**Measured.** 22 files, 30 KB tarball, 18 s to install into an empty folder (20 MB of node_modules, 0 known vulnerabilities); the `.mcpb` is 3 MB; the MCP image is built from the same stage.

**Guard.** A test stages the package and asserts the dependency list is exactly those three and that no digest, mail, cache or test code is included, so a stray import cannot silently bloat the release. Alternatives considered: a monorepo with two packages (cleaner, but more tooling for one consumer; deferred per D-030) and marking the digest's libraries optional (still downloaded).

## D-038: stdio hygiene and failure behaviour of the MCP server
- **stdout is sacred.** Over stdio, stdout carries only protocol messages; one stray log line corrupts the stream and the client just reports "server disconnected". The server routes every log to stderr (`logToStderr`), redirects `console.log` defensively, and a test spawns the real process and checks that every stdout line is JSON-RPC.
- **Missing or bad configuration never crashes the server.** With no token the server still starts and every tool returns an actionable message (where to create a token, how to set it, how to run `--check`); an invalid setting falls back to its default and is reported; GitHub failures are mapped to fixed, safe messages (401, 403, rate limit, 404, network) that never include the raw error text, which can contain URLs and headers. Tests inject errors containing a fake token and assert it never appears in any output.
- **`--check`** is a plain-words self-test (token present, token works and as whom, API budget left, how many repos are watched and why, dependency scan result) with a non-zero exit code on failure. It exists because the most common failure is a first-time user who sees an empty AI app and cannot tell why.
- **Shutdown:** closing stdin is how a stdio client stops a server, so it exits; SIGINT and SIGTERM also exit cleanly.

## D-039: Radar mechanics, measured behaviour and one bug found
**Mechanics.** The radar scans watched repos with bounded concurrency (8), keeps results in memory for 10 minutes keyed by repo and the window start rounded to the hour, and has a 20-second budget after which it answers with what it has, marked `partial`, and says how many repos it did not reach; a rate limit stops the scan the same way; one failing repo is skipped with a safe reason and never fails the call; a rejected token aborts with an actionable error. Ordering is deterministic (score, then newer issue number, then repo) so results are reproducible and tool output is cache-friendly. Dependency discovery is cached on disk for 24 hours.

**Measured on a real account (51 watched repos: 16 starred, 35 from dependencies):** setup check 8.7 s cold, 2.0 s with the dependency cache; first `get_ranked_issues` 9.7 s; the same question again 0.0 s; `explain_issue` 0.5 s; the same flow inside the Docker image gave the same results.

**Bug found by testing.** The first version called `unref()` on the budget timer. When every pending request hung, nothing else kept the process alive, so Node concluded there was nothing left to do and exited instead of answering. The test for the budget caught it; the timer is no longer unref'd (it is always cleared in `finally`).

**Found by reading real output.** A dead-link issue in `security/sca/README.md` ranked 70 because the folder name "security" counted as a severity word: see D-041.

## D-040: Test strategy and verification status of the MCP server
**Layers (210 tests in total; 207 run by default, 3 need a Docker image and are skipped unless one is named).**
1. Unit tests: sanitiser (hidden characters, link targets, markup, length, surrogate-safe truncation), parameter schemas, settings, TTL cache.
2. Radar tests against a fake GitHub: ranking, filters, caching and expiry, concurrency bound, time budget with hanging requests, failure isolation, rate limit, auth failure, ignore rules, deterministic order, the explain breakdown, and a property test that the score breakdown sums exactly to the score across 1,000+ generated combinations of mode, labels, titles, assignees, comments and targets.
3. In-process protocol tests with the real server and the real v2 client over an in-memory transport: tool list and annotations, schemas, validation errors, prompts, missing token, hostile text in every field, error leakage.
4. End-to-end over real stdio: the compiled server is spawned and driven by the v2 client, by the old v1 client, and by a raw JSON-RPC client that checks stdout cleanliness; a local stub stands in for GitHub, npm and PyPI.
5. Packaging: the staged package contents and dependencies, the Claude Desktop manifest (validated by the official validator) against the real tool list, `server.json` (validated against the official registry schema, with a negative control proving the validator can fail), a tarball install into an empty folder, an unpacked `.mcpb` run with the manifest's own launch command, and the Docker image over `docker run -i` (non-root user, `--check`, no-token behaviour).
6. Real world: the compiled server and the Docker image against live GitHub with a real token; **Claude Code 2.1.170 (a real client) driving the actual server against the real account** (it returned the same top three issues and scores as direct calls); and a measured cold-start and cache behaviour on that account (D-042).
7. Refactor safety: the scorer was rewritten to record a per-signal breakdown; it was compared against the previous version on 100 real issues in all three modes (300 comparisons): zero differences in score or reasons.

**Verified live:** everything above. **Not verified, needs a person or an account:** Claude Desktop, Cursor and VS Code as GUI clients; `npm publish`; the registry publish; the Release workflow's new jobs and the new CI jobs (they pass `actionlint` and their commands were run by hand, but they have not run on GitHub); directory submissions; macOS and Linux (development and tests ran on Windows 11 plus Linux containers).

## D-041: Severity words inside file paths are ignored
**Context.** Reading the first real MCP output, an issue titled "Dead link to Sustainable Use License in security/sca/README.md" scored 70, because "security" in the path counted as a severity word in the title. A folder name says where, not how bad.

**Decision.** Before matching severity words in a title, tokens containing a slash or backslash are removed. "Crash in src/main.ts on startup" still counts (the word is outside the path); "Dead link in security/sca/README.md" does not. Tested for forward and back slashes and for the unaffected cases. This changes the digest too, since both use the same scorer.

## D-042: Warm-up, shared loads and a window-reuse cache (found by running it for real)
**What the real runs showed.** With a real account (51 watched repos) the first question took 9.7 s, then 22.8 s on the same machine a few minutes later, and 52 s then 10.7 s inside Docker. The network to GitHub and to the package registries varies by a factor of five, so a cold first call anywhere from 10 s to 50 s is normal, which is long enough for some AI apps to give up on a tool call (30 to 60 s is common). The unit tests could not show this: their fake network answers instantly.

**Changes.**
1. **Background warm-up.** When the server starts it immediately loads the repo list and the default (3-day) window of issues, without waiting for a question (`ISSUEWATCHER_PREFETCH=false` turns it off). An app starts its servers when it opens, and a person takes seconds to type, so the first question usually finds everything ready.
2. **Shared loads.** If a warm-up and a question, or two questions, ask for the same thing at the same moment, they share one request instead of repeating it.
3. **One budget for the whole call.** The 20-second limit now covers loading the repo list too. On a very slow first run the answer is an honest "still loading, ask again in a few seconds" (`partial: true` plus a `notice` the assistant can relay) while the load continues in the background and is reused by the next question. Partial results from a scan that runs out of time or hits GitHub's rate limit carry a notice as well.
4. **A cache that reuses windows.** The first version cached per repo and exact window start, so the warm-up's 3-day window did not help a question about 2 days; this was found by the second real Docker run (8.6 s after a 25 s pause). The cache is now per repo and remembers how far back the fetch reached; every fetch reaches back at least 72 h (a single request either way), and any question about an equal or shorter window is answered by filtering what is already loaded. The result is identical to a fresh fetch: GitHub returns the newest issues first, so the newest N within a later start date are a subset of the newest N within an earlier one.

**Measured on the real account.** First question asked immediately after start, everything cold: 11.8 s. Asked 25 s after start, as a person would: **0.0 s**, on the host and inside the Docker image, including for a different time window than the one that was prefetched.

**Why this matters beyond speed.** An answer that takes 50 s is, for most users, the same as a server that does not work, and a user decides in their first attempt. It is the kind of defect that only appears with real latency, which is why D-040 requires a real-account run before every release.

**Costs and limits.** Each app launch spends about one GitHub request per watched repo (about 50 of the 5,000 per hour) even if the user never asks; it can be turned off. Only the 20 newest issues per repo are considered in a window, so in a very busy repo older issues inside the window may not appear; the answer does not yet say when a repo hit that cap.

## D-043: A title about a newer major than you run is scored down (found by the first real-client run)
**What happened.** The first run in Claude Code put typeorm/typeorm #13021 at the top with 100. The issue is a regression in TypeORM **1.x** on SQL Server; the user's project uses `^0.3.28`. The scorer gave +25 for "mentions 0.3.x, you use ^0.3.28", because the body says the query worked in 0.3.31 and compares 0.3.31 and 1.1.2 in a table. The scorer finds version numbers; it cannot tell "broken in X" from "fine in X". Worse, when asked to explain, the assistant relied on that signal and told the user "this is a 0.3.x regression, you may already be affected", which was wrong.

**Change.**
1. If the **title** names a newer major than every version of that dependency you use ("1.x regression", "since v2.0"), the issue gets -15 (`newer-major`) and the body's version mentions are not used for a version match, since they are comparisons with the old release.
2. A version directly after words such as "worked in", "as it did in", "before", "previously", "downgrading to" is not counted as a match, in any issue.
3. A version preceded by another product's name ("TS 7.0", "Node 22.x") is not read as the dependency's. A first version of the rule penalised `tsconfig-paths` for "TS 7.0"; the real-data comparison caught it.
4. Wildcard ranges (`*`) are left alone: there is no major to compare.

**Checked.** Regression tests for each case, including the real issue text. Re-scoring the 100 saved real issues: no score changed, so nothing else moved. The TypeORM issue goes from 95 to 55 in the same mode.

**Limits.** A title that does not name the version (the version only in the body) still gets the old behaviour apart from rule 2. The wording lists in rules 2 and 3 are English only and will miss phrasings. This is the kind of mistake the rule-based scorer will keep making; the explanation tool exists so the assistant and the user can see the reason, and the reason here was wrong, so the real fix is a labelled data set (see D-036), not more rules.

## D-044: Recommend a global install; `npx` can exceed the client's 30 s startup limit (found by the first real-client run)
**What happened.** After the first successful run, a later Claude Code session reported the server "timed out after 30s". Its connection log showed no output from the server at all for 30 s on one start, and "ready" only 22.6 s after launch on another. The server itself prints "ready" in under a second; the time was spent before our code ran.

**Measured on the same Windows machine** (`--version`, which does no network work): `npx -y issuewatcher-mcp` 29 s, then 14 s, `npx -y issuewatcher-mcp@0.2.1` 8 s, `npx --offline` 5 s (the floor, pure npx overhead), against a global install **0.7 to 0.9 s**. An unversioned `npx` asks the registry on every start, so it is also at the mercy of the network.

**Decision.** The docs lead with `npm install -g issuewatcher-mcp` and the command `issuewatcher-mcp`, and keep `npx` as the no-install option with the caveat. The troubleshooting table names this timeout. The Claude Desktop bundle runs the server directly with Node, not through npx, so it is unaffected (checked in the manifest). The server code needed no change.

**Why not "fix it in code".** Nothing in our process can speed up npx, and a server that connects instantly (as ours does) cannot be made faster by us. The honest options were to document the fast path, or to ship only as a bundle/binary; the first is cheap and enough for now.

**Limits.** `npm install -g` needs permission to write to npm's global folder on some systems, and users must re-run it to update. A single-file download or a Homebrew/winget package would remove that step; not worth it before there are users.
