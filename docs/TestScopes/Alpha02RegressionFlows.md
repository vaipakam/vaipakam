# alpha02 Regression Flows — the testnet-verified flow-path inventory

Every flow path below was **actually driven against a live deployment**
of apps/alpha02 (Base Sepolia, Diamond `0xd89f…b995`) during the
2026-06/07 review campaigns (PRs #887, #943, #982, #991), using four
funded dev wallets and a Playwright harness with an injected wallet.
This is the regression baseline: a change to apps/alpha02 (or a facet
it reads) should re-drive the flows whose surface it touches, and a
pre-deploy pass should re-drive all of them.

Two companions:

- `docs/FunctionalSpecs/WebsiteReadme.md` is the **intent oracle** —
  what each surface is *meant* to do. When a drive disagrees with it,
  that's a finding, not a spec update.
- `docs/TestScopes/alpha02-harness-seed/` is a **verbatim snapshot**
  of the harness scripts that drove these flows (see its README —
  they are the seed for a checked-in suite, not yet wired to CI).

**Shared acceptance rules** — every write flow below must additionally
satisfy, regardless of its table row:

1. Before signing: the six-row review receipt (You receive / You lock /
   You may owe / You can lose / Fees / When this ends), with protocol
   fees separate from gas.
2. Blocked actions surface as a fixable checklist item or a named
   banner — never a silently dead button.
3. One mandatory risk-and-terms consent checkbox gates the final
   submit; it RESETS whenever a disclosure arrives or changes late.
4. After confirmation: one primary next action, and the change is
   visible in the UI within a block (live sync) or explained if not.

Conventions used below:

- **Actors**: `lender` / `borrower` / `newLender` / `newBorrower` —
  the four dev wallets (addresses live in the operator-held
  `wallets.json`, never committed).
- **Verify**: what was checked. `UI:` = visible app state; `chain:` =
  read back via viem against the Diamond. A flow passes only when both
  agree.
- **Script**: the harness-seed file that automates the flow (blank =
  driven manually or via direct contract calls during the campaign).

---

## 1. Shell, wallet, and mode

| # | Flow | Steps | Verify | Script |
|---|------|-------|--------|--------|
| 1.1 | Connect wallet | Home → Connect wallet → injected provider | UI: address chip renders; jobs grid active | s01-connect |
| 1.2 | Unsupported network gate | Connect on an unsupported chain | UI: named banner + Switch network action; write surfaces disabled | s01 (variant) |
| 1.3 | Advanced-mode reveal | Settings toggle (persisted per-origin `alpha02.mode`) | UI: Offer Book, position-NFT ids, keeper surfaces appear; Basic surfaces unchanged | s04-advanced |
| 1.4 | Testnet faucet gating | Home nudge + sidebar link | UI: present ONLY when read chain is testnet AND bundle carries `testnetMocks`; mainnet slug route self-explains | s-faucet (gating asserts) |

## 2. Faucet (testnet-only)

| # | Flow | Steps | Verify | Script |
|---|------|-------|--------|--------|
| 2.1 | Mint liquid ERC-20 (tLIQ/tLQ2/mWETH) | /faucet → mint card → sign | UI: success banner + "Add \<sym\> to MetaMask" watchAsset button; chain: balance +10,000 units | s-faucet |
| 2.2 | Mint illiquid ERC-20 (tILQ) | same | chain: balance +1,000; later flows classify it Illiquid | s-faucet |
| 2.3 | Mint rental NFT (vRENT/vART) | same | UI: full copyable 256-bit tokenId shown; chain: ownerOf(tokenId) = minter | s-faucet |
| 2.4 | Card presence gating | — | UI: tLQ2/mWETH/vART cards hidden when their `testnetMocks` keys are absent from the bundle | s-faucet |

## 3. Offers — post and cancel

| # | Flow | Steps | Verify | Script |
|---|------|-------|--------|--------|
| 3.1 | L2: post lending offer | Lend → details → your terms → review receipt → consent → approve + createOffer | UI: 6-row receipt, done screen; chain: offer stored, principal approved | s02-post-offer |
| 3.2 | B2: post borrow request | Borrow → same shape, collateral side locked | chain: offer stored, collateral vaulted | (earlier campaign; same engine as 3.1) |
| 3.3 | Cancel own offer | My positions / Offer Book → cancel | UI: cancel inside the 300 s `CANCEL_COOLDOWN_SECONDS` window is blocked with a plain note; after: offer cleared, position NFT burned | s-list11-cancel (cooldown + cancel asserts) |
| 3.4 | Own-offer self-accept block | deep-link own offer | UI: "that's your own offer" message; sign disabled | (accept-engine guard, driven in #887) |

## 4. Offers — accept (the shared engine behind B1/L1)

| # | Flow | Steps | Verify | Script |
|---|------|-------|--------|--------|
| 4.1 | B1: borrower guided match + accept | Borrow → details → matching offers → choose → review → consent → accept | UI: receipt from canonical terms, EIP-712 AcceptTerms prompt; chain: loan opened, collateral locked, funds in vault | s03-accept |
| 4.2 | L1: lender funds a borrow request | Lend → same shape from the other side | chain: loan opened, principal pulled from wallet | (same engine; driven via 8.2's buy which exercises the lender-side accept path) |
| 4.3 | Deep link `?offer=<id>` | open link | UI: lands on review when open + right side; wrong-side / wrong-kind / NFT-kind messages otherwise | s-991-buy2 (uses the deep link) |
| 4.4 | Deep link, indexer lagging | open link before ingest | UI: "data source is catching up" note — never a wrong review; resolves after ingest | s-991-buy2 (poll loop) |
| 4.5 | Stale/consumed offer | accept after offer gone | UI: offerGone message pre-signature; nothing approved | s-991-buy2 second run (observed) |
| 4.6 | Illiquid-leg disclosure | accept pair with unpriced asset | UI: in-kind default warning; consent resets if warning arrives late; signer aborts if review never warned | s03-accept (tILQ pair) |
| 4.7 | Market freshness note | stale indexer cursor | UI: note renders on guided match + rental browse + Offer Book, for EMPTY and NON-EMPTY lists | (verified in #982 round 10) |

## 5. Loan servicing (borrower side)

| # | Flow | Steps | Verify | Script |
|---|------|-------|--------|--------|
| 5.1 | Repay full from wallet | Position → Repay → receipt (live `calculateRepaymentAmount`) → sign | chain: loan Repaid, collateral claimable | s06-repay |
| 5.2 | Repay from vault | Repay → vault-funds path | chain: vault balance debited, loan Repaid | s07-vault-repay |
| 5.3 | Partial repay | Repay → partial amount | UI: full-remaining amount redirected to full repay (no zombie); chain: principal reduced, interest clock re-stamped | (driven in #943 campaign) |
| 5.4 | Add collateral | Position → add collateral | chain: collateralAmount increased; HF improves | (driven in #943 campaign) |
| 5.5 | Preclose direct | Position → close early → receipt | chain: loan settled per preclose math | s09-preclose |
| 5.6 | Refinance: post offset offer | Position → refinance → post | chain: refi offer linked | s10-refinance |
| 5.7 | Refinance: accepted | second wallet accepts | chain: old lender paid off, new loan live | s11-refi-accept |
| 5.8 | Refinance: cancel pending | cancel from position | chain: offer cleared, locks released | s12-refi-cancel |

## 6. Lender exits

| # | Flow | Steps | Verify | Script |
|---|------|-------|--------|--------|
| 6.1 | Instant exit (sell into buy offer) | Position → instant exit → picker rows quote seller economics → sign | chain: `sellLoanViaBuyOffer` — lender handoff, seller paid net of forfeit | s13-instant-exit, s13b-exit |
| 6.2 | Sale listing: list | Position → "List this position for sale" → rate → review (lock disclosure + standing-approval note) → consent → sign | UI: pending card "Sale listing #N is live"; chain: sale offer linked, lender NFT lock kind 2, settlement approval = `saleSettlementBound` | s-list11, s-991-buy (step A) |
| 6.3 | Sale listing: cancel after cooldown | pending card → cancel | UI: cooldown block first, then cancelled; chain: offer cleared, NFT unlocked | s-list11-cancel |
| 6.4 | Sale BUY (the #991 flow) | second wallet deep-links the sale offer → buy-a-running-loan review (position-sale banner, live principal price, remaining-term interest, live collateral, real due date + loan-bucket grace) → consent → "Fund this borrower" | UI: "Position bought" done copy; chain: loan lender = buyer, offer accepted, loan still Active for borrower, seller paid principal − accrued forfeit | s-991-buy2 (UI), s-986-broadcast (contract-level) |
| 6.5 | Sale BUY blocked states | drive each gate | UI blocks with named reasons: loan not active / matured / seller settlement funding not covered / buyer is the loan's current borrower / offset-linked offer (permanent block) | (gate logic verified in #991 rounds; seller-not-covered reproduced live via missing approval → `OfferAcceptFailed`) |

## 7. Keepers (Phase 6 trio)

| # | Flow | Steps | Verify | Script |
|---|------|-------|--------|--------|
| 7.1 | Whitelist a keeper + action mask | Settings → keepers | chain: keeper config stored | s05-keepers |
| 7.2 | Per-loan keeper enable | Position → keeper card → toggle | chain: `setLoanKeeperEnabled`; UI: checkbox reflects MINED value immediately (cache patch — no bounce on lagging RPC), exact per-loan key (no cross-loan leak) | s05b-keeper-finish |
| 7.3 | Master-off banner | disable master switch | UI: per-loan card shows master-off warning | s05b (variant) |

## 8. Liquidation and terminal states

| # | Flow | Steps | Verify | Script |
|---|------|-------|--------|--------|
| 8.1 | Build an at-risk loan | offer + accept with thin HF | chain: HF near 1e18 | s-liq-offer, s-liq-accept-send |
| 8.2 | HF liquidation | `triggerLiquidation` via registered MockSwapAdapter | chain: loan Liquidated, swap through the Tier-2 venue, liquidator bonus | s-liquidate8 |
| 8.3 | Terminal-state rendering | drive position page across Repaid / Defaulted / Liquidated / InternalMatched / Settled | UI: action gates match ClaimFacet reality (Settled is NOT claimable on either side; internal_matched borrower shows "claim what's left"); settled-ahead banner only on reconciled terminals | s-pos8-terminal |
| 8.4 | fallback_pending reversibility | borrower cures | UI: live-Active overrides the indexer row on the detail page; row drops from Claim Center | (probes + UI, #982 rounds 3–5) |

## 9. Claims

| # | Flow | Steps | Verify | Script |
|---|------|-------|--------|--------|
| 9.1 | Claim as lender | Claim Center → row → claim | chain: heldForLender paid out; UI row keyed (loanId, role) | s08-claims |
| 9.2 | Claim as borrower (+ LIF rebate) | same, borrower side | chain: collateral + Phase-5 VPFI rebate atomically; UI preflights entitlement (no doomed NothingToClaim prompt) | s08-claims |
| 9.3 | Secondary-market buyer discovery | wallet holds bought position NFT only | UI: row appears via chain enumeration (`getUserPositionLoansPaginated` UNION indexed) even when the indexer never saw the wallet | (verified after 6.4) |
| 9.4 | Indexer-down honesty | indexer unreachable | UI: claims still complete via chain enumeration; unavailable only when BOTH sources fail | (fault-injected during #982) |

## 10. NFT rental (N1/N2)

| # | Flow | Steps | Verify | Script |
|---|------|-------|--------|--------|
| 10.1 | N1: list NFT for rent | Rent → list → daily rate → sign | chain: ERC-4907 listing live | (driven in #887 campaign) |
| 10.2 | N2: rent an NFT | Rent → browse → review (prepay + 5% buffer) → consent → sign | chain: userOf set, prepay pulled; UI: custody note | (driven in #887 campaign) |
| 10.3 | Rental browse freshness | stale indexer | UI: freshness note above listings (empty or not) | (#982 round 10) |

## 11. VPFI (V1)

| # | Flow | Steps | Verify | Script |
|---|------|-------|--------|--------|
| 11.1 | Deposit to vault | /vpfi → deposit → receipt → approve + sign | chain: tracked balance up; UI: tier table from LIVE thresholds | s-vpfi-deposit |
| 11.2 | Withdraw (free-balance cap) | withdraw → Max | UI: Max = free (tracked − encumbered), over-max blocked | s-vpfi, s-vpfi-check |
| 11.3 | Consent toggle | tick "Use my vaulted VPFI…" | UI: checkbox reflects mined value immediately (cache patch; no MetaMask re-prompt loop); opt-off also fires `pokeMyTier` best-effort | s-vpfi (post-fix) |
| 11.4 | Add VPFI to MetaMask | button in discount-status card | UI: renders only when wallet OR vault balance > 0; watchAsset prompt | (driven on #982 preview) |
| 11.5 | Unregistered-chain state | switch read chain without VPFI | UI: availability-first "not on this chain" (positive read) vs "couldn't check" (failed read) | s-vpfi-check |

## 12. Cross-cutting honesty rules (regression-test on every touched surface)

These are behaviors, not routes — they were each verified on multiple
surfaces and regress silently if dropped:

- **undefined = loading, null = unavailable** — no surface renders a
  confident empty state from a failed read.
- **Late disclosures reset consent** — illiquid warning, linked-loan
  banner, grace-label move, sale-review value drift (fingerprint).
- **Signing gates on KNOWN checks** — liquidity, linked-loan kind,
  grace bucket, sale review; a failed check names itself and offers
  Retry; the Sign button is never dead without a stated reason.
- **Reviewed-vs-canonical abort** — the signer compares what the review
  showed against live terms BEFORE the wallet prompt; termsChanged
  refetches the relevant queries so a retry re-reviews, not re-aborts.
- **Read-after-write cache patches** — VPFI consent + keeper toggles
  patch the mined value and are excluded from block-driven
  invalidation ('vpfi', 'loanKeeperEnabled' not in LIVE_KEYS).
- **Live preflights before approvals** — sanctions (both parties),
  balances, allowances, asset-pause, seller settlement funding; every
  doomed transaction fails BEFORE an approval can mine.

---

## Known gaps (not yet driven end-to-end)

- Time-based default → `markDefaulted` → in-kind transfer, driven
  through the UI (contract path covered by Foundry; UI claim of a
  defaulted in-kind loan was driven, the *marking* was script-side).
- Sanctions banner + Tier-1 revert UX for a flagged wallet (needs the
  sanctions oracle set + a flagged test wallet; retail deploy runs
  fail-open until the oracle is configured).
- Periodic-interest cadence loans through the UI.
- Arbitrum Sepolia parity drive (all of the above were driven on Base
  Sepolia; Arb has the same facets + flags but only spot-checks so far).
- Interaction-rewards claim through the UI (days finalize on Base
  Sepolia now; the claim surface itself is future work).
