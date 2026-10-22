"use strict";
/**
 * Email OTP verification for email/password sign-ups.
 *
 *  sendEmailOtp   (callable, signed-in password user)  -> creates a 6-digit code, stores ONLY its HMAC hash, emails it.
 *  verifyEmailOtp (callable, signed-in password user)  -> checks the code; on success sets emailVerified=true via Admin SDK.
 *
 * Codes are generated and checked only here. Secrets (RESEND_API_KEY, OTP_PEPPER) live in Secret Manager.
 * The Firestore collection `emailOtps` is never readable/writable by clients (see firestore.rules); only this code
 * (Admin SDK) touches it.
 *
 * "sent: true" is returned ONLY after the email provider accepted the message and returned a message id.
 * Accepted is not delivered: check delivery in the Resend dashboard (Emails page) using the messageId in the logs.
 */
const crypto = require("crypto");
const admin = require("firebase-admin");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineSecret, defineString } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { sendMail, MailError } = require("./mail");

admin.initializeApp();
const db = admin.firestore();

// Must match the region the web app calls (index.html uses "us-central1").
setGlobalOptions({ region: "us-central1", maxInstances: 5 });

const RESEND_API_KEY = defineSecret("RESEND_API_KEY"); // email provider API key
const OTP_PEPPER = defineSecret("OTP_PEPPER");         // random server-side key used to HMAC codes
const MAIL_FROM = defineString("MAIL_FROM");           // e.g. "DSA Tracker <no-reply@mail.yourdomain.com>"
const APP_NAME = defineString("APP_NAME", { default: "DSA Interview Problem Tracker" });

const CODE_TTL_MS = 10 * 60 * 1000;     // codes expire after 10 minutes
const MAX_ATTEMPTS = 5;                 // wrong guesses allowed per code
const RESEND_COOLDOWN_MS = 60 * 1000;   // minimum gap between successful sends
const FAIL_COOLDOWN_MS = 10 * 1000;     // short pause after a failed send (stops hammering the provider)
const MAX_SENDS_PER_HOUR = 5;
const MAX_SENDS_PER_DAY = 10;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const otpRef = (uid) => db.collection("emailOtps").doc(uid);

