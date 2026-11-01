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

test("getIssuesSince starts with one small page and only reads full pages when it needs more", async () => {
  const day = (n: number) => new Date(Date.UTC(2026, 9, 31) - n * 86_400_000).toISOString();
  // Every `issueEvery`-th item is an issue; the rest are pull requests.
  const page = (count: number, issueEvery: number) =>
    Array.from({ length: count }, (_, i) => raw(1000 - i, { created_at: day(0), pull_request: i % issueEvery ? {} : undefined }));
  const since = new Date(Date.UTC(2026, 9, 1));
  const run = async (pages: Array<{ data: unknown[]; next: boolean }>) => {
    const seen: Array<number | undefined> = [];
    let call = 0;
    const client = {
      get: async (_url: string, config?: { params?: { per_page?: number } }) => {
        seen.push(config?.params?.per_page);
        const p = pages[call++]!;
        return { data: p.data, headers: p.next ? { link: '<https://api.github.com/p>; rel="next"' } : {} };
      },
    } as unknown as AxiosInstance;
    return { res: await new GitHubAPI("t", client).getIssuesSince("o", "r", since, 20), seen };
  };

  // A quiet repo: the small page already holds 20 issues, so that is the only request.
  const quiet = await run([{ data: page(30, 1), next: true }]);
  assert.deepEqual(quiet.seen, [30]);
  assert.equal(quiet.res.length, 20);

  // A pull-request-heavy repo: 30 items hold 10 issues, so it is read again in full pages.
  const heavy = await run([{ data: page(30, 3), next: true }, { data: page(100, 3), next: false }]);
  assert.deepEqual(heavy.seen, [30, 100]);
  assert.equal(heavy.res.length, 20);

  // No further pages: whatever the small page held is the answer.
  const small = await run([{ data: page(5, 1), next: false }]);
  assert.deepEqual(small.seen, [30]);
  assert.equal(small.res.length, 5);
});
