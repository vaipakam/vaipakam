# Vaipakam Privacy Policy

**Version:** 4
**Effective:** 2026-08-30

## What we collect

Vaipakam is non-custodial and has no accounts, no sign-ups, and no
off-chain identity system. Given that, the data we observe about you
falls into seven narrow categories.

**On-chain activity.** Your wallet address and the transactions it
sends are public by design — every action you take on the protocol is
visible on-chain to everyone. Nothing we can do (or not do) changes
that. We do not store a separate copy of this data.

**Diagnostics — on your device only.** When something in the app
fails, the app keeps a record of the most recent error — the error
message, the component trace where it has one, the page you were on,
and a timestamp — in your browser's session storage. It is a single
slot, not a running log of your activity, it is not keyed to your
wallet, and it is discarded when you close the tab. It never leaves
your device on its own. If you open a support report from the
Diagnostics drawer, the app pre-fills a GitHub issue in your browser
containing exactly what the drawer showed you — page, network,
connection status, build, and that last error — with any wallet
address shortened to `0x1234…abcd` and the error text length-capped.
Whether to submit it is your choice. We do NOT send your IP,
user-agent, or browsing history.

**Error records on our servers — not currently collected.** An
earlier version of the app sent a record of each UI error to a
Cloudflare Worker endpoint. **The current app does not.** No error
record is transmitted from the app to us, so no data of this kind is
being created about you today. The description below is kept because
it governs any records created before this changed, and because it
must be accurate again before such capture is reinstated. Where such
a record exists it carries: the redacted wallet (`0x…abcd`), the
error type / name / selector and the technical error message
(truncated, and free of anything you typed), which screen / flow /
step you were in, your chain id, interface locale, theme, viewport
size, and the app version. Not recorded: full wallet address,
browser user-agent string, IP address (beyond transient
rate-limiting), localStorage contents, cookies, or any free-form
text you typed. Records are pruned after 90 days. The legal basis is
"legitimate interest" (security, fraud prevention, and improving
service reliability) under GDPR Art 6(1)(f). Your erasure control is
live regardless of the pause: you can have the error-diagnostics
records associated with your wallet erased at any time, directly and
without a support ticket, by signing an erasure request with that
wallet in the app. To make this possible a one-way keyed hash of
your wallet address is stored alongside each record; your full
address is used only momentarily to compute that hash and is never
stored. In rare cases where the law requires us to retain specific
records, automated erasure will skip them; where the law permits, we
will tell you so.

**Support tickets — only when you send one.** If you use the in-app
"Contact support" form, we store what you submit on Vaipakam's
support service: your message exactly as you typed it, the reply
email address if you chose to give one (it is optional — a ticket
works without it), the app page the report was sent from (with any
wallet addresses shortened), your chain id, and — only if you ticked
the attach box — the same redacted connection-health details the
form showed you. Wallet addresses in the page field and the health
details are shortened on our server as well, whatever the sending
app did. Each ticket gets a reference number, shown to you. Our
operators are notified via Telegram (our operations alert channel)
that a ticket arrived; that notification carries only the ticket
number and context flags (page, network, whether a reply address
and health details were included) — never your message text or
email address — so Telegram processes only that metadata. Support
tickets are deleted automatically no later than 12 months after
submission; write to
support@vaipakam.com to have a ticket's contents erased earlier (we
may keep the bare ticket number where the law requires). Like our other
off-chain operational records, tickets are included in encrypted
nightly backups (see "Data transfer") — but only in the short-cycle
nightly tier (kept 30 days), never in the long-lived monthly or
yearly archives, so a ticket's backup copies persist at most 30
days beyond its deletion. The legal basis is GDPR Art 6(1)(b) —
handling the support request you asked us to handle.

**Alert subscriptions — only if you link them.** If you connect
Telegram or Push alerts in the app, we store your wallet address,
your alert preferences, your Telegram chat id (for Telegram), and a
small per-alert delivery record (which loan, which level, when) so
you are never messaged twice about the same event. Alert messages
you subscribe to are delivered through the channel you chose —
Telegram processes those messages for Telegram alerts. Unlinking
removes the Telegram chat connection; your alert preferences and
the delivery dedupe records (no Telegram identity in either) stay,
so re-linking restores your setup — erasable on request via
support@vaipakam.com.

**Google Analytics — only with consent.** If you accept analytics
cookies in the consent banner, Google Analytics records anonymous
usage stats: page views, time on page, which features you used. We
use Google's Consent Mode v2 in Advanced mode — while you haven't
given consent, no analytics cookies fire and ad-click identifiers
(gclid, dclid) are redacted from outbound network traffic. You can
change your consent at any time via the "Cookie settings" link in
the footer.

**Essential cookies.** Session state, theme preference (light/dark),
chain selection, and similar UI housekeeping. Always on; required
for the app to work.

