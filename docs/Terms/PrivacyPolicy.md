# Vaipakam Privacy Policy

**Version:** 1
**Effective:** 2026-04-24

## What we collect

Vaipakam is non-custodial and has no accounts, no sign-ups, and no
off-chain identity system. Given that, the data we observe about you
falls into four narrow categories.

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
  type it into a public channel we don't operate.
- No tracking pixels beyond Google Analytics (and only with consent).
- No advertising identifiers.

## Who we share it with

- **Google.** Only if you consent to analytics cookies, and only
  aggregated usage data — never a payload tying a wallet address to a
  person.
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

The frontend is hosted on Cloudflare Pages. Analytics (if consented)
are processed by Google. Both transfer data across borders as part of
their standard operation. We do not transfer any additional data
beyond what these tools inherently handle.

## Data retention

- Journey-log telemetry: kept in your browser only, never uploaded
  unless you explicitly attach it to a support report.
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
