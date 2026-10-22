# DSA Tracker Firebase setup

## Current email verification: Firebase link

The website now uses Firebase Authentication's built-in email verification link. It no longer calls the custom six-digit OTP functions in `functions/`.

- In Firebase Console, **Authentication → Templates → Email address verification**, the sender name can be `DSA Interview Problem Tracker`. Keep the default Firebase `From` address unless you own and verify a custom domain.
- You do not need Brevo, Resend, `functions/.env`, an email API key, or a Cloud Functions deployment for this verification flow.
- To try it locally, refresh the page at `localhost:3000`. Create an email/password account, open the verification link in your inbox, return to the app, and click **I clicked the link**. For an existing unverified account, sign in and use **Send verification link**.
- `firebase.json` now configures Firebase Hosting to serve `index.html` from this folder. Publish the site and the sharing rules together with `firebase deploy --only hosting,firestore:rules`.

## Recruiter profile sharing

Profile sharing is off until the user explicitly turns it on in **Your profile → Enable profile sharing**. The public page shows only the user's display name, optional About text, profile photo, and tracker progress. It never publishes the account email or sign-in methods. Anyone who receives the link can view the page; the owner can turn it off from the same profile dialog.

To enable this feature on the live site:

1. Open a terminal in this project folder. If you have not used Firebase CLI on this computer before, install it with `npm install -g firebase-tools`, then run `firebase login`.
2. Run `firebase deploy --only hosting,firestore:rules`. This publishes the website and its privacy rules; the Firebase CLI prints the live website address when it finishes. If Firebase asks you to create a Hosting site, accept the default site for this project.
3. Open that live website address, sign in, open **Your profile**, and click **Enable profile sharing**. Then click **Copy recruiter link** and send it to the recruiter.

The link must use your public website address. A `localhost` link only works on your own computer. The public page updates when the owner changes profile details or tracker progress. Anyone with the link can view the published fields, and the owner can turn sharing off from the profile dialog.

The sections below document the **older six-digit OTP implementation** and are not steps for the current website.

## Legacy: why "OTP sent" but nothing arrived

**What I verified in the code**
- The web app calls project `dsa-sheet-by-anurag`, region `us-central1`, callables `sendEmailOtp` / `verifyEmailOtp`. `functions/index.js` sets the same region, and `firebase.json` points Functions at the `functions/` folder, which is where the files are. The wiring matches.
- The backend only returned `sent: true` when Resend answered with a 2xx. So if you saw the "sent" message, **Resend accepted the request**. That is not the same as the email being delivered.
- There was no `functions/.env`, so `MAIL_FROM` has to be supplied at deploy time; the template value is a placeholder.
- The old code hid the real reason on failures (one generic "couldn't send" message), logged nothing on success, and never checked for a message id, so you couldn't tell what Resend did.

**What I can't see from here:** your Resend dashboard and the deployed function's logs. So I can't tell you which of these it was; the new logging makes it a 2-minute check:

| Likely cause | How it looks | Fix |
|---|---|---|
| **Sender is Resend's test address** (`onboarding@resend.dev`) or an unverified domain | Resend refuses with HTTP 403 ("You can only send testing emails to your own email address", or "domain is not verified"). Per Resend's docs, the `resend.dev` test domain can only deliver to the email address of your own Resend account. The new code shows a specific message and logs it. | Verify your own domain in Resend and use an address on it in `MAIL_FROM`. |
| **Accepted but not delivered** | Resend's Emails page shows the message as `bounced`, `suppressed` (recipient on the suppression list), `delivery_delayed` (retried for up to 14 hours), or only `sent`. | Fix per status (see "Check delivery status"). |
| **Delivered to spam / junk** | Status `delivered` but not in the inbox. | Check spam; make sure SPF/DKIM show as verified; use a dedicated subdomain like `mail.yourdomain.com`. |
| **Old code deployed / functions never redeployed** | Logs show nothing for `sendEmailOtp`, or the old message text. | Redeploy (steps below) and hard-refresh the site. |

## What changed in this fix
- `functions/mail.js` (new): the only place that talks to Resend. Resolves **only** on a 2xx **with a message id**; otherwise throws with a category (`test-mode`, `sender-unverified`, `bad-key`, `provider-limit`, `rejected`, `provider-down`, `failed`). Email addresses and key-looking strings are redacted from anything it reports.
- `functions/index.js`: refuses to run with an empty/placeholder `MAIL_FROM`; logs `OTP email accepted by provider` with HTTP status + **messageId**, or `OTP email was NOT sent` with category, HTTP status, Resend error name and redacted message. **Never logged:** the code, API key, password, full email addresses (only the domain), or the raw provider response. A failed send invalidates the unsent code and doesn't count toward the user's hourly/daily limits (a 10-second pause prevents hammering).
- `index.html`: shows "sent" only when the backend confirms; the wording is "The email service accepted your code…" (not a delivery promise); new clear messages for test-mode, misconfigured sender/key, busy, and rejected-address cases. The existing *Verify email* / *Send code* / *Resend code* panel is unchanged, so unverified users can always enter or resend a code.
- `functions/test/mail.test.js` (10 unit tests with a stubbed fetch: success needs an id, each error category, redaction, no key/OTP in errors) and `functions/scripts/mail-check.js` (sends one test email from your own terminal).
- `firebase.json`: test/scripts folders excluded from Functions deploys. The older OTP change did not alter rules; the current Firestore rules separately add opt-in recruiter profile sharing.

## Steps you need to do

