import assert from "node:assert/strict";
import { test } from "node:test";
import type { AxiosInstance } from "axios";
import { GitHubAPI } from "../github/api.js";

type Page = { data: unknown; next?: string };

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

const raw = (n: number, extra: object = {}) => ({
  number: n,
  title: "t",
  body: null,
  html_url: "u",
  state: "open",
  comments: 2,
  reactions: { total_count: 4 },
  user: { login: "x", type: "User" },
  labels: ["bug", { name: "help" }],
  ...extra,
});

test("seeding asks for only the newest item and returns its number", async () => {
  const { client, calls } = fakeClient([{ data: [{ number: 57 }] }]);
  const res = await new GitHubAPI("t", client).getNewIssues("o", "r", null);
  assert.deepEqual(res, { issues: [], highWater: 57 });
  assert.equal(calls.length, 1);
});

test("returns only issues above the mark, drops PRs, and tracks the high-water mark", async () => {
  const { client } = fakeClient([
    { data: [raw(9), raw(8, { pull_request: {} }), raw(7)], next: "https://api.github.com/p2" },
    { data: [raw(5)] },
  ]);
  const res = await new GitHubAPI("t", client).getNewIssues("o", "r", 6);
  assert.deepEqual(res.issues.map((i) => i.number), [9, 7]);
  assert.equal(res.highWater, 9);
  assert.deepEqual(res.issues[0]!.labels, ["bug", "help"]);
  assert.equal(res.issues[0]!.reactions, 4);
});

test("stops paging once a page reaches an already-known number", async () => {
  const { client, calls } = fakeClient([
    { data: [raw(12), raw(10)], next: "https://api.github.com/p2" },
    { data: [raw(1)] },
  ]);
  await new GitHubAPI("t", client).getNewIssues("o", "r", 10);
  assert.equal(calls.length, 1);
});

test("flags bot authors", async () => {
  const { client } = fakeClient([
    { data: [raw(3, { user: { login: "dependabot[bot]", type: "Bot" } })] },
  ]);
  const res = await new GitHubAPI("t", client).getNewIssues("o", "r", 1);
  assert.equal(res.issues[0]!.isBot, true);
});

test("getFile decodes base64 content and maps 404 to null", async () => {
  const content = Buffer.from('{"name":"x"}').toString("base64");
  const ok = fakeClient([{ data: { type: "file", encoding: "base64", content } }]);
  assert.equal(await new GitHubAPI("t", ok.client).getFile("o", "r", "package.json"), '{"name":"x"}');

  const missing = {
    get: async () => {
      throw Object.assign(new Error("not found"), { isAxiosError: true, response: { status: 404, headers: {} } });
    },
  } as unknown as AxiosInstance;
  assert.equal(await new GitHubAPI("t", missing).getFile("o", "r", "package.json"), null);
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

test("a connection cut while the body was arriving is retried, not reported as an HTTP 200 failure", async () => {
  let n = 0;
  const cut = Object.assign(new Error("aborted"), { isAxiosError: true, response: { status: 200, headers: {}, data: undefined } });
  const client = {
    get: async () => {
      if (n++ === 0) throw cut;
      return { data: [{ number: 5 }], headers: {} };
    },
  } as unknown as AxiosInstance;
  const res = await new GitHubAPI("t", client).getNewIssues("o", "r", null);
  assert.equal(res.highWater, 5);
  assert.equal(n, 2);
});
