# Vaipakam Privacy Policy

**Version:** 2
**Effective:** 2026-05-16

## What we collect

Vaipakam is non-custodial and has no accounts, no sign-ups, and no
off-chain identity system. Given that, the data we observe about you
falls into five narrow categories.

**On-chain activity.** Your wallet address and the transactions it
sends are public by design — every action you take on the protocol is
visible on-chain to everyone. Nothing we can do (or not do) changes
that. We do not store a separate copy of this data.

**Diagnostics telemetry (wallet-keyed).** When you use the app, we
collect a small journey log keyed to your connected wallet address.
It contains timestamps, which screen / flow you were in, and error
messages (truncated, with wallet addresses shortened). It is stored in
your browser's local storage by default. If you open a support report
from the Diagnostics drawer, a copy is attached to that report. We do
NOT send your IP, user-agent, or browsing history.

**Server-side error capture.** Every UI error (e.g. a transaction
reverts, an oracle read fails) is recorded server-side at a
Cloudflare Worker endpoint with a per-event UUID. The record
carries: the redacted wallet (`0x…abcd`), the error type / name /
selector and the technical error message (truncated, and free of
anything you typed), which screen / flow / step you were in, your
chain id, interface locale, theme, viewport size, and the app
version. Not recorded: full wallet address,
browser user-agent string, IP address (beyond transient
rate-limiting), localStorage contents, cookies, or any free-form
text you typed. The same UUID surfaces in any GitHub issue you
choose to file, so support can cross-reference an external report
against a real session on our side. Records are pruned after 90
days. The legal basis is "legitimate interest" (security, fraud
prevention, and improving service reliability) under GDPR Art
6(1)(f). You can have the error-diagnostics records associated with
your wallet erased at any time, directly and without a support
ticket, by signing an erasure request with that wallet in the app.
To make this possible we store a one-way keyed hash of your wallet
address alongside each record; your full address is used only
momentarily to compute that hash and is never stored. In rare cases
where the law requires us to retain specific records, automated
erasure will skip them; where the law permits, we will tell you so.

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
submission (most sooner, once resolved); write to the contact
address below to have a ticket's contents erased earlier (we may
keep the bare ticket number where the law requires). Like our other
off-chain operational records, tickets are included in encrypted
nightly backups (see "Data transfer"); backup copies age out on the
backup rotation schedule. The legal basis is GDPR Art 6(1)(b) —
handling the support request you asked us to handle.

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
- **Telegram.** Only if you send a support ticket: our operators are
  alerted through Telegram with the ticket number and context flags
  described above — never your message text or email address.
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

- **Right to access.** Use the "Download my data" button in the app's
  Diagnostics drawer to export everything the frontend has collected
  about your session, keyed to your wallet.
- **Right to erasure.** Use the "Delete my data" button in the
  Diagnostics drawer. It clears every wallet-keyed journey-log entry
  and local-storage artefact on your device. Note: on-chain
  transactions are public and immutable — we have no power to erase
  them. If you want on-chain deletion, that's a wallet / chain-level
  question, not a data-processor one.
- **Right to object.** You can revoke analytics consent at any moment
  via the Cookie settings footer link; no further analytics data
  will be collected from that point on.
- **Right to portability.** The export from "Download my data" is
  plain JSON, intentionally portable.

## Data transfer

The frontend is hosted on Cloudflare Pages, and our off-chain
operational records live in Cloudflare's database service. Analytics
(if consented) are processed by Google. Support-ticket alert
metadata (never contents) passes through Telegram. Encrypted backups
of the off-chain records are stored with Backblaze B2 — encrypted
before upload, so Backblaze holds only ciphertext; nightly backup
archives are kept 30 days and monthly archives 12 months, after
which they age out automatically (one archive per calendar year is
retained longer for legal-audit durability). All of these providers
transfer data across borders as part of their standard operation. We
do not transfer any additional data beyond what these tools
inherently handle.

## Data retention

- Journey-log telemetry: kept in your browser's local storage. A
  slice leaves your browser only when you explicitly attach it to a
  support report. (Separately, a single error record — not a
  journey-log slice — is sent server-side on each error; see
  "Server-side error capture".)
- Server-side error records: pruned 90 days after capture.
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

Privacy-specific questions: via the public Discord link in the footer.