### A. Resend dashboard
1. https://resend.com → **Domains → Add domain**. Use a domain you own (a subdomain such as `mail.yourdomain.com` is recommended). Add the DNS records Resend shows (SPF/DKIM) at your DNS provider, then wait until the domain shows **Verified**.
   - No domain? Resend can't deliver to other people without one. Buy a cheap domain, or switch providers: some (e.g. SendGrid, Brevo) offer single-sender verification; check their current docs. Only `sendMail()` in `functions/mail.js` would change.
2. **API Keys → Create API key** with *Sending access* (that's enough). Copy it once; you will paste it only into your own terminal below.

### B. Firebase Console
1. Upgrade the project to **Blaze** only when you're ready (see the box above).
2. **Authentication → Sign-in method**: Email/Password enabled (already). **Settings → Authorized domains**: your hosting domain.
3. **Storage → Get started** (default bucket) for profile pictures; confirm `storageBucket` in Project settings → General matches `index.html` (`dsa-sheet-by-anurag.firebasestorage.app` vs `.appspot.com`).

### C. Terminal (your machine, in the project folder)
```bash
npm install -g firebase-tools
firebase login
firebase use dsa-sheet-by-anurag

# 1) config (not secret)
cp functions/.env.example functions/.env
#    edit functions/.env -> MAIL_FROM="DSA Tracker <no-reply@mail.yourdomain.com>"   (a verified Resend domain)

# 2) secrets (hidden prompt; nothing is echoed or saved in the repo)
firebase functions:secrets:set RESEND_API_KEY
firebase functions:secrets:set OTP_PEPPER          # any long random string, e.g. generate with: openssl rand -hex 32

# 3) check the sender BEFORE deploying (sends one plain test email; no OTP involved)
cd functions && npm install && npm test
read -rs RESEND_API_KEY && export RESEND_API_KEY   # paste the key at the hidden prompt
MAIL_FROM="DSA Tracker <no-reply@mail.yourdomain.com>" node scripts/mail-check.js you@gmail.com
unset RESEND_API_KEY
cd ..
```
`mail-check` prints either `ACCEPTED by Resend … Message id: …` or `NOT SENT: <category> …` with the fix. If you get ACCEPTED, look the id up on https://resend.com/emails to see whether it was delivered.

```bash
# 4) deploy (you run these; nothing deploys automatically)
firebase deploy --only functions
# optional, unchanged from before:
firebase deploy --only firestore:rules
firebase deploy --only storage
```
Redeploy functions any time you change `.env` or a secret.

### D. Test on the site
Serve over http(s), hard-refresh, **Sign in → Create account** (name, email, password). You should see "The email service accepted your code…" and the email within about a minute. If instead you see an error, it names the problem (test mode, misconfigured sender/key, busy, rejected address).

## Check delivery status
- **Resend dashboard → Emails** (https://resend.com/emails): find the message (search the id from the logs, or the recipient). Statuses: `sent`, `delivered` (handed to the recipient's mail server), `delivery_delayed` (temporary problem; Resend retries up to 14 hours, then it becomes `bounced`), `bounced` (recipient server rejected it), `suppressed` (Resend didn't send because the recipient is on the suppression list), `complained` (marked as spam). The email's menu has **View log**.
- **Function logs:** Firebase Console → Functions → `sendEmailOtp` → Logs, or `firebase functions:log --only sendEmailOtp`.
  - `OTP email accepted by provider` → has `messageId` and `providerStatus`; take the id to Resend.
  - `OTP email was NOT sent` → has `kind`, `providerStatus`, `providerError`, `providerMessage`.
  - `MAIL_FROM is empty or still a placeholder` → fix `functions/.env`, redeploy.
  - `MAIL_FROM uses the resend.dev test domain` (warning) → it only reaches your own Resend account email.
- If status is `suppressed`/`bounced` for a good address, remove it from Resend's suppression list (Resend dashboard) or fix the address, then resend a code.

## Troubleshooting
| Symptom on the site | Meaning |
|---|---|
| "email service is still in test mode…" | `MAIL_FROM` uses `resend.dev`. Use a verified domain. |
| "isn't set up correctly yet…" | Sender domain unverified, wrong/inactive API key, or `MAIL_FROM` is a placeholder. Read the log line `OTP email was NOT sent` / `MAIL_FROM…`. |
| "busy or over its sending limit" | Resend daily/monthly quota or rate limit. |
| "verification service isn't deployed yet" | Functions not deployed (needs Blaze). |
| "accepted your code" but no email | Check Resend → Emails status and spam. |
| Wrong code messages | Wrong code shows attempts left; 5 wrong tries lock that code; request a new one. |

## How the OTP stays secure (unchanged)
Codes are generated server-side (cryptographic random), only an HMAC-SHA256 hash (keyed by the `OTP_PEPPER` secret) is stored in `emailOtps/{uid}` (clients can't read/write that collection), they expire in 10 minutes, allow 5 wrong guesses, enforce a 60-second resend cooldown and 5/hour + 10/day send limits. Only after the correct code does the backend mark `emailVerified = true` with the Admin SDK; the browser then refreshes its token. Until then, email/password users get no profile or synced progress (guest progress in the browser keeps working), and the Firestore/Storage rules also require a verified email for password sign-ins.

## Profile picture
Profile dialog → *Upload photo* (JPG/PNG/WebP, ≤ 5 MB, cropped to 512×512, preview + progress). Stored at `profile-images/<uid>/avatar`; URL saved to the profile `photoURL`. Needs Storage on Blaze.
