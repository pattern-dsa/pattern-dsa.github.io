"use strict";
/**
 * Thin, testable wrapper around the Resend "send email" API.
 *
 *  - Resolves ONLY when the provider accepted the message AND returned a message id.
 *  - Otherwise throws a MailError with a coarse `kind` (what to fix) plus the provider's status/name/message,
 *    with e-mail addresses and API-key-looking strings redacted.
 *  - Never receives or logs the OTP; the caller owns the message body.
 *
 * NOTE: "accepted" is not "delivered". Delivery (delivered / bounced / suppressed / delayed) is only visible in the
 * Resend dashboard (Emails page) or through webhooks.
 */

const ENDPOINT = "https://api.resend.com/emails";

class MailError extends Error {
  constructor(kind, d = {}) {
    super(`mail:${kind}`);
    this.name = "MailError";
    this.kind = kind;                          // see classify()
    this.status = d.status || 0;               // HTTP status from the provider (0 = no response)
    this.providerName = d.providerName || "";  // e.g. "validation_error"
    this.providerMessage = d.providerMessage || ""; // redacted, truncated
  }
}

/** Remove anything that could be an address or a key before it reaches logs. */
function redact(s) {
  return String(s || "")
    .replace(/[^\s<>()"',;]+@[^\s<>()"',;]+/g, "[email]")
    .replace(/\bre_[A-Za-z0-9_]{6,}/g, "[key]")
    .slice(0, 300);
}

/**
 * kind:
 *  test-mode          sender is the resend.dev test domain (delivers only to the Resend account owner)
 *  sender-unverified  the From domain isn't verified in Resend
 *  bad-key            API key missing/invalid/restricted/suspended
 *  provider-limit     provider quota or rate limit
 *  rejected           the request itself was invalid (From/To format etc.)
 *  provider-down      network error, timeout or provider 5xx
 *  failed             anything else
 */
function classify(status, name, message) {
  const m = String(message || "");
  if (status === 403 && /testing emails to your own email/i.test(m)) return "test-mode";
  if (status === 403 && /domain/i.test(m) && /(not verified|verify)/i.test(m)) return "sender-unverified";
  if (status === 401 || name === "missing_api_key" || name === "restricted_api_key" || name === "suspended_api_key" || name === "invalid_permission") return "bad-key";
  if (status === 429) return "provider-limit";
  if (status === 400 || status === 422 || (status === 403 && name === "validation_error")) return "rejected";
  if (status >= 500) return "provider-down";
  return "failed";
}

async function sendMail({ apiKey, from, to, subject, text, html, fetchImpl = fetch, endpoint = ENDPOINT, timeoutMs = 10000 }) {
  let res;
  try {
    res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${String(apiKey || "").trim()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, text, html }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new MailError("provider-down", { providerMessage: e && e.name === "TimeoutError" ? "request timed out" : "network error" });
  }

  const raw = await res.text().catch(() => "");
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch (_) { /* non-JSON body */ }

  if (!res.ok) {
    const name = (body && body.name) || "";
    const message = (body && body.message) || "";
    throw new MailError(classify(res.status, name, message), { status: res.status, providerName: name, providerMessage: redact(message) });
  }
  if (!body || typeof body.id !== "string" || !body.id) {
    throw new MailError("failed", { status: res.status, providerMessage: "success status but no message id in the response" });
  }
  return { id: body.id, status: res.status };
}

module.exports = { sendMail, MailError, classify, redact };
