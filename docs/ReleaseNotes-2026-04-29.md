# Release Notes — 2026-04-29

Functional record of everything delivered on 2026-04-29, written as
plain-English user-facing / operator-facing descriptions — no code.
Grouped by area, not by chronology. Continues from
[`ReleaseNotes-2026-04-28.md`](./ReleaseNotes-2026-04-28.md).

Coverage at a glance: a one-time **migration inside the log-index
cache reader** that backfills the rolling list of recently-accepted
offer IDs from the cached events array on hydrate, so existing
users whose browsers had already scanned past the relevant
`OfferAccepted` block under the previous code still see the market-
anchor rate-deviation badges in the Offer Book; a fresh
**production deploy** to the public Cloudflare Worker that ships
the day's bundle; a **fixed-position-Navbar clearance** on the
public Privacy and Terms pages (the top of those pages used to sit
behind the Navbar); and a series of **Buy VPFI copy cleanups** —
tighter Step 2 / Step 3 subtitles, a single user-friendly Info
callout on the Stake card explaining open staking + auto-escrow-
on-first-deposit, and removal of duplicated framing copy that
existed twice on the page.

## Market-anchor cache backfill — no rescan needed

Background: the Offer Book's market-anchor rate-deviation column
is driven off a rolling list of the last ~20 accepted offer IDs,
fed by the per-(chain, diamond) log-index cache in the user's
browser. That field was added on 2026-04-28 without bumping the
cache key version number — the call at the time was that
"incremental scans append new `OfferAccepted` events as they
arrive, so the rolling list will populate over time without
forcing a full rescan." Older caches keep working; new caches
populate the field; everyone converges.

The flaw in that reasoning surfaced when a user reported the
anchor-deviation badges working in one wallet session but not in
a parallel session on a different account. Both sessions share
the same per-(chain, diamond) cache, but the cache predates the
field — and incremental scans only re-read blocks past the cache's
`lastBlock` watermark. Any `OfferAccepted` event sitting *behind*
the watermark on a stale cache stays invisible to the rolling-list
field forever, even though the same event is already serialised
into the cache's `events` array with all the data needed to
reconstruct the field.

The cache reader now reconstructs the rolling list from the cached
`events` array on hydrate whenever the field is missing or empty.
It walks the events oldest-first, filters to `kind ===
'OfferAccepted'`, pulls each offer ID, and keeps the trailing 20
to seed the rolling list. The data was already in cache; the
reader just needed to read it.

Effect: any browser session that had a v7 cache from before the
2026-04-28 rolling-list addition now picks up the right market
anchor on next page load with zero RPC traffic and zero rescan
delay. The user-visible symptom (rate-deviation badges showing on
one session and not another, with no obvious reason) is gone.

Cache key stays at v7 — no full rescan forced. The migration is
load-bearing-on-hydrate only; once a cache has been written under
the new code path it carries the rolling list directly and the
backfill clause is a no-op.

## Privacy + Terms — Navbar clearance fix

The public Privacy Policy and Terms of Service pages share a
single stylesheet (`LegalPage.css`). The top-of-page layout used a
32 px `padding-top` on the main content block, which assumed a
non-fixed Navbar. The site Navbar is `position: fixed` at 72 px
height, so the page heading (`Vaipakam Privacy Policy` / `Vaipakam
Terms of Service`) and the version metadata line directly under it
were sitting behind the Navbar on every page load. `padding-top`
bumped to 104 px (72 px Navbar height + the original 32 px
breathing room), matching the per-page clearance pattern used by
the User Guide page.

## Buy VPFI — Step 2 / Step 3 copy cleanup

The Buy VPFI page had grown two layers of overlapping framing copy
between iterations:

- A page-top "Staking is open to anyone — you don't need an
  existing loan to participate. Depositing VPFI into your escrow
  earns the 5% APR yield, and the protocol auto-creates an escrow
  for you on first deposit." paragraph under the page subtitle.
- A long blue Info callout inside the **Step 2 — Deposit / Stake
  VPFI into your escrow** card that re-explained the same things
  in spec-document language ("Per spec, moving VPFI into escrow is
  always an explicit user action. The protocol never auto-funds
  escrow after a buy or bridge…").
- A Step 2 subtitle ("Required on every chain — including the
  canonical one. Earns 5% APR staking yield while it sits there.")
  whose first half was protocol-internals trivia for end users.
- A Step 3 subtitle that duplicated the warning rendered just
  below it inside the unstake form.

Cleanup pass:

- **Step 2 subtitle** is gone. The card title and the new Info
  callout below carry the message.
- **Step 2 Info callout** rewritten in plain second-person prose:
  *"Staking is open to everyone — you don't need a loan to
  participate. Any VPFI you deposit into your escrow earns 5% APR
  for as long as it stays there. First time staking? Your escrow
  is created for you automatically on your first deposit — no
  setup needed."* Translated across all 10 locales.
- **Step 3 subtitle** is gone. The unstake-form's existing
  discount-tier-impact warning carries the discussion.
- **Page-top open-staking paragraph** is gone — the Step 2
  callout is the single canonical home for that message.

The Step-Header component grew an `optional` flag on the subtitle
prop so the omission renders cleanly without an empty `<p>` slot.

`step2Subtitle`, `step3Subtitle`, and `openStakingNote`
translation keys were dropped from every locale file; only
`step2Info` remains in the Stake area.

## Production deploy

The full day's bundle (yesterday's TokenInfoTag, the Dashboard
"your stuff" consolidation, the VPFI Token card move with
paginated activity, the inlined ERC-20 detection pill, the lender-
self-repay guard, the illiquid risk-math custom error, and today's
cache-backfill fix) shipped to the public Cloudflare Worker
deployment. 23 new / modified static assets uploaded; 101 cached
from prior bundles unchanged.

## Documentation convention

Same as carried forward from prior files: every completed phase
gets a functional, plain-English write-up under
`docs/ReleaseNotes-…md`. No code. Function names, tables, and
exact selectors live in the codebase; this file describes
behaviour to a non-engineer reader (auditor, partner team,
regulator).