## What we do NOT collect

- No KYC documents, no selfies, no passport scans. Vaipakam's
  on-chain KYC tier system records only a tier number (0, 1, or 2)
  and a country code, set by authorized ops — not any underlying
  document.
- No email, no phone, no social-media handle, unless you voluntarily
  type it into a public channel we don't operate — or voluntarily
  give an optional reply email with an in-app support ticket (see
  "Support tickets" above; it is never required).
- No tracking pixels beyond Google Analytics (and only with consent).
- No advertising identifiers.

## Who we share it with

- **Google.** Only if you consent to analytics cookies, and only
  aggregated usage data — never a payload tying a wallet address to a
  person.
- **Telegram.** Two opt-in uses. If you link Telegram alerts, your
  chat id is stored and the alert messages you configured (loan,
  alert level, timing) are delivered through Telegram. If you send a
  support ticket, our operators are alerted through Telegram with
  the ticket number and context flags described above — never your
  message text or email address.
- **Backblaze.** Our off-chain operational records (server-side
  error records, alert subscriptions, support tickets) are backed up
  nightly to Backblaze B2. Archives are encrypted on our side before
  upload — Backblaze holds ciphertext only, and cannot read any of
  it.
- **Nobody else by default.** We do not sell or rent any data.
- **Legal compliance exception.** If a subpoena or equivalent legal
  order compels disclosure in a jurisdiction we operate in, we will
  comply with the narrowest possible scope.

## Your rights (GDPR, UK GDPR, CCPA)

The following rights apply regardless of your jurisdiction; several
are only meaningful to the extent we hold data about you.

- **Right to access.** Use the "Download my data" control on the app's
  Data Rights page to export what the app holds in this browser. It is
  per-origin browser storage, not a wallet-keyed profile: we do not
  assemble one.
- **Right to erasure.** Use the "Delete my data" control on the same
  page. It clears the app's browser-storage entries on this device.
  Two limits stated plainly, because a control that overstates itself
  is worse than none. On-chain transactions are public and immutable —
  we have no power to erase them, and that is a wallet / chain-level
  question rather than a data-processor one. And browser storage is
  per-origin: clearing it here does not reset the marketing site,
  which keeps its own copies of your language and theme preferences.
  Erasing the error-diagnostics records held on our servers is a
  separate, signed request — see "Error records on our servers".
- **Right to object.** You can revoke analytics consent at any moment
  via the Cookie settings footer link; no further analytics data
  will be collected from that point on.
- **Right to portability.** The export from "Download my data" is
  plain JSON, intentionally portable.

## Data transfer

The frontend is hosted on Cloudflare Pages, and our off-chain
operational records live in Cloudflare's database service. Analytics
(if consented) are processed by Google. Alert messages you opt into and support-ticket alert metadata
(never ticket contents) pass through Telegram. Encrypted backups
of the off-chain records are stored with Backblaze B2 — encrypted
before upload, so Backblaze holds only ciphertext; nightly backup
archives are kept 30 days and monthly archives 12 months, after
which they age out automatically (one archive per calendar year is
retained longer for legal-audit durability — support tickets are
excluded from the monthly and yearly archives, so a ticket's backup
copies live only in the 30-day nightly tier).
All of these providers
transfer data across borders as part of their standard operation. We
do not transfer any additional data beyond what these tools
inherently handle.

## Data retention

- Device diagnostics: the most recent error is kept in your
  browser's session storage and is discarded when you close the tab.
  It leaves your browser only if you choose to submit the pre-filled
  support report the Diagnostics drawer builds.
- Server-side error records: none are being created — the current
  app sends none (see "Error records on our servers"). Any record
  created before that changed is pruned 90 days after its capture,
  and can be erased sooner on your signed request.
- Alert subscriptions: unlinking removes the Telegram chat
  connection immediately; alert preferences and delivery dedupe
  records (which carry no Telegram identity) are kept so re-linking
  restores your setup, and can be erased on request via
  support@vaipakam.com.
- Support tickets: deleted automatically no later than 12 months
  after submission (earlier on request — see "Support tickets"
  above). Backup copies age out on the backup rotation schedule
  described under "Data transfer".
- Consent choice: kept in your browser's local storage indefinitely
  until you revoke or clear.
- Google Analytics (with consent): subject to Google's own retention,
  configurable in the Analytics property (default: 14 months).

## Changes to this Policy

We publish updates by bumping the version at the top of this document
and announcing via the protocol's Discord and X channels. We do not
require on-chain acceptance of Privacy Policy changes — the ToS is
the on-chain-signed agreement, and this Policy is a companion.

## Contact

Privacy-specific questions: via the public Discord link in the
footer. Support tickets — including early-erasure requests for a
ticket's contents: support@vaipakam.com.
