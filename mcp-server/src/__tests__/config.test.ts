import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../config.js";

const base = {
  GITHUB_TOKEN: "g",
  GOOGLE_API_KEY: "k",
  SMTP_USER: "u@x.com",
  SMTP_PASS: "p",
  MAIL_TO: "a@x.com, b@x.com",
};

test("applies defaults and splits recipients", () => {
  const c = loadConfig(base);
  assert.deepEqual(c.mailTo, ["a@x.com", "b@x.com"]);
  assert.equal(c.pollIntervalMs, 1_800_000);
  assert.equal(c.smtp.secure, true);
});

test("reports all missing vars at once", () => {
  assert.throws(
    () => loadConfig({}),
    /GITHUB_TOKEN.*GOOGLE_API_KEY.*SMTP_USER.*SMTP_PASS.*MAIL_TO/s,
  );
});

test("rejects a too-small interval", () => {
  assert.throws(() => loadConfig({ ...base, WATCH_INTERVAL: "100" }), /WATCH_INTERVAL/);
});
