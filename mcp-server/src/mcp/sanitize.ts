/**
 * Everything that comes from a GitHub issue (title, labels, body) is written by a
 * stranger and ends up in front of an AI model. This module is the one place that
 * text is made safe to hand over. It cannot make prompt injection impossible; it
 * removes the cheap tricks (hidden characters, link targets, markup, huge text) and
 * caps the size. See DECISIONS.md D-033.
 */

/** Characters that render as nothing or reorder text, so they can hide instructions from a human reader. */
function isInvisible(cp: number): boolean {
  return (
    cp <= 0x1f || // C0 controls (newline and tab are replaced by spaces before this check)
    (cp >= 0x7f && cp <= 0x9f) || // DEL and C1 controls
    cp === 0xad || // soft hyphen
    cp === 0x34f || // combining grapheme joiner
    cp === 0x61c || // Arabic letter mark
    cp === 0x180e || // Mongolian vowel separator
    (cp >= 0x200b && cp <= 0x200f) || // zero-width space/joiners, directional marks
    (cp >= 0x2028 && cp <= 0x202e) || // line/paragraph separators, bidi embedding and override
    (cp >= 0x2060 && cp <= 0x206f) || // word joiner, invisible operators, deprecated format characters
    cp === 0xfeff || // zero-width no-break space / BOM
    (cp >= 0xfff9 && cp <= 0xfffb) || // interlinear annotation anchors
    (cp >= 0xe0000 && cp <= 0xe007f) || // Unicode "tag" characters: invisible ASCII smuggling
    (cp >= 0xe0100 && cp <= 0xe01ef) // supplementary variation selectors
  );
}

/**
 * Plain, single-line, length-capped text. Markdown links become their label, URLs become
 * "[link]", HTML-like tags are dropped, and invisible characters are removed.
 */
export function cleanText(input: unknown, max = 200): string {
  const raw = typeof input === "string" ? input : input == null ? "" : String(input);

  let out = "";
  for (const ch of raw) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d) out += " ";
    else if (!isInvisible(cp)) out += ch;
  }

  out = out
    .replace(/!?\[([^\]]{0,300})\]\([^)]{0,1000}\)/g, "$1") // [label](target) and ![alt](target)
    .replace(/<[^<>]{0,300}>/g, "") // <tags>, <!-- comments -->
    .replace(/\b(?:https?|ftp|file|data|javascript):\/\/?\S*/gi, "[link]")
    .replace(/\s+/g, " ")
    .trim();

  const points = Array.from(out);
  return points.length > max ? `${points.slice(0, Math.max(0, max - 1)).join("").trimEnd()}…` : out;
}

/** A GitHub label name: short, plain, no markup. */
export const cleanLabel = (label: unknown): string => cleanText(label, 40);

/** Canonical issue URL built from the repo and number, never taken from API data. */
export const issueUrl = (repo: string, number: number): string => `https://github.com/${repo}/issues/${number}`;

/** "owner/name" as GitHub allows it; anything else is shown as a placeholder instead of echoed. */
export function safeRepoName(repo: string): string {
  return /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repo) ? repo : "(invalid repo name)";
}
