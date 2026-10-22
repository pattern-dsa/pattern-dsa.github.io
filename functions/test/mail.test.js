"use strict";
// Run with:  cd functions && npm test      (uses a stubbed fetch; sends nothing, needs no key)
const test = require("node:test");
const assert = require("node:assert/strict");
const { sendMail, MailError } = require("../mail");

const base = { apiKey: "re_SECRETKEY123456", from: "App <no-reply@mail.example.org>", to: "user@gmail.com", subject: "s", text: "t", html: "<p>t</p>" };
const reply = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });

async function failure(stub, over = {}) {
  try { await sendMail({ ...base, ...over, fetchImpl: stub }); } catch (e) { return e; }
  assert.fail("expected sendMail to throw");
}

test("2xx with a message id resolves with that id", async () => {
  const r = await sendMail({ ...base, fetchImpl: reply(200, { id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" }) });
  assert.equal(r.id, "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794");
  assert.equal(r.status, 200);
});

test("2xx WITHOUT a message id is NOT treated as sent", async () => {
  const e = await failure(reply(200, {}));
  assert.ok(e instanceof MailError);
  assert.equal(e.kind, "failed");
});

test("2xx with a non-JSON body is NOT treated as sent", async () => {
  const e = await failure(reply(200, "<html>ok</html>"));
  assert.equal(e.kind, "failed");
});

test("resend.dev test-sender restriction (403) -> test-mode, address redacted", async () => {
  const e = await failure(reply(403, { statusCode: 403, name: "validation_error", message: "You can only send testing emails to your own email address (owner@gmail.com). To send emails to other recipients, verify a domain." }));
  assert.equal(e.kind, "test-mode");
  assert.equal(e.status, 403);
  assert.ok(!e.providerMessage.includes("owner@gmail.com"));
  assert.ok(e.providerMessage.includes("[email]"));
});

test("unverified From domain (403) -> sender-unverified", async () => {
  const e = await failure(reply(403, { name: "validation_error", message: "The mail.example.org domain is not verified. Please, add and verify your domain." }));
  assert.equal(e.kind, "sender-unverified");
});

test("bad / restricted / missing key -> bad-key", async () => {
  assert.equal((await failure(reply(401, { name: "validation_error", message: "API key is invalid" }))).kind, "bad-key");
  assert.equal((await failure(reply(401, { name: "missing_api_key", message: "Missing API key" }))).kind, "bad-key");
  assert.equal((await failure(reply(403, { name: "restricted_api_key", message: "API key is not active" }))).kind, "bad-key");
});

test("429 -> provider-limit, 422 -> rejected, 5xx -> provider-down", async () => {
  assert.equal((await failure(reply(429, { name: "rate_limit_exceeded", message: "slow down" }))).kind, "provider-limit");
  assert.equal((await failure(reply(422, { name: "missing_required_field", message: "x" }))).kind, "rejected");
  assert.equal((await failure(reply(500, { name: "application_error", message: "x" }))).kind, "provider-down");
});

test("network error / timeout -> provider-down", async () => {
  const boom = async () => { throw new TypeError("fetch failed"); };
  assert.equal((await failure(boom)).kind, "provider-down");
  const timeout = async () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; };
  assert.equal((await failure(timeout)).kind, "provider-down");
});

test("API key and OTP never appear in error fields", async () => {
  const e = await failure(reply(401, { name: "validation_error", message: "bad key re_SECRETKEY123456 used" }), { text: "Your code is 424242" });
  const dump = JSON.stringify({ k: e.kind, n: e.providerName, m: e.providerMessage, msg: e.message });
  assert.ok(!dump.includes("re_SECRETKEY123456"));
  assert.ok(!dump.includes("424242"));
});

test("Authorization header carries the key and body carries the message", async () => {
  let seen;
  await sendMail({ ...base, fetchImpl: async (url, init) => { seen = { url, init }; return reply(200, { id: "x" })(); } });
  assert.equal(seen.url, "https://api.resend.com/emails");
  assert.equal(seen.init.headers.Authorization, "Bearer re_SECRETKEY123456");
  const b = JSON.parse(seen.init.body);
  assert.deepEqual(b.to, ["user@gmail.com"]);
  assert.equal(b.from, base.from);
});
