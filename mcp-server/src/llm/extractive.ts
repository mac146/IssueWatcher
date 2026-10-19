import type { Issue } from "../poller/types.js";

const MAX_CHARS = 280;
const MAX_SENTENCES = 2;

/** Lines that are only issue-template scaffolding, not content. */
const SCAFFOLDING = /^(?:#{1,6}\s.*|[-*]\s*\[[ x]\].*|\*\*[^*]+\*\*:?|[A-Za-z ]{1,40}:)\s*$/;

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/https?:\/\/\S+/g, " ");
}

/**
 * A short plain excerpt of what the reporter wrote, used when no AI summary is
 * available (no provider configured, quota exhausted). It does not interpret
 * the issue, so it is labelled as an excerpt, never as a summary.
 */
export function excerpt(issue: Issue): string | null {
  const lines = stripMarkdown(issue.body)
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l && !SCAFFOLDING.test(l));
  const text = lines.join(" ").trim();
  if (!text) return null;

  const sentences = text.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) ?? [text];
  let out = sentences.slice(0, MAX_SENTENCES).join("").trim();
  if (out.length > MAX_CHARS) out = `${out.slice(0, MAX_CHARS).trimEnd()}…`;
  return `Excerpt: ${out}`;
}