function hashCode(uid, code) {
  return crypto.createHmac("sha256", OTP_PEPPER.value().trim()).update(`${uid}:${code}`).digest("hex");
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const domainOf = (addr) => String(addr || "").split("@")[1] || "";
const senderAddress = (from) => { const m = /<([^>]+)>/.exec(from); return (m ? m[1] : from).trim(); };

// Provider problem -> reason code the web app turns into a message.
const CLIENT_REASON = {
  "test-mode": "mail-test-mode",
  "sender-unverified": "mail-misconfigured",
  "bad-key": "mail-misconfigured",
  "provider-limit": "mail-busy",
  rejected: "mail-rejected",
  "provider-down": "send-failed",
  failed: "send-failed",
};

/** Loads the caller's Auth record and checks they are an email/password user. */
async function loadCaller(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Please sign in first.", { reason: "unauthenticated" });
  const rec = await admin.auth().getUser(request.auth.uid);
  if (!rec.email || !rec.providerData.some((p) => p.providerId === "password")) {
    throw new HttpsError("failed-precondition", "Email codes are only used for email/password accounts.", { reason: "unsupported" });
  }
  return rec;
}

exports.sendEmailOtp = onCall({ secrets: [RESEND_API_KEY, OTP_PEPPER] }, async (request) => {
  const rec = await loadCaller(request);
  if (rec.emailVerified) throw new HttpsError("failed-precondition", "Email already verified.", { reason: "already-verified" });

  const uid = rec.uid;
  const now = Date.now();

  // Refuse early (before creating a code) if the sender isn't configured with a real value.
  const from = String(MAIL_FROM.value() || "").trim();
  const fromAddr = senderAddress(from);
  if (!from || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(fromAddr) || /your-verified-domain|@example\./i.test(fromAddr)) {
    logger.error("MAIL_FROM is empty or still a placeholder. Set it in functions/.env and redeploy.", { uid });
    throw new HttpsError("failed-precondition", "Email sender is not configured.", { reason: "mail-misconfigured" });
  }
  const testSender = /@resend\.dev$/i.test(fromAddr);
  if (testSender) {
    logger.warn("MAIL_FROM uses the resend.dev test domain: Resend only delivers these to the Resend account owner's own address.", { uid });
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0"); // uniform 000000–999999
  const codeHash = hashCode(uid, code);

  const outcome = await db.runTransaction(async (tx) => {
    const snap = await tx.get(otpRef(uid));
    const d = snap.exists ? snap.data() : {};
    const sends = (d.sends || []).filter((t) => now - t < DAY);

    const failWait = FAIL_COOLDOWN_MS - (now - (d.lastFailAt || 0));
    if (failWait > 0) return { blocked: "cooldown", retryAfter: Math.ceil(failWait / 1000) };

    const last = sends.length ? Math.max(...sends) : 0;
    if (now - last < RESEND_COOLDOWN_MS) {
      return { blocked: "cooldown", retryAfter: Math.ceil((RESEND_COOLDOWN_MS - (now - last)) / 1000) };
    }
    const inHour = sends.filter((t) => now - t < HOUR);
    if (inHour.length >= MAX_SENDS_PER_HOUR) {
      return { blocked: "too-many-sends", retryAfter: Math.ceil((HOUR - (now - Math.min(...inHour))) / 1000) };
    }
    if (sends.length >= MAX_SENDS_PER_DAY) {
      return { blocked: "too-many-sends", retryAfter: Math.ceil((DAY - (now - Math.min(...sends))) / 1000) };
    }
    // A new code replaces any previous one and resets the attempt counter.
    tx.set(otpRef(uid), { email: rec.email, codeHash, expiresAt: now + CODE_TTL_MS, attempts: 0, sends: [...sends, now] });
    return { ok: true, sendsBefore: sends };
  });

  if (outcome.blocked) {
    const msg = outcome.blocked === "cooldown" ? "Please wait before requesting another code." : "Too many codes requested. Try again later.";
    throw new HttpsError("resource-exhausted", msg, { reason: outcome.blocked, retryAfter: outcome.retryAfter });
  }

  const app = APP_NAME.value();
  const logCtx = { uid, toDomain: domainOf(rec.email), fromDomain: domainOf(fromAddr), testSender };
  try {
    const sent = await sendMail({
      apiKey: RESEND_API_KEY.value(),
      from,
      to: rec.email,
      subject: `${code} is your ${app} verification code`,
      text: `Your verification code is ${code}.\n\nIt expires in 10 minutes. If you didn't create an account, you can ignore this email.`,
      html:
        `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:420px;margin:0 auto;padding:24px">` +
        `<h2 style="margin:0 0 12px">${esc(app)}</h2><p>Your verification code is:</p>` +
        `<p style="font-size:32px;letter-spacing:6px;font-weight:700;margin:12px 0">${code}</p>` +
        `<p style="color:#555">It expires in 10 minutes. If you didn't create an account, you can ignore this email.</p></div>`,
    });
    // Only now do we claim success. Look this id up in the Resend dashboard (Emails) to see delivered / bounced / suppressed.
    logger.info("OTP email accepted by provider", { ...logCtx, providerStatus: sent.status, messageId: sent.id });
    return { sent: true, expiresInSeconds: CODE_TTL_MS / 1000, cooldownSeconds: RESEND_COOLDOWN_MS / 1000, messageId: sent.id };
  } catch (err) {
    const known = err instanceof MailError;
    const kind = known ? err.kind : "failed";
    // Safe diagnostics only: never the code, API key, password, or raw provider body.
    logger.error("OTP email was NOT sent", {
      ...logCtx,
      kind,
      providerStatus: known ? err.status : 0,
      providerError: known ? err.providerName : "",
      providerMessage: known ? err.providerMessage : `unexpected ${err && err.name}`,
    });
    // Invalidate the unsent code; failures don't count against the user's hourly/daily limits.
    await otpRef(uid)
      .set({ email: rec.email, codeHash: admin.firestore.FieldValue.delete(), expiresAt: 0, attempts: 0, sends: outcome.sendsBefore, lastFailAt: Date.now() }, { merge: true })
      .catch(() => {});
    throw new HttpsError("unavailable", "We couldn't send the email.", { reason: CLIENT_REASON[kind] || "send-failed" });
  }
});

exports.verifyEmailOtp = onCall({ secrets: [OTP_PEPPER] }, async (request) => {
  const rec = await loadCaller(request);
  if (rec.emailVerified) return { verified: true };

  const code = request.data && request.data.code;
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
    throw new HttpsError("invalid-argument", "Enter the 6-digit code.", { reason: "bad-format" });
  }

  const uid = rec.uid;
  const now = Date.now();
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(otpRef(uid));
    const d = snap.exists ? snap.data() : null;
    if (!d || !d.codeHash || d.email !== rec.email) return { r: "no-code" };
    if (now > d.expiresAt) {
      tx.update(otpRef(uid), { codeHash: admin.firestore.FieldValue.delete(), expiresAt: 0 });
      return { r: "expired" };
    }
    if ((d.attempts || 0) >= MAX_ATTEMPTS) return { r: "locked" };

    const expected = Buffer.from(d.codeHash, "hex");
    const actual = Buffer.from(hashCode(uid, code), "hex");
    const match = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    if (!match) {
      const attempts = (d.attempts || 0) + 1;
      tx.update(otpRef(uid), { attempts });
      return { r: "invalid", remaining: Math.max(0, MAX_ATTEMPTS - attempts) };
    }
    return { r: "ok" };
  });

  if (result.r === "no-code") throw new HttpsError("failed-precondition", "No active code.", { reason: "no-code" });
  if (result.r === "expired") throw new HttpsError("deadline-exceeded", "Code expired.", { reason: "expired" });
  if (result.r === "locked") throw new HttpsError("resource-exhausted", "Too many incorrect attempts.", { reason: "locked" });
  if (result.r === "invalid") throw new HttpsError("permission-denied", "Incorrect code.", { reason: "invalid-code", remaining: result.remaining });

  // Correct code: mark verified with the Admin SDK, then burn the code.
  await admin.auth().updateUser(uid, { emailVerified: true });
  await otpRef(uid).delete().catch(() => {});
  logger.info("Email verified via OTP", { uid });
  return { verified: true };
});
