#!/usr/bin/env node
"use strict";
/**
 * Sends ONE plain test email through the same code path the Cloud Function uses, so you can check your Resend
 * key + sender domain from your own terminal, without deploying and without pasting anything into a chat.
 *
 *   read -rs RESEND_API_KEY && export RESEND_API_KEY        # type/paste the key at the hidden prompt
 *   MAIL_FROM="DSA Tracker <no-reply@mail.yourdomain.com>" node scripts/mail-check.js you@example.com
 *
 * It prints the provider status and message id (safe to share). It never prints the key, and it sends no OTP.
 */
const { sendMail, MailError } = require("../mail");

(async () => {
  const to = process.argv[2];
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;
  if (!to || !apiKey || !from) {
    console.error('Usage: RESEND_API_KEY=... MAIL_FROM="Name <addr@verified-domain>" node scripts/mail-check.js recipient@example.com');
    process.exit(2);
  }
  if (/@resend\.dev>?$/i.test(from.trim())) {
    console.warn("Note: resend.dev is Resend's test sender. It only delivers to the email address of your own Resend account.");
  }
  try {
    const r = await sendMail({
      apiKey, from, to,
      subject: "DSA tracker: delivery test",
      text: "This is a test message from your DSA tracker setup. No action needed.",
      html: "<p>This is a test message from your DSA tracker setup. No action needed.</p>",
    });
    console.log(`ACCEPTED by Resend (HTTP ${r.status}). Message id: ${r.id}`);
    console.log("Accepted is not delivered: open https://resend.com/emails and find this id to see delivered / bounced / suppressed.");
  } catch (e) {
    if (e instanceof MailError) {
      console.error(`NOT SENT: ${e.kind} (HTTP ${e.status || "no response"}) ${e.providerName} ${e.providerMessage}`.trim());
      const hint = {
        "test-mode": "Use a From address on a domain you verified in Resend (Domains page), not resend.dev.",
        "sender-unverified": "The From domain isn't verified in Resend yet: add the DNS records and wait for 'Verified'.",
        "bad-key": "The API key is wrong, deleted, or not active. Create a new key (Sending access is enough).",
        "provider-limit": "Provider rate/quota limit reached.",
        rejected: "Resend rejected the request fields; check the From format: Name <addr@domain>.",
        "provider-down": "Network problem or Resend outage; retry.",
      }[e.kind];
      if (hint) console.error("Fix: " + hint);
    } else {
      console.error("Unexpected error:", e && e.name);
    }
    process.exit(1);
  }
})();
