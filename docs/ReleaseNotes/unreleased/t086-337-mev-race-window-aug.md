## Thread — T-086 Block C MEV / race-window note in Advanced User Guide (PR #<n>)

Closes #337.

T-086 Block C (PR #328, merged 2026-06-03) shipped pragmatic English-
auction matching against OpenSea Offers with a documented v1
trade-off: a race window between the borrower's price-rotation tx
(`updatePrepayListing`) and the bidder's settlement tx
(`Seaport.fulfillOrder`) during which any third-party buyer can
snipe the rotated listing. The dapp's `RaceWindowModal` already
spells this out at click time, but a sophisticated user reading the
modal too quickly had no durable reference to come back to.

**This thread closes that gap on the documentation side.** A new
"Matching OpenSea offers on a prepay listing" section was added to
the Advanced User Guide under the Loan Details chapter
(`apps/www/src/content/userguide/Advanced.en.md`, anchor
`#loan-details.opensea-offers`). The section explains what the
panel does, what the race window actually is, what the user can do
to mitigate it (notify the bidder out-of-band before clicking
Match; avoid matching at desperate prices that leave the buffer
thin; cancel the listing if the bidder goes quiet), and what the v2
atomic-match path will fix structurally (forward-link to Issue
#333). Plain English at sophisticated-user altitude — deeper than
the modal, shallower than the §15.3 design doc.

The dapp's `RaceWindowModal` now carries a "Learn more about the
race window" link that points at the new AUG section via the
existing `marketingUrl` helper (resolves to `https://vaipakam.com`
in prod, respects the `VITE_MARKETING_URL` dev override so local
dev links to the local www dev server). The link opens in a new
tab so the borrower's pending Match decision stays alive in the
current tab.

The non-English locales (`Advanced.{zh,ko,hi,ta,fr,de,ja,ar,es}.md`)
are intentionally left to a follow-up batch — landing the English
source first is the standard pattern for this repo (same shape as
EC-004's risk-disclosure translations). Non-en readers see the
existing localised sections; the new section is missing from those
files until the translation pass lands.

No code or contract changes; docs-only thread plus the one-line
modal link.
