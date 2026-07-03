# alpha02 Testnet Review Findings — 2026-07-03

Scope: agent-driven end-to-end review of `https://alpha02.vaipakam.com`
(the merged #943 build) against the LIVE Base Sepolia and Arbitrum
Sepolia deployments, from the perspective of the four user roles the
flows involve. Every UI step is independently verified by reading the
chain directly (loan structs, offer records, position locks,
allowances, claims) — the UI's claims are checked against on-chain
truth, never taken at face value.

Reference material: `docs/FunctionalSpecs/WebsiteReadme.md` (the
intended-behaviour spec and test oracle), the #927 checklist, and the
deployed contracts per `contracts/deployments/{base-sepolia,arb-sepolia}/addresses.json`.

## Environment

- Driver: Playwright Chromium with an injected EIP-1193/EIP-6963 test
  wallet; signing and RPC happen outside the page (keys never enter
  the browser). One persistent browser profile per role so
  device-local state (pending markers, mode flags) behaves like a real
  returning user.
- Test wallets (dev-only, generated for this review, funded by owner):
  - Lender `0x1DAefA360ED370285f003Fa2d92DB75628088282`
  - Borrower `0xC86BB89f8ddF703c34724Cf11137498bC69F039D`
  - New Lender `0x648897f2c549956eFfF626D57fBc3E39761e6792`
  - New Borrower `0xCeF8D4D9FF706B39baF07Ff9630AE81d632e55dc`
- Assets: canonical WETH (wrapped from gas) + Circle testnet USDC for
  liquid pairs; freshly deployed `ERC20Mock` ×2 (`tUSD` 6-dec, `tCOL`
  18-dec) + `ERC4907Mock` (`tNFT`) for illiquid pairs and rentals
  (mock addresses recorded below once deployed).

## Planned coverage

1. Connect + mode gates, per role, both chains.
2. Post lending offer / borrow request (liquid pair) → cancel → repost.
3. Accept both directions → loan opens; verify loan struct + vault.
4. Repay full; partial repay (opt-in loan); add collateral; claims
   both sides.
5. Close-early (precloseDirect) — figure matches
   `calculateRepaymentAmount` at the block of submission.
6. Refinance end-to-end: post request (caps + standing approval +
   tagged offer), pending-card watch states, New Lender accepts,
   old loan closes, carry-over verified; cancel path incl. approval
   unwind.
7. Lender instant exit (`sellLoanViaBuyOffer`) into New Lender's open
   offer; payout matches the seconds-precision economics.
8. Listing form correctly withheld (#951 gate); linked-loan accepts
   blocked.
9. NFT rental cycle: list `tNFT`, rent with prepay, `userOf` set,
   fee claims, close-out.
10. Keeper trio: master switch, per-keeper bits, per-loan enable
    (using New Borrower's wallet as an approved keeper address).
11. NFT verifier verdicts: live/gone, lock rows, sanctions row,
    in-kind row; approvals manager sweep + revoke; grace/liquidity
    checking states.
12. Illiquid pair (mock assets): consent language, in-kind default
    disclosures, risk-gate preflight behaviour.

## Status

- [x] Environment egress opened for site + RPC hosts
- [x] Chain setup (Base Sepolia): mocks deployed + minted, WETH wrapped
      — `tUSD` `0x1510eb263890364dba6d0be4b6d0c376c83c8982`,
      `tCOL` `0xf2c65cd941fe681b575adc8dfc155bf612675037`,
      `tNFT` `0xe97f6f5b4b38e7f1b408ebf93024da92a275944b`
- [ ] Base Sepolia pass — **in progress**: post/accept/repay/claims
      cycle complete and wei-verified; remaining: close-early,
      close-early + refinance(post/cancel) + instant-exit all done;
      remaining: rentals, per-loan keeper toggle, and the liquid-path
      suite (blocked on oracle feeds — F-007)
- [ ] Arb Sepolia pass (lighter: connect, post/accept, repay, verifier)

## Environment notes (not website defects)

- **No oracle feeds are configured on this Base Sepolia deploy** —
  `getAssetPrice` reverts and `checkLiquidity` returns Illiquid for
  every asset including canonical WETH and Circle USDC. Every pair
  therefore runs the ILLIQUID path (explicit consent, in-kind
  default); the liquid-path surfaces (health factor numbers,
  drop-to-liquidation, HF liquidation) cannot be exercised against
  this deploy until feeds are configured on `OracleFacet`.
- The deployed site is the merged #943 build (`VITE_BUILD_HASH
  00bc2a6`) and targets the same Diamond as
  `contracts/deployments/base-sepolia/addresses.json`
  (`0xd89f…b995`), reading `https://indexer.vaipakam.com`.
- Review-harness note: the sandbox's egress gateway resets Chromium's
  own TLS handshakes, so the driver serves all page traffic through a
  Node-side bridge (Playwright request interception + undici). No
  impact on what the site sees.

## What worked (verified against chain state, not just the UI)

- **Connect**, all roles: injected EIP-6963 wallet picked up by
  ConnectKit; address renders in the header; per-role persistent
  profiles keep sessions across visits.
- **Post lending offer (Lender)**: WETH 0.005 @ 10%, 100 tCOL
  collateral (pasted address), 30 days. Review showed the
  unpriced-asset (in-kind default) warning and the grace window;
  consent required before signing; approval + `createOffer` mined and
  the created offer #7 verified field-for-field on-chain (tx
  `0x7fc0f4a9…6aa397`): creator, type Lender, `amountMax` 0.005 WETH
  with the documented `amount = 10%` partial-fill floor, 1000 bps,
  tCOL 100e18, 30d, `creatorRiskAndTermsConsent = true`, GTC.
- **NFT verifier**: `/nft/11` (offer #7's position mint) → live
  verdict, holder = Lender, "minted for an offer that hasn't become a
  loan yet" row, no sanctions row for a clean holder (and no false
  "unknown"); `/nft/999999` → the honest two-possibility gone verdict.
  All reads pure chain — works even with the indexer down.
- **Keeper permissions (Settings, advanced)**: master switch ON
  (`getKeeperAccess` true on-chain), approve keeper with two action
  bits (`getKeeperActions` = 0x18), edit → Save wrote the REPLACED
  mask exactly (0x10), Revoke emptied the list, master OFF restored a
  clean state. Every step verified by direct reads.
- **Advanced-mode reveal**: Basic hides the keeper/approvals cards;
  the Experience-level toggle reveals them; approvals card correctly
  reported "No standing approvals" for a wallet whose exact-amount
  offer approval was fully consumed.
- **Accept → loan open (Borrower)**: match list showed offer #7 once
  the indexer caught up; review re-showed the in-kind warning,
  collateral, grace; loan #5 opened and verified on-chain (parties,
  0.005 WETH @ 1000 bps, 100 tCOL, 30 d, full-term mode, both
  position NFTs minted). Principal arrived in the borrower's WALLET
  minus the 0.1% LIF (0.004995); collateral sat in the vault, which
  the Vault page reported honestly ("100 tCOL · 100 locked · 0 free",
  "Partly locked").
- **Repay (Borrower)**: the first attempt was correctly BLOCKED by the
  pre-approval balance gate ("You need more WETH") — the wallet held
  principal-minus-LIF but owed principal+interest+pad. After topping
  up, repay went through; the review stated the full-term-interest
  rule; loan #5 = Repaid on-chain.
- **Claims (both sides)**: Claim Center listed both rows once
  `LoanRepaid` was ingested; each row routes to the position page's
  claim action with the six-row receipt + confirm. Borrower received
  EXACTLY 100 tCOL back; lender received EXACTLY
  0.005040684931506849 WETH = principal + full-term interest × 0.99 —
  the 1% treasury yield-fee verified to the wei.

- **Refinance post + pending + cancel (Borrower, advanced)**: posting
  a refinance request on loan #7 succeeded end-to-end — caps written
  (enabled, 9% ceiling, expiry), standing payoff approval granted
  exactly, tagged offer #11 created, pending card live with the
  chain-time-gated cancel. Cancelling from the pending card DELETED
  the offer (zero creator on-chain) AND revoked the payoff approval
  to 0 — both verified by direct reads. (Only the lender-completes
  step is blocked — see F-006, a deploy-flag issue, not a flow bug.)
- **Close-early / precloseDirect (Borrower, advanced)**: loan #6
  (same shape as #5) closed early through the UI; the amount pulled
  matched the contract's `calculateRepaymentAmount` quote EXACTLY
  (5041095890410958 wei = principal + full-term interest); loan
  status Repaid on-chain; the review restated the full-term rule.
  The advanced loan page rendered the close-early card, the
  clickable position-NFT row, and the per-loan keeper card.

- **Instant lender exit / sellLoanViaBuyOffer (Lender, advanced)**:
  the exit picker's candidate filter was verified BOTH ways — it
  correctly EXCLUDED a near-miss offer (prepayAsset mismatch → the
  contract's own `InvalidSaleOffer`, confirmed by simulation) and
  correctly INCLUDED a fully-matching offer with its live payout
  quote ("you'd receive ~0.005 WETH now"). Completing the sale
  transferred loan #7's lender side to New Lender on-chain (new lender
  NFT #22 minted), left the loan Active with the borrower's terms
  unchanged, and paid the seller directly with nothing to claim
  after — all verified by direct reads. The `List this position for
  sale` card correctly shows the #951 withheld-listing note in
  production; the per-loan keeper card renders its empty state; and
  the illiquid-loan Health row reads "no automatic liquidation — the
  collateral transfers as-is on default."

## Post-fix observations (after the owner moved the Secrets Store
RPC entries to dRPC)

- Autonomous ingest works again: offer #8 and loan #6 were indexed
  ~3–4 minutes after mining with NO follow-up Diamond event — the
  F-004 "waits indefinitely" stall no longer reproduces. Residual
  question: on a 1-minute cron, why ~3–4 minutes? The Worker's Cron
  Events tab would say (skipped ticks vs. slow scans). Users feel
  this as: a new offer takes a few minutes to appear in the book, a
  fresh loan's detail page is empty for a few minutes after accept.
- The F-002 replica-race on accept reproduced 2-for-2 when the
  estimating RPC differed from the one that saw the approval mine,
  and disappeared when both used the same backend — confirming the
  read-your-writes hedge as the right fix. Real-world exposure:
  wallet RPC (MetaMask) vs app RPC are routinely different backends.
- dRPC free tier throttles under normal app polling (observed 429s
  breaking one post attempt and one accept estimate). Consider a
  paid tier or a fallback transport list before wider testing.

## Findings

### F-20260703-001: staging indexer is stalled — offer book, positions, claims all read a 50-hour-old snapshot

- **Severity**: blocker for the remaining review (ops/infra, not
  website code).
- **Evidence**: `indexer.vaipakam.com/offers/active?chainId=84532`
  returns offers first-seen at block 43565653 (~50 h old);
  `/offers/7` (created during this pass at block ~43655k) returns
  `not-found`; `/activity` newest event is 50 h old. The indexer
  Worker has a `* * * * *` cron, so it should track head within
  minutes — its cursor appears stuck (possible getLogs range-cap
  failure loop on the public RPC, cf. the 2000-block cap on
  `sepolia.base.org`, or a dead cron/secret).
- **User impact**: the borrower's match list says "No matching offers
  right now" while a fresh matching offer exists on-chain — an
  honest-given-data but wrong-in-fact empty book; My positions /
  Claims will similarly show stale-empty.
- **Action**: operator to check the `vaipakam-indexer` Worker (cron
  executions, D1 `indexer_cursor` row for chain 84532, RPC secret).
  The review's accept → lifecycle scenarios resume once it catches
  up.

### F-20260703-006: refinance is non-functional end-to-end — `cfgAutoRefinanceEnabled` is OFF and the frontend never checks it

- **Severity**: P1 (a headline advanced feature is dead on this
  deploy; borrower pays gas + grants a standing payoff approval for a
  request no lender can ever fund).
- **What happens**: borrower posts a refinance request on loan #7 via
  the UI — the whole flow succeeds: `setAutoRefinanceCaps` (enabled,
  9% ceiling, expiry verified on-chain), a standing payoff approval
  (exactly 5041095890410958 wei), the tagged AON offer #11
  (`refinanceTargetLoanId = 7`), and the live pending card with cancel
  affordance. New Lender then funds it through Lend → review is NOT
  wrongly blocked (linkedLoanId is 0, so my round-13 gate correctly
  leaves it acceptable), consent + Fund — and `acceptOffer` reverts
  **`AutoRefinanceDisabled` (0xe088dc81)** on every attempt (decoded
  via server-side simulation; 3/3 reproductions, so NOT the transient
  replica race).
- **Root cause (contract + config)**: `RefinanceFacet._refinanceLoanLogic`
  reverts `AutoRefinanceDisabled` when
  `currentBorrowerNftOwner != msg.sender && !cfgAutoRefinanceEnabled`.
  On the accept-chained happy path `refinanceLoanFromAccept` is
  reached via `crossFacetCall`, so `msg.sender == address(this)` (the
  diamond) — which is NEVER the borrower-NFT owner. So the
  new-lender-accepts path (the ONLY way a refinance completes)
  ALWAYS requires `cfgAutoRefinanceEnabled == true`. This deploy has
  `AdminFacet.getAutoRefinanceEnabled() == false`, so it always
  reverts. (The in-code comment "kill switch only fires on the
  keeper-driven path / borrower-NFT owner calling directly is
  exempt" describes only the EXTERNAL `refinanceLoan` entry, where a
  borrower EOA makes `msg.sender == borrower`; it does not hold for
  the accept-chained path — worth a contracts-side comment/naming
  clarification so operators know the flag is mandatory for refinance
  to work at all.)
- **Action (operator, unblocks the review)**: call
  `AdminFacet.setAutoRefinanceEnabled(true)` from the admin EOA
  (`0xF718…2030`, holds ADMIN_ROLE) on the Base Sepolia deploy. Add
  it to the deploy/post-deploy checklist alongside
  `setSanctionsOracle` — a retail deploy that leaves it false
  silently disables refinance. **DONE 2026-07-03**: owner flipped it;
  `getAutoRefinanceEnabled()` now true, and the accept then advances
  past `AutoRefinanceDisabled` to the HF gate (see F-007).
- **Action (website, product gap — fix later)**: the refinance flow
  must preflight `getAutoRefinanceEnabled()` (one cheap read, same
  pattern as the round-14 `previewOfferAcceptBlock` gate and the #951
  listing gate) and hide/disable the refinance form (or warn) when
  it's false — never let a borrower pay gas for caps + a standing
  payoff approval on a request that cannot be funded. Cross-file into
  #927's deferred/gating list.

### F-20260703-007: refinance completion needs LIQUID collateral — reverts `IlliquidLoanNoRiskMath`, and the flow doesn't preflight it

- **Severity**: environment blocker for THIS deploy; P2 website
  gating gap in general.
- **What happens (after F-006's flag flip)**: New Lender funding the
  refinance request now gets PAST `AutoRefinanceDisabled` and reverts
  `IlliquidLoanNoRiskMath` instead (decoded via server-side
  simulation of offer #12). Root cause:
  `RefinanceFacet._refinanceLoanLogic` runs an UNCONDITIONAL
  post-refinance LTV+HF gate (`RiskFacet.calculateLTV` → HF ≥ 1.5),
  which reverts `IlliquidLoanNoRiskMath` for illiquid collateral —
  unlike loan INITIATION, which has an explicit illiquid-collateral
  bypass (in-kind default + both-party consent). So a loan whose
  collateral has no oracle price CANNOT be refinanced through this
  path.
- **Why it blocks the review**: this deploy has NO oracle feeds, so
  EVERY asset (incl. WETH, USDC) classifies illiquid — there is no
  liquid pair to refinance. Refinance is therefore verified through
  everything EXCEPT the final HF gate (post, caps, payoff approval,
  tagged offer, pending card, cancel, and now the flag gate); the
  atomic-swap tail needs a liquid-collateral loan.
- **Action (operator, to finish the liquid-path suite)**: configure at
  least one Chainlink price feed on `OracleFacet` (Base Sepolia has a
  canonical ETH/USD feed) so WETH-collateral loans classify liquid.
  That unblocks refinance completion AND the health-factor /
  drop-to-liquidation / HF-liquidation surfaces (all currently
  untestable for the same reason — see the environment note).
- **Action (website, product gap — fix later)**: the refinance flow
  should preflight the loan's collateral liquidity (the app already
  reads `checkLiquidity` in the offer flow) and NOT offer refinance —
  or clearly warn — for an illiquid-collateral loan, since completion
  always reverts `IlliquidLoanNoRiskMath`. Same "don't let the
  borrower pay for an uncompletable request" pattern as F-006. (Open
  design question for contracts: SHOULD an illiquid loan be
  refinanceable with explicit consent, like it can be originated?
  If yes, the unconditional HF gate is itself the bug. Cross-ref a
  contracts issue.)

### F-20260703-002: post-write refetch can read a lagging RPC replica — UI shows pre-write state for up to a minute

- **Severity**: P3 (self-heals; confusing to a naive user).
- **Steps**: Settings → keeper master switch ON → tx mined
  (`getKeeperAccess` true immediately via direct read) — the awaited
  `keeperConfig` refetch still rendered the switch OFF and the
  just-approved keeper's entry absent for ~30–60 s; a later poll tick
  (or reload) showed the truth.
- **Cause hypothesis**: `sepolia.base.org` is load-balanced;
  `waitForTransactionReceipt` and the follow-up reads can hit
  different replicas, so the awaited invalidation caches a pre-write
  read as fresh.
- **Suggested fix (later)**: read-your-writes hedge on post-write
  refetches — retry until the read reflects a block ≥ the receipt's
  `blockNumber` (or simply retry-until-changed with a short backoff)
  in the shared write→invalidate helper.

### F-20260703-004: indexer cron is not advancing the cursor — ingest happens only in webhook-triggered bursts

- **Severity**: P1 ops (was the real mechanism behind F-001's
  user-visible staleness; persists after the RPC fix).
- **Evidence (controlled experiment)**: loan #5's repay
  (block 43658185) stayed un-ingested for 35+ minutes while the head
  advanced ~2,000 blocks — on a `* * * * *` cron it should land
  within ~1 minute. Sending one unrelated Diamond tx
  (`setKeeperAccess`, block 43658289) made BOTH events appear
  together moments later: ingest advances only when a webhook hint
  arrives, then scans up to that block and stops.
- **Impact**: any state change not followed by another Diamond event
  waits indefinitely — exactly the "repaid loan still shows active /
  claims missing" a user would report.
- **Action (operator)**: check the `vaipakam-indexer` Worker's Cron
  Events tab (invocation history + errors) — the cron trigger is
  either disabled, erroring every tick, or its tick exits without
  forwarding the head hint to the ingest DO. Webhook path is
  demonstrably healthy.

### F-20260703-005: "You need more <asset>" doesn't say how much more

- **Severity**: P3 (copy).
- **Steps**: borrower with 0.004995 WETH (principal minus LIF) tries
  to repay ~0.00504 + pad → blocked with "You need more WETH to
  continue." The user can't tell whether they're short by dust or by
  half — the gate KNOWS the shortfall; the message should state it
  (amount needed vs held), especially since every borrower who spends
  nothing still ends short by LIF + interest at repay time.

### F-20260703-003: empty offer book is indistinguishable from a stale one

- **Severity**: P3 (UX trust; depends on F-001 class of failures).
- **Observation**: with the indexer 50 h behind, the Borrow match
  list renders the normal "No matching offers right now" — the app
  has no way to know the book is stale because the API responds 200
  with old rows. A naive user reads this as "no market".
- **Suggested fix (later)**: indexer exposes its cursor freshness
  (e.g. `lastIndexedAt`/`headLag` on list responses); the app shows
  the existing stale-data style note when the lag exceeds a
  threshold. Cross-file with #927's indexer-improvements list.

---

_Maintained by the review agent during the 2026-07-03 pass; artifacts
(screenshots, RPC logs) retained in the session workspace._
