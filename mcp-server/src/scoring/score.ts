import { minVersion } from "../deps/manifests.js";
import type { Issue, WatchTarget } from "../poller/types.js";

export type Score = {
  /** 0-100; higher means more worth your attention. */
  score: number;
  /** Human-readable reasons shown in the email ("why you're seeing this"). */
  reasons: string[];
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
const FIX_IN_PR = /\b(?:fix(?:ed|es)?|tracked|proposed|addressed)\b[^.\n]{0,40}(?:#\d+|\bPR\b|pull request)/i;
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

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/** Versions mentioned in free text, as {major, minor}. */
function mentionedVersions(text: string): Array<{ major: number; minor: number }> {
  const out: Array<{ major: number; minor: number }> = [];
  for (const m of text.matchAll(VERSION_IN_TEXT)) {
    out.push({ major: Number(m[1] ?? m[4]), minor: Number(m[2] ?? m[5]) });
  }
  return out;
}

/**
 * Rule-based relevance. Deliberately transparent: every point added or removed
 * comes with a reason, so users can see (and we can tune) why an issue ranked
 * where it did. See DECISIONS.md D-018.
 */
export type ScoringMode = "consumer" | "contributor" | "both";
export type ScoreOptions = { mode?: ScoringMode; now?: number };

export function scoreIssue(issue: Issue, target: WatchTarget, opts: ScoreOptions = {}): Score {
  const mode = opts.mode ?? "both";
  const now = opts.now ?? Date.now();
  const reasons: string[] = [];
  let score = 0;

  // Why we watch this repo at all.
  const runtime = target.dependencies.find((d) => d.kind === "runtime");
  const dev = target.dependencies.find((d) => d.kind === "dev");
  // Dev tooling matters less than what ships: damp its version, severity and attention signals.
  const devOnly = !runtime && Boolean(dev);
  const consumer = mode !== "contributor";
  const contributor = mode !== "consumer";
  if (runtime) {
    score += consumer ? 40 : 15;
    reasons.push(`you depend on ${runtime.pkg} (${runtime.range})`);
  } else if (dev) {
    score += consumer ? 25 : 8;
    reasons.push(`dev dependency ${dev.pkg} (${dev.range})`);
  }
  if (target.starred) {
    // A contributor stars what they want to work on, so a star is a strong signal, not a weak one.
    score += runtime || dev ? 5 : contributor ? 30 : 20;
    if (!runtime && !dev) reasons.push("starred repo");
  }
  const sharedBy = Math.max(0, ...target.dependencies.map((d) => d.usedBy.length));
  if (sharedBy >= 2) {
    score += 5;
    reasons.push(`used by ${sharedBy} of your repos`);
  }

  // Does the report concern a version the user runs?
  const text = `${issue.title}\n${issue.body.slice(0, 4000)}`;
  const versions = mentionedVersions(text);
  if (consumer && versions.length) {
    let best: { points: number; reason: string } | null = null;
    for (const dep of target.dependencies) {
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
      score += best.points;
      reasons.push(best.reason);
    }
  }

  // Severity signals.
  let severity = 0;
  const titleHit = TEST_WORK.test(issue.title) ? null : issue.title.match(SEVERE);
  if (titleHit) {
    severity += 20;
    reasons.push(`title says "${titleHit[0].toLowerCase()}"`);
  } else {
    const bodyHit = issue.body.slice(0, 4000).replace(REGRESSION_TEST, " ").match(SEVERE_BODY);
    if (bodyHit) {
      severity += 8;
      reasons.push(`body mentions "${bodyHit[0].toLowerCase()}"`);
    }
  }
  const labels = issue.labels.join(" | ");
  if (LABEL_SEVERE.test(labels)) {
    severity += 20;
    reasons.push("severe label");
  } else if (LABEL_BUG.test(labels)) {
    severity += 10;
    reasons.push("labelled bug");
  }
  score += Math.min(severity, devOnly ? 10 : 30);

  // Dismissals and noise.
  if (LABEL_DISMISSED.test(labels)) {
    score -= 25;
    reasons.push("marked duplicate/invalid");
  } else if ((contributor && !consumer ? LABEL_NOISE_CONTRIBUTOR : LABEL_NOISE).test(labels)) {
    score -= 15;
    reasons.push("question/docs label");
  }
  if (issue.isBot) {
    score -= 25;
    reasons.push("opened by a bot");
  }
  if (issue.body.trim().length < 30) {
    score -= 5;
    reasons.push("little detail");
  }

  // Junk filter: low-effort titles are rarely a task anyone can act on.
  const title = issue.title.trim();
  if (title.length < 10 || !/\s/.test(title) || GENERIC_TITLE.test(title)) {
    score -= 20;
    reasons.push("vague title");
  } else if (nonLatinShare(title) > 0.5) {
    score -= 15;
    reasons.push("non-English title");
  }

  // Community attention.
  if (!devOnly) {
    if (issue.reactions >= 3) {
      score += 5;
      reasons.push(`${issue.reactions} reactions`);
    }
    // Many comments mean attention for a user, but a crowd for a contributor (someone is probably on it).
    if (issue.comments >= 5 && !contributor) {
      score += 5;
      reasons.push(`${issue.comments} comments`);
    }
  }

  // Can I pick this up and fix it? (contributor view)
  if (contributor) {
    if (LABEL_EASY.test(labels)) {
      score += 20;
      reasons.push("good first issue");
    } else if (LABEL_HELP.test(labels)) {
      score += 15;
      reasons.push("help wanted");
    }

    if (issue.assignees > 0) {
      score -= 25;
      reasons.push("already assigned");
    } else {
      score += 10;
      reasons.push("unassigned");
    }

    const ageH = (now - Date.parse(issue.createdAt)) / HOUR_MS;
    if (Number.isFinite(ageH) && ageH >= 0 && ageH <= 48) {
      score += 10;
      reasons.push(ageH < 1 ? "opened just now" : `opened ${Math.floor(ageH)}h ago`);
    }

    // Work that is already taken is not something to pick up.
    if (LABEL_CLAIMED.test(labels)) {
      score -= 20;
      reasons.push("team already on it");
    } else if (REPORTER_FIXING.test(issue.body) || FIX_IN_PR.test(issue.body)) {
      score -= 15;
      reasons.push("a fix is already planned or open");
    }

    if (issue.comments >= 10) {
      score -= 5;
      reasons.push(`crowded (${issue.comments} comments)`);
    } else if (issue.comments <= 2 && issue.assignees === 0) {
      score += 5;
      reasons.push("few comments");
    }

    // Template headings alone ("### Steps to reproduce") must not count: require real text around them.
    const substance = issue.body.replace(/^#{1,6}.*$/gm, "").replace(/\s+/g, " ").trim();
    if (REPRO.test(issue.body) && substance.length >= 100) {
      score += 5;
      reasons.push("has reproduction details");
    } else if (issue.body.trim().length >= 200) {
      score += 3;
      reasons.push("detailed description");
    }
  }

  return { score: clamp(score), reasons };
}

export function rankIssues(
  items: Array<{ issue: Issue; target: WatchTarget }>,
  opts: ScoreOptions = {},
): ScoredIssue[] {
  return items
    .map((it) => ({ ...it, ...scoreIssue(it.issue, it.target, opts) }))
    .sort((a, b) => b.score - a.score || b.issue.number - a.issue.number);
}
