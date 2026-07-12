### alpha02: dead-ends removed, product made discoverable (UX batch 4)

Fourth batch from the 2026-07-11 whole-site UI/UX review
(`docs/FindingsAndFixes/Findings20260711-Alpha02UiUxReview.md`),
covering UX-010, UX-011, UX-023, UX-024, UX-026 and UX-032 — every
"now what?" moment gets a next step, and the parts of the product
that existed but couldn't be found are now findable:

- **Empty wallets aren't stuck (UX-010).** On a test network with
  seeded faucet assets, a failing "enough balance" check in any
  guided flow now carries a "Get test assets" link straight to the
  faucet.
- **The product is discoverable (UX-011).** The Basic/Advanced switch
  now lives with the navigation — sidebar footer on desktop, the More
  sheet on phones — instead of only inside Settings. The phone tab
  bar's fifth tab is a real "More" menu: a bottom sheet listing every
  destination without a tab of its own (NFT Rental, Claims, vault,
  faucet, Offer Book, Rate Desk, VPFI, Activity, NFT verifier,
  Settings, Help) plus the mode switch, instead of an alias that
  dumped users on the Settings page.
- **Empty states point forward (UX-023).** An empty vault links to
  the faucet (testnets) or Home; an empty Claim Center explains where
  claims come from and links to Positions; an empty rental market
  points at the list-your-NFT path; a successful faucet mint offers
  "Borrow against it / Lend it out" as the next hop.
- **Positions shows what needs you (UX-024).** Loans group into
  "Needs your attention" / "Active loans" / "Ended loans", where the
  attention group is confirmed on-chain (the same claim check the
  Claim Center runs) and its rows carry an explicit "Claim waiting"
  chip. If that check can't run, the list quietly degrades to
  Active/Ended — it never guesses.
- **Power surfaces orient beginners (UX-026).** A Basic-mode user
  landing on the Offer Book or Rate Desk by URL sees a dismissible
  note naming the surface, linking back to the guided flows, and
  offering to enable Advanced mode.
- **The NFT verifier is findable (UX-032).** It now appears in the
  navigation instead of being reachable only by deep link.
- Follow-up from the batch-3 live review: a visitor viewing a loan
  they're not part of now gets neutral "if nothing happens" wording
  instead of being addressed as the lender.
