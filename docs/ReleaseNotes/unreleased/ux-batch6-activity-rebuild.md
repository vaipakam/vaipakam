### alpha02: readable Activity feed (UX batch 6)

Sixth batch from the 2026-07-11 whole-site UI/UX review
(`docs/FindingsAndFixes/Findings20260711-Alpha02UiUxReview.md`),
rebuilding the Activity feed (UX-008) and making it reachable and
resilient (UX-050) — the one screen most likely to shatter a
beginner's trust:

- **Plain-language events.** Raw contract event names no longer leak
  into the UI. Each event maps to a readable line ("Loan started",
  "Offer cancelled"), and any unmapped event is humanized without
  mangling acronyms — the old code turned `NFTMinted` into
  "Nftminted"; it now reads "NFT Minted". The cancelled/canceled
  spelling is consistent throughout.
- **One row per transaction.** A single on-chain action used to
  explode into three to six near-duplicate rows. Events are now
  grouped by transaction and shown as one row labelled by the real
  outcome, with a "+N more in this transaction" note when it stood in
  for book-keeping sub-events.
- **Substance and provenance.** Every row shows the loan or offer it
  concerns, when it happened (relative time), and a direct link to the
  transaction on the block explorer.
- **Pagination.** The feed reveals in pages instead of rendering one
  enormous scroll; a "Load older activity" button brings in more.
- **Reachable and resilient (UX-050).** The Positions page links to
  the full activity history so Basic-mode users (who don't see
  Activity in the navigation) can find it, and when the activity data
  source is degraded the page points to the always-available Positions
  view instead of dead-ending.

Per-row amounts are a follow-up (they need per-asset decimal
resolution); the loan/offer link and the explorer transaction link
carry provenance today.
