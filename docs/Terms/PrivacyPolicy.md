# Vaipakam Privacy Policy

**Version:** 5
**Effective:** 2026-08-31

## What we collect

Vaipakam is non-custodial and has no accounts, no sign-ups, and no
off-chain identity system. Given that, the data we observe about you
falls into seven narrow categories.

**On-chain activity.** Your wallet address and the transactions it
sends are public by design — every action you take on the protocol is
visible on-chain to everyone. Nothing we can do (or not do) changes
that. We do not store a separate copy of this data.

**Diagnostics — on your device only.** Two kinds of failure are
recorded: a screen that crashes, and a write action that fails. The
second is broader than sent transactions — signing and posting a
gasless offer is recorded the same way, including when it fails before
anything reaches the chain. Ordinary read, network and validation
failures are not recorded. For the failures that are, the app keeps a
record of the most recent one — the error message, the component trace
where it has one, the page you were on, and a timestamp — in your
browser's session storage. It is a single slot, not a running log of
your activity, it is not keyed to your wallet, and it is discarded when
you close the tab. It never leaves your device on its own. (One edge
case, for completeness: the app holds the newest record in memory as
well, so that a browser refusing to write to session storage — a full
quota, a locked-down profile — still has it for a support report. If a
write fails while an older record is already stored, that older one
stays until the tab closes, and a data export would show both.)

The Diagnostics drawer can build a support report: a GitHub issue,
pre-filled and opened in a new tab. **Opening it sends the report to
GitHub.** It travels inside the link, so it reaches GitHub at the
moment the form opens — whether or not you go on to submit the issue,
and whether or not you close the tab. What you control is whether an
issue is filed, not whether GitHub receives it.

The report is more than the stored error, and it is sent even when
there is no stored error at all. It always carries: the page you are
on, the network, your wallet address (shortened to `0x1234…abcd` — the
report is passed through an address shortener as it is built, covering
the wallet field and any address appearing in the page address or
error text), your
blockchain-connection status, your market-data cache status, and the
app build. When a stored error exists, its time, page, message and —
where there is one — component trace are appended.

Because the whole report has to fit in a link, a long one is trimmed to
fit: the component trace is dropped first, and if it is still too long
the error block goes too, leaving the always-carried fields above. Even
then the issue's title still contains the first 60 characters of the
error message, which is where it is put when the report is built. What
you are shown reflects that trimming: "Show full report" and "Copy
details" give you the report as it will actually be sent, so a trace
that will not travel is not displayed as though it would.

If you want to see it all first, do it before opening the link — not
after, since by then it has been sent. The drawer's own summary is
partial: it shows the first 300 characters of the error message and no
component trace, while the report carries up to 1,200 characters of
error text and up to 1,000 characters of trace. "Show full report" and
"Copy details" both give you that report in full, and both are local —
they send nothing. The same text is what a support ticket attaches if
you tick the box to include it, so there is one thing to read and it
covers every route out. Copying depends on your browser
allowing clipboard access, and where that is blocked or unavailable the
copy does not happen — but you can still read the report: "Show full
report" displays exactly what would be sent, in the app, and a refused
copy says so and opens that view for you. Reading it sends nothing, so
you can always see the full text before deciding whether to open the
report — which, as above, is what sends it.
Any wallet address is shortened to `0x1234…abcd` first. We do NOT send
your IP, user-agent, or browsing history.

**Error records on our servers — no automatic capture.** An earlier
version of the app sent a record of each UI error to a Cloudflare
Worker endpoint automatically, without your involvement. **The current
app does not.** Simply using the app creates no error record on our
servers.

Two things that does not mean. It does not mean no diagnostics ever
reach us: if you send a support ticket and tick the attach box, the
same redacted block described above travels with that ticket and is
stored alongside it — see "Support tickets", which governs it. That
path is deliberate and requires your action each time. And it does not
make the description below obsolete: it governs records captured while
automatic capture was running, and it must be accurate again before
automatic capture is ever reinstated. Where such a record exists it
carries: a per-event identifier (a random UUID, which support can use
to look the record up — it is stored with the record but is not put
into any GitHub report), the redacted wallet (`0x…abcd`), the
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
wallet in the app. One qualification, for smart-account (contract)
wallets: such a signature is verified on one network at a time, so a
single request covers the records captured on the network that
verified it. To cover the others, repeat the request on each, or email
support@vaipakam.com and we will process it for your wallet
everywhere. An ordinary wallet's signature is not network-bound and
needs no repetition. To make this possible a one-way keyed hash of
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
- **GitHub — only when you open a support report.** The Diagnostics
  drawer's report is a GitHub issue opened through a pre-filled link,
  so opening it sends GitHub the report described under "Diagnostics":
  page, network, your shortened wallet address, connection and cache
  status, app build, and the stored error if there is one. This happens
  when the form opens, not when an issue is submitted, and it happens
  only because you chose to open it. GitHub is a public issue tracker —
  anything you then submit is public.
