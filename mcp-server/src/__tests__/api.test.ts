import assert from "node:assert/strict";
import { test } from "node:test";
import type { AxiosInstance } from "axios";
import { GitHubAPI } from "../github/api.js";

type Page = { data: unknown[]; next?: string };

function fakeClient(pages: Page[]): { client: AxiosInstance; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const client = {
    get: async (url: string) => {
      calls.push(url);
      const p = pages[i++]!;
      return { data: p.data, headers: p.next ? { link: `<${p.next}>; rel="next"` } : {} };
    },
  } as unknown as AxiosInstance;
  return { client, calls };
}

test("follows Link headers across pages and drops pull requests", async () => {
  const raw = (n: number, pr = false) => ({
    number: n,
    title: "t",
    body: null,
    html_url: "u",
    state: "open",
    user: { login: "x" },
    labels: ["bug", { name: "help" }],
    ...(pr ? { pull_request: {} } : {}),
  });
  const { client, calls } = fakeClient([
    { data: [raw(1), raw(2, true)], next: "https://api.github.com/p2" },
    { data: [raw(3)] },
  ]);
  const issues = await new GitHubAPI("t", client).getOpenIssues("o", "r");
  assert.deepEqual(issues.map((i) => i.number), [1, 3]);
  assert.deepEqual(issues[0]!.labels, ["bug", "help"]);
  assert.equal(calls.length, 2);
});

test("starred repos are paginated", async () => {
  const { client } = fakeClient([
    { data: [{ name: "a", owner: { login: "o" } }], next: "https://api.github.com/p2" },
    { data: [{ name: "b", owner: { login: "o" } }] },
  ]);
  assert.deepEqual(await new GitHubAPI("t", client).getStarredRepos(), [
    { owner: "o", name: "a" },
    { owner: "o", name: "b" },
  ]);
});
