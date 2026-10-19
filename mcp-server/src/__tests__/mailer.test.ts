import assert from "node:assert/strict";
import { test } from "node:test";
import type { Digest } from "../digest.js";
import { buildSubject, renderHtml, renderText } from "../mail/mailer.js";
import { issue, starred } from "./helpers.js";

const scored = (n: number, extra = {}, score = 50) => ({
  issue: issue("a/b", n, extra),
  target: starred("a/b"),
  score,
  reasons: ["starred repo"],
});

const digest: Digest = {
  top: [{ ...scored(1, { title: "<script>alert(1)</script>" }, 80), summary: "Summary: it breaks" }],
  other: [scored(2, { title: "minor typo" }, 12)],
};

test("subject reflects the number of issues and the top tier", () => {
  assert.equal(buildSubject(digest), "2 new issues, 1 worth a look");
  assert.equal(buildSubject({ top: [], other: [scored(2)] }), "New issue in a/b: Problem number 2 in the app");
  assert.equal(buildSubject({ top: [], other: [scored(2), scored(3)] }), "2 new issues in your watched repos");
});

test("html escapes untrusted issue content and shows score and reasons", () => {
  const html = renderHtml(digest);
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("relevance 80"));
  assert.ok(html.includes("Why you're seeing this: starred repo"));
  assert.ok(html.includes("Also new (lower relevance)"));
});

test("text output lists the top tier first, then the compact list", () => {
  const text = renderText(digest);
  assert.ok(text.indexOf("[80]") < text.indexOf("Also new"));
  assert.ok(text.includes("Why: starred repo"));
  assert.ok(text.includes("- [12] a/b#2: minor typo"));
});

test("an entry without a summary says so", () => {
  const text = renderText({ top: [{ ...scored(1), summary: null }], other: [] });
  assert.ok(text.includes("(No AI summary available)"));
});
