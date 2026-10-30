import { minVersion } from "../deps/manifests.js";
import type { Issue, WatchTarget } from "../poller/types.js";

export type Score = {
  /** 0-100; higher means more worth your attention. */
  score: number;
  /** Human-readable reasons shown in the email ("why you're seeing this"). */
  reasons: string[];
};

/** One signal's contribution to a score. The parts of a `DetailedScore` sum to its `raw` value. */
export type ScorePart = {
  /** Stable machine-readable key, e.g. "unassigned" or "severity-cap". */
  signal: string;
  points: number;
  reason: string;
};

export type DetailedScore = Score & {
  /** Every signal that added or removed points, in the order they were applied. */
  breakdown: ScorePart[];
};

export type ScoredIssue = Score & { issue: Issue; target: WatchTarget };

const SEVERE = /\b(regression|crash(?:es|ed|ing)?|segfault|security|vulnerab\w*|cve-\d+|data loss|memory leak|breaking change|deadlock|panic)\b/i;
// In free text, "panic" is usually a PostgreSQL/Go log level and "security" a feature name, so only the
// title and labels get to claim them; the body must say something more specific.
const SEVERE_BODY = /\b(regression|crash(?:es|ed|ing)?|segfault|vulnerab\w*|cve-\d+|data loss|memory leak|breaking change|deadlock)\b/i;
// "Add a regression test" asks for tests; it does not report a regression.
const REGRESSION_TEST = /\bregression[- ](?:tests?|suites?|coverage|specs?|cases?)\b/gi;
const GENERIC_TITLE = /^(?:report (?:a )?bug|bug(?: report)?|new issue|issue|help|question|feature request|test|testing|hello|hi|problem|error|not working)[.!?\s]*$/i;
// The work is already taken, or the reporter is doing it.
const LABEL_CLAIMED = /(team[: -]*assigned|in[ -]?progress|has[ -]?pr|pr[ -]?(?:open|submitted|ready)|claimed|\bwip\b)/i;
const REPORTER_FIXING = /(?:i(?:'ll| will| can| could|'m going to| am going to|'m happy to| am happy to|'m willing to| am willing to|'m open to| am open to| would like to|'d like to| want to)\s+(?:also\s+)?(?:work on|submit|open|send|create|raise|make|take|fix|implement|contribute)|(?:pr|pull request)\s+(?:is\s+)?(?:already\s+)?(?:ready|prepared|coming|incoming|submitted|opened)|already (?:have|opened|prepared|submitted)|assign(?: this)? to me|can i (?:work on|take))/i;
// Only phrases that say THIS issue is being fixed. "Similar to the fix in #123" or "fixes like #64668" must not match.
const FIX_IN_PR = /\b(?:(?:fix(?:ed)?|addressed|resolved)\s+(?:in|by)\s+(?:(?:github\s+)?(?:pr|pull request)\s*)?#\d+|(?:tracked|proposed fix is|fix is|a fix is|pr is|pr)\s+(?:in|at)\s+(?:(?:github\s+)?(?:pr|pull request)\s*)?#\d+)/i;
// The reporter is already writing the fix: "I'm opening a PR", "preparing a pull request", "working on a fix".
const REPORTER_WRITING = /\b(?:i(?:'m| am)|we(?:'re| are)|currently)\s+(?:also\s+)?(?:opening|preparing|submitting|sending|working on|writing|drafting)\s+(?:a\s+|the\s+|my\s+)?(?:\w+\s+){0,2}?(?:pr|pull request|patch|fix)\b|\b(?:opening|preparing|submitting)\s+(?:a\s+)?(?:\w+\s+){0,2}?(?:pr|pull request)\b/i;
const LABEL_SEVERE =/(regression|security|critical|crash|breaking|p0|priority[: -]*high|severity[: -]*high)/i;
const LABEL_BUG = /\bbug\b/i;
const LABEL_NOISE = /\b(question|support|docs?|documentation|stale|discussion)\b/i;
// A contributor happily takes docs work; only genuine non-tasks count as noise for them.
const LABEL_NOISE_CONTRIBUTOR = /\b(question|support|stale|discussion)\b/i;
const LABEL_EASY = /(good[ -]first[ -]issue|beginner|starter|easy|first[ -]timers?)/i;
const LABEL_HELP = /(help[ -]wanted|hacktoberfest|contributions?[ -]welcome)/i;
const REPRO = /(steps to reproduce|expected (?:behaviou?r|result)|actual (?:behaviou?r|result)|traceback|stack ?trace|minimal reproduc|reproduction)/i;
const HOUR_MS = 3_600_000;
const TEST_WORK = /\b(tests?|testing|suite)\b/i;

/** Share of letters outside the Latin alphabet, e.g. Cyrillic or CJK titles. */
function nonLatinShare(text: string): number {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (!letters.length) return 0;
  return letters.filter((c) => !/\p{Script=Latin}/u.test(c)).length / letters.length;
}
const LABEL_DISMISSED = /(duplicate|invalid|wontfix|won't fix|not a bug)/i;
const VERSION_IN_TEXT = /\bv?(\d+)\.(\d+)\.(\d+)\b|\bv(\d+)\.(\d+)\b/g;

const WORKING_VERSION = /(worked|works|working|fine|as it did|did|passes|passed)\s+(in|on|with|until|before)\s+(version\s+)?$|(before|previously|prior to|until|downgrad\w*\s+to|rolled? back to|older than|earlier than)\s+(version\s+)?$/i;

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/** Versions mentioned in free text, as {major, minor}. */
function mentionedVersions(text: string): Array<{ major: number; minor: number }> {
  const out: Array<{ major: number; minor: number }> = [];
  for (const m of text.matchAll(VERSION_IN_TEXT)) {
    // "worked in 0.3.31" names the version that is fine, not the one that is broken.
    const before = text.slice(Math.max(0, (m.index ?? 0) - 40), m.index ?? 0);
    if (WORKING_VERSION.test(before)) continue;
    out.push({ major: Number(m[1] ?? m[4]), minor: Number(m[2] ?? m[5]) });
  }
  return out;
}

/** Words that may come right before a version without it belonging to some other product. */
const VERSION_LEAD = new Set("in on since from after with to at for and the version v".split(" "));

/** Majors a title names ("1.x", "v2", "2.3.1"). "TS 7.0" or "Node 22.x" name another product and are skipped. */
function titleMajors(title: string): number[] {
  const out: number[] = [];
  for (const m of title.matchAll(/(^|[^\w.])(?:([a-z][\w-]*)\s+)?v?(\d+)\.(?:x|\d+)/gi)) {
    if (!m[2] || VERSION_LEAD.has(m[2].toLowerCase())) out.push(Number(m[3]));
  }
  return out;
}

export type ScoringMode = "consumer" | "contributor" | "both";
export type ScoreOptions = { mode?: ScoringMode; now?: number };

/**
 * The user's dependencies that this issue is actually about. DefinitelyTyped holds the types
 * for every package, so only an issue about a @types package the user depends on is about
 * their code: "[@types/sinon] ..." says nothing about @types/express.
 */
export function relevantDependencies(
  issue: Pick<Issue, "repo" | "title">,
  target: WatchTarget,
): { deps: WatchTarget["dependencies"]; typesFor: string | undefined; typesMismatch: boolean } {
  const typesFor =
    issue.repo.toLowerCase() === "definitelytyped/definitelytyped"
      ? issue.title.match(/@types\/([\w.-]+)/i)?.[1]?.toLowerCase()
      : undefined;
  if (!typesFor) return { deps: target.dependencies, typesFor, typesMismatch: false };

  const deps = target.dependencies.filter((d) => d.pkg.toLowerCase() === `@types/${typesFor}`);
  return { deps, typesFor, typesMismatch: deps.length === 0 };
}

/**
 * Rule-based relevance. Deliberately transparent: every point added or removed
 * comes with a reason, so users can see (and we can tune) why an issue ranked
 * where it did. See DECISIONS.md D-018.
 *
 * Every change to the score goes through `add`, which records it, so the
 * `breakdown` always sums to the unclamped score.
 */
export function scoreIssueDetailed(issue: Issue, target: WatchTarget, opts: ScoreOptions = {}): DetailedScore {
  const mode = opts.mode ?? "both";
  const now = opts.now ?? Date.now();
  const reasons: string[] = [];
  const breakdown: ScorePart[] = [];
  let score = 0;

  /** Applies points; `reason` is shown to the user, `note` only appears in the breakdown. */
  const add = (points: number, signal: string, reason?: string, note?: string) => {
    score += points;
    if (reason) reasons.push(reason);
    breakdown.push({ signal, points, reason: reason ?? note ?? signal });
  };

  // Why we watch this repo at all.
  const { deps, typesFor, typesMismatch } = relevantDependencies(issue, target);

  const runtime = deps.find((d) => d.kind === "runtime");
  const dev = deps.find((d) => d.kind === "dev");
  // Dev tooling matters less than what ships: damp its version, severity and attention signals.
  const devOnly = !runtime && Boolean(dev);
  const consumer = mode !== "contributor";
  const contributor = mode !== "consumer";
  if (runtime) {
    add(consumer ? 40 : 15, "dependency-runtime", `you depend on ${runtime.pkg} (${runtime.range})`);
  } else if (dev) {
    add(consumer ? 25 : 8, "dependency-dev", `dev dependency ${dev.pkg} (${dev.range})`);
  }
  if (target.starred) {
    // A contributor stars what they want to work on, so a star is a strong signal, not a weak one.
    if (runtime || dev) add(5, "starred", undefined, "you also starred this repo");
    else add(contributor ? 30 : 20, "starred", "starred repo");
  }
  if (typesMismatch) {
    add(-25, "types-mismatch", `types for ${typesFor}, which you do not use`);
  }
  const sharedBy = Math.max(0, ...deps.map((d) => d.usedBy.length));
  if (sharedBy >= 2) {
    add(5, "shared-dependency", `used by ${sharedBy} of your repos`);
  }

  // Does the report concern a version the user runs?
  const text = `${issue.title}\n${issue.body.slice(0, 4000)}`;
  const versions = mentionedVersions(text);
  // A title about a newer major than you run (a "1.x regression", you use ^0.3) is probably not about
  // you. Older versions in its body are then comparisons ("worked in 0.3.31"), not matches.
  const titleVersions = titleMajors(issue.title);
  const mineMajors = deps.map((d) => minVersion(d.range)).filter((v): v is NonNullable<typeof v> => v !== null);
  const newerMajor =
    consumer &&
    !runtime?.range.includes("*") &&
    titleVersions.length > 0 &&
    mineMajors.length > 0 &&
    titleVersions.every((m) => mineMajors.every((v) => m > v.major));
  if (consumer && versions.length && !newerMajor) {
    let best: { points: number; reason: string } | null = null;
    for (const dep of deps) {
      const mine = minVersion(dep.range);
      if (!mine) continue;
      for (const v of versions) {
        if (v.major !== mine.major) continue;
        const exact = v.minor === mine.minor;
        // For 0.x packages every minor is a breaking release, so a major-only match says nothing.
        if (!exact && mine.major === 0) continue;
        const points = exact ? (devOnly ? 12 : 25) : devOnly ? 3 : 5;
        if (!best || points > best.points) {
          best = {
            points,
            reason: exact
              ? `mentions ${v.major}.${v.minor}.x, you use ${dep.range}`
              : `mentions v${v.major}, you use ${dep.range}`,
          };
        }
      }
    }
    if (best) {
      add(best.points, "version-match", best.reason);
    }
  }
  if (newerMajor) {
    add(-15, "newer-major", `title is about v${titleVersions[0]}, you use ${deps[0]!.range}`);
  }

  // Severity signals. Each is recorded individually; the total is capped afterwards.
  let severity = 0;
  const sevParts: ScorePart[] = [];
  const sev = (points: number, signal: string, reason: string) => {
    severity += points;
    reasons.push(reason);
    sevParts.push({ signal, points, reason });
  };
  // A word inside a file path ("security/sca/README.md") names a folder, not a problem.
  const titleText = issue.title.replace(/\S*[\\/]\S*/g, " ");
  const titleHit = TEST_WORK.test(issue.title) ? null : titleText.match(SEVERE);
  if (titleHit) {
    sev(20, "severity-title", `title says "${titleHit[0].toLowerCase()}"`);
  } else {
    const bodyHit = issue.body.slice(0, 4000).replace(REGRESSION_TEST, " ").match(SEVERE_BODY);
    if (bodyHit) {
      sev(8, "severity-body", `body mentions "${bodyHit[0].toLowerCase()}"`);
    }
  }
  const labels = issue.labels.join(" | ");
  if (LABEL_SEVERE.test(labels)) {
    sev(20, "severity-label", "severe label");
  } else if (LABEL_BUG.test(labels)) {
    sev(10, "bug-label", "labelled bug");
  }
  const severityCap = devOnly ? 10 : 30;
  breakdown.push(...sevParts);
  score += severity;
  if (severity > severityCap) {
    add(severityCap - severity, "severity-cap", undefined, `severity capped at ${severityCap}${devOnly ? " (dev dependency)" : ""}`);
  }

  // Dismissals and noise.
  if (LABEL_DISMISSED.test(labels)) {
    add(-25, "dismissed-label", "marked duplicate/invalid");
  } else if ((contributor && !consumer ? LABEL_NOISE_CONTRIBUTOR : LABEL_NOISE).test(labels)) {
    add(-15, "noise-label", "question/docs label");
  }
  if (issue.isBot) {
    add(-25, "bot-author", "opened by a bot");
  }
  if (issue.body.trim().length < 30) {
    add(-5, "little-detail", "little detail");
  }

  // Junk filter: low-effort titles are rarely a task anyone can act on.
  const title = issue.title.trim();
  if (title.length < 10 || !/\s/.test(title) || GENERIC_TITLE.test(title)) {
    add(-20, "vague-title", "vague title");
  } else if (nonLatinShare(title) > 0.5) {
    add(-15, "non-english-title", "non-English title");
  }

  // Community attention.
  if (!devOnly) {
    if (issue.reactions >= 3) {
      add(5, "reactions", `${issue.reactions} reactions`);
    }
    // Many comments mean attention for a user, but a crowd for a contributor (someone is probably on it).
    if (issue.comments >= 5 && !contributor) {
      add(5, "comments", `${issue.comments} comments`);
    }
  }

  // Can I pick this up and fix it? (contributor view)
  if (contributor) {
    if (LABEL_EASY.test(labels)) {
      add(20, "good-first-issue", "good first issue");
    } else if (LABEL_HELP.test(labels)) {
      add(15, "help-wanted", "help wanted");
    }

    if (issue.assignees > 0) {
      add(-25, "assigned", "already assigned");
    } else {
      add(10, "unassigned", "unassigned");
    }

    const ageH = (now - Date.parse(issue.createdAt)) / HOUR_MS;
    if (Number.isFinite(ageH) && ageH >= 0 && ageH <= 48) {
      add(10, "fresh", ageH < 1 ? "opened just now" : `opened ${Math.floor(ageH)}h ago`);
    }

    // Work that is already taken is not something to pick up.
    if (LABEL_CLAIMED.test(labels)) {
      add(-20, "team-on-it", "team already on it");
    } else if (REPORTER_FIXING.test(issue.body) || REPORTER_WRITING.test(issue.body) || FIX_IN_PR.test(issue.body)) {
      add(-15, "fix-planned", "a fix is already planned or open");
    }

    if (issue.comments >= 10) {
      add(-5, "crowded", `crowded (${issue.comments} comments)`);
    } else if (issue.comments <= 2 && issue.assignees === 0) {
      add(5, "few-comments", "few comments");
    }

    // Template headings alone ("### Steps to reproduce") must not count: require real text around them.
    const substance = issue.body.replace(/^#{1,6}.*$/gm, "").replace(/\s+/g, " ").trim();
    if (REPRO.test(issue.body) && substance.length >= 100) {
      add(5, "repro", "has reproduction details");
    } else if (issue.body.trim().length >= 200) {
      add(3, "detailed", "detailed description");
    }
  }

  const final = clamp(score);
  if (final !== score) {
    breakdown.push({ signal: "clamp", points: final - score, reason: "score limited to the range 0-100" });
  }
  return { score: final, reasons, breakdown };
}

/** The score and reasons only; used by the digest, the evaluation and ranking. */
export function scoreIssue(issue: Issue, target: WatchTarget, opts: ScoreOptions = {}): Score {
  const { score, reasons } = scoreIssueDetailed(issue, target, opts);
  return { score, reasons };
}

export function rankIssues(
  items: Array<{ issue: Issue; target: WatchTarget }>,
  opts: ScoreOptions = {},
): ScoredIssue[] {
  return items
    .map((it) => ({ ...it, ...scoreIssue(it.issue, it.target, opts) }))
    .sort((a, b) => b.score - a.score || b.issue.number - a.issue.number);
}