- **Nobody else by default.** We do not sell or rent any data.
- **Legal compliance exception.** If a subpoena or equivalent legal
  order compels disclosure in a jurisdiction we operate in, we will
  comply with the narrowest possible scope.

## Your rights (GDPR, UK GDPR, CCPA)

The following rights apply regardless of your jurisdiction; several
are only meaningful to the extent we hold data about you.

- **Right to access.** Use the "Download my data" control on the app's
  Data Rights page. It exports the app's storage for that site plus the
  small amount of data belonging to the tab you run it from — a little
  is per-tab, so download from each open tab if you want the complete
  picture. It deliberately leaves out your wallet-connection state,
  which the wallet libraries keep under names of their own: an export
  is a file you can keep and forward, and wallet session material does
  not belong in one. So a connected user's export does not contain it,
  even though the erasure below does reach it. What it exports is
  browser storage — we assemble no profile of
  you on our side. Be aware though that where you have saved per-wallet
  settings, such as alert preferences or which notifications you have
  seen, your full wallet address appears in the stored key names, so
  the file does link that address to those settings. The file says so
  on its face as well. Note before you share the file: it
  is not purely a copy of storage. It also records when it was made,
  the site it was made on, and your browser's user-agent string, which
  identifies your browser and operating system. That is generated at
  export time, is never sent to us, and is included so the file is
  self-describing — but it does travel with the file if you pass it on.
- **Right to erasure.** Use the "Delete my data" control on the same
  page. It clears the app's local storage for that site, the session
  storage in the tab you run it from, and the shared `vaipakam.com`
  preference cookies (language and theme), which are not per-origin. It
  also asks any other open tabs to clear their own session storage; a
  tab that cannot hear that request — an older build, or a browser
  without the messaging feature it uses — keeps its session data until
  you close it. It DOES clear the records the wallet libraries keep in
  ordinary browser storage — which wallet you last used, and, for a
  Coinbase session started by scanning a code, that session's own
  details. It does NOT end a connection: the app stays connected until
  you reload, and a wallet that still treats this site as authorised —
  a browser extension, or a Safe the app is opened inside — reconnects
  afterwards, because that authorisation is held outside this site's
  storage. Nor does it reach a WalletConnect or Coinbase smart-wallet
  session, which those libraries keep in a separate browser database.
  Disconnect in the app, or clear site data in your browser, if ending
  the session is what you wanted.
  Three further limits, stated plainly because a control that
  overstates itself is worse than none.
  First, on-chain transactions are public and immutable — we have no
  power to erase them, and that is a wallet / chain-level question
  rather than a data-processor one. Second, the app's own local and
  session storage IS per-origin, so clearing it does not reset the
  marketing site: that site keeps its own copies of your language and
  theme and will recreate the shared cookies on your next visit there.
  Third, erasing the error-diagnostics records held on our servers is a
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
(never ticket contents) pass through Telegram. If you open a support
report from the Diagnostics drawer, that report goes to GitHub, whose
services are US-based. Encrypted backups
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
  It leaves your browser only by an action you take — opening the
  pre-filled GitHub report the Diagnostics drawer builds (which sends
  it to GitHub at that moment), or sending a support ticket with the
  attach box ticked.
- Server-side error records: the shipping app creates none — it sends
  no error records at all (see "Error records on our servers"). Any
  record that does exist, whether captured while automatic capture ran
  or by our own operators exercising the endpoint's health check, is
  pruned 90 days after its capture. A signed erasure request reaches
  the records tied to your wallet; a record captured with no wallet
  connected — including the operators' own health check — is not tied
  to anyone and waits for that 90-day prune.
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
