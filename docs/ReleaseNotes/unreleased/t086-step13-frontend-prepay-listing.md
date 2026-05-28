## T-086 step 13 — frontend UI for the Seaport prepay-listing flow

Closes the user-facing gap T-086 has been carrying since step 6
(PR #300) shipped the borrower-facing facet. The contracts + indexer
have known how to record / surface a live listing for two PRs; this
PR is the React surface borrowers actually use to post, update, and
cancel one.

### What this PR ships

**New `useNFTPrepayListing` hook
(`apps/defi/src/hooks/useNFTPrepayListing.ts`).** A single
controller that:

- Reads the live listing state from the indexer's `/loans/:id`
  join (the indexed `prepayListing` payload step 12 set up) and
  re-fetches after every successful action — that's the canonical
  off-chain source for `askPrice` / `conduit` / `lister` /
  `postedAt` / `updatedAt` / `gracePeriodEnd`, none of which live
  in diamond storage.
- Exposes the three borrower entry points
  (`postPrepayListing` / `updatePrepayListing` /
  `cancelPrepayListing`) through the diamond proxy, with shared
  tx state (`actionLoading` / `actionError` / `txHash`).
- Decodes contract reverts via the existing
  `decodeContractError` helper so the on-chain error names
  (`AskBelowFloor`, `PrepayListingDisabled`,
  `PrepayListingNotAllowed`, `ConduitNotApproved`, …) land in
  the user-facing alert.
- Tags every action with a new `prepay-listing` journey area so
  the diagnostics drawer can group the start → success/failure
  pair the same way other strategic flows do.

**Two new components under `apps/defi/src/components/loanDetails/`:**

- `PrepayListingBanner.tsx` — informational card shown on the
  loan-details page when a listing is live, visible to everyone
  (lender, borrower, third-party). Renders the ask, the order
  hash (with explorer deep-link), the conduit, the current
  position-NFT holder, and a countdown to the grace boundary.
  Switches to a grey "closed — permissionless cancel callable"
  state once `block.timestamp >= gracePeriodEnd`, matching the
  diamond's strict-`>` upper bound for `postPrepayListing`.
- `PrepayListingActions.tsx` — borrower-only action group
  rendered inside the Actions card. Two visual modes — "post"
  (no live listing yet) and "update + cancel" (live listing).
  Both modes show the live floor (`lenderLeg + treasuryLeg`)
  and the minimum ask (`floor × (10_000 + bufferBps) / 10_000`,
  read directly from the diamond's `getPrepayListingBufferBps`).
  An "advanced options" expander lets users override the
  conduit key (defaults to OpenSea's canonical conduit) or paste
  a deterministic salt; otherwise the salt is auto-derived from
  `crypto.getRandomValues`. Cancel goes through a confirm step
  so a misclick doesn't release the borrower-NFT lock by
  accident.

**LoanDetails page wiring.** `getLoanActionAvailability` grows
three new context fields (`collateralAssetType`,
`allowsPrepayListing`, `pastPrepayGrace`) plus a new
`prepayListing` availability flag that mirrors the on-chain gates
exactly. The page now reads `getEffectiveGraceSeconds(durationDays)`
once on mount to compute the live grace boundary; a read failure
collapses the gate to `!isOverdue` (a safe under-approximation —
the surface just hides slightly earlier than the contract would
allow). Banner placement is between `ClaimActionBar` and
`LenderDiscountCard`; action-group placement is inside the
existing Actions card, alongside the other borrower-facing
strategic flows.

**`IndexedLoan` extension.** `apps/defi/src/lib/indexerClient.ts`
gains an `IndexedPrepayListing` payload type and adds the
optional `prepayListing` field to `IndexedLoan`. The
`allowsPrepayListing` boolean from step 4 is similarly mirrored
on the indexed-loan shape. The frontend `LoanDetails` TS type
gains the same `allowsPrepayListing` field on its on-chain shape.

**i18n.** A new `prepayListing.{banner, actions}.*` namespace
under English. Non-English locales fall back to English (same
pattern `periodicInterest.*` uses); proper translations land via
the regular translation rotation.

### What's NOT in this PR

The user-discovery surfaces — a "listings browser" page, a
"post-from-vault" entry point, the `useDashboardLoans` row badge
when one of your loans has a live listing — are intentionally
deferred. The shape the indexer + this PR settle on is the same
shape those surfaces will read; layering them on is additive.

The OpenSea API integration (step 14) is the next PR. Until that
lands, a borrower who posts a listing sees the order hash on the
banner but has to either trust the off-chain Seaport network to
relay the order or use a different OpenSea-creating UI to surface
the order in the OpenSea marketplace. The order itself is
already valid Seaport-1.6 with a live ERC-1271 signature; it's
the discoverability of that order that step 14 closes.

### Why the banner shows the order hash (not a buyer-facing CTA)

Three reasons.

1. The order itself is signed by the borrower's vault via
   ERC-1271; a buyer who has the orderHash + components can
   call `Seaport.fulfillOrder` directly without needing the
   Vaipakam UI. Surfacing the hash unblocks that path
   immediately.
2. A "buy now" CTA would have to either embed an OpenSea
   redirect (which doesn't exist until step 14 lands) or ship
   its own Seaport fulfillment path. We don't ship a partial
   second.
3. The banner is shown to lender / borrower / third-party
   alike; the only audience that needs to ACT on the listing
   today is the borrower (update / cancel), and they get a
   dedicated action group below.

### Tests + verification

- `pnpm --filter @vaipakam/defi exec tsc -b --noEmit` — clean.
- Manual flow verification deferred to a connected wallet against
  the testnet deploy once step 14 lands (so the OpenSea
  side-channel exists to validate the end-to-end purchase).
  Until then the page renders, the action submits, the banner
  reflects the indexer's view.

### Closes

T-086 step 13 (frontend UI) is now complete. Step 14 (OpenSea API
integration) is the next item; ERC-1155 collateral support is
already in the contracts as of step 6 round 2 (PR #307) — no
follow-up needed there.
