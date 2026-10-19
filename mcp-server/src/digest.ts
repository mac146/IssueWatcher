import type { ScoredIssue } from "./scoring/score.js";

/** A high-relevance issue; `summary` is null if the LLM failed or was unavailable. */
export type DigestEntry = ScoredIssue & { summary: string | null };

export type Digest = {
  /** Worth a look: ranked, with AI summary and "why you're seeing this". */
  top: DigestEntry[];
  /** Lower relevance, or beyond the per-email summary cap: listed compactly, no LLM call. */
  other: ScoredIssue[];
};

export const digestSize = (d: Digest) => d.top.length + d.other.length;
