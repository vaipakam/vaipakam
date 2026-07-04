# Testnet review — faucet, oracle Tier 1/2, live-sync, on-chain claimables

**Branch:** `claude/testnet-mocks-and-faucet` (PR #982)
**Surfaces:** Cloudflare branch preview
(`claude-testnet-mocks-and-faucet-vaipakam-alpha02.dawn-fire-139e.workers.dev`)
for the branch-only features (faucet, live-sync, on-chain claimables);
`alpha02.vaipakam.com` (production) for the liquid-path against live
chain state. Base Sepolia (chainId 84532), Diamond
`0xd89fd7F787e4415460b23891E97570a4881fb995`.
**Date:** 2026-07-03.

This review validates the work in PR #982: the testnet faucet, the
Tier-1/Tier-2 oracle+swap mocks, the WebSocket live-sync, and the
on-chain-authoritative claimables port. Method mirrors the prior
testnet pass — drive the real UI with an injected wallet (Playwright,
key never enters the page), then verify every assertion against direct
chain reads.

**This is the CONTINUATION of the first alpha02 testnet pass**, whose
findings are in the companion doc
[`Findings20260703-TestnetReviewAlpha02.md`](./Findings20260703-TestnetReviewAlpha02.md)
(F-20260703-001 … 007 + the "What worked" matrix). That pass ran the
full role-based sweep (connect/mode gates, offer post/cancel/repost,
accept both directions, repay full/partial, add-collateral, claims,
preclose, early-exit, offer-lifecycle) and verified everything up to the
point where it was **blocked on missing oracle feeds** — the liquid-path
suite (HF display, drop-to-liquidation, refinance completion) could not
run because every mock asset classified illiquid (F-007). The Tier-1/2
oracle+swap mocks in this PR are exactly what unblock that suite; the
sections below pick up from there. Read the two docs together for the
complete alpha02 live-testnet review.

**Load-bearing cross-reference — the stalled indexer (F-001 / F-004):**
the first pass documented that the staging/production indexer only
advances in webhook-triggered bursts and can read a many-hour-old
snapshot. That directly shapes this pass: a freshly-created offer (e.g.
offer #15 below) is on-chain immediately but does not appear in the
indexer-sourced offer book for a long time — which is precisely why the
on-chain-authoritative claimables port (and, ideally, an on-chain offer
read path) matters. Where a flow here depends on the indexer, that
dependency is called out.

## On-chain infrastructure verification (precondition)

| Check | Result |
| --- | --- |
| `checkLiquidity(tLIQ)` | `0` = **Liquid** ✅ |
| `checkLiquidity(tILQ)` | `1` = illiquid (as designed) ✅ |
| `checkLiquidity(WETH)` | `0` = Liquid ✅ |
| Registered swap adapters | `MockSwapAdapter` at `getSwapAdapters()` index 0 ✅ |
| Adapter output float | 1,000,000 tLIQ held ✅ |

## R-1 — Faucet page (`/faucet`) — PASS ✅

Driven on the branch preview with the `borrower` wallet.

- Route loads; title **"Get test assets"**, testnet note shown.
- All three cards render: liquid (tLIQ), illiquid (tILQ), rental NFT
  (vRENT).
- Mint **tLIQ** → wallet balance +10,000 (verified on-chain).
- Mint **tILQ** → wallet balance +1,000 (verified on-chain).
- Mint **vRENT** → ERC-721 `balanceOf` = 1 (verified on-chain).
- "Minted …" confirmation banner shown after each; zero console errors.

Double-gate confirmed by construction: the page reads
`getDeployment(readChain.chainId)?.testnetMocks` AND `readChain.testnet`
— absent on every mainnet slug, so the route self-explains there.

## R-2 — Liquid offer creation (tLIQ collateral) — PASS ✅

Driven on production (`alpha02.vaipakam.com`) with the `lender` wallet:
post a lending offer of 0.005 WETH requiring **1 tLIQ** collateral.

- The Create-Offer **review screen no longer shows the illiquid
  warning** ("isn't priced by the protocol") for tLIQ — confirming the
  Tier-1 oracle wiring flows through to the UI's liquidity read. Before
  the oracle mocks, any mock token tripped the illiquid disclosure path.
- Offer posted end-to-end: approval + `createOffer` mined, "offer
  posted" done screen reached. (The scenario's `OfferCreated` log
  parser uses a 7-arg event signature that doesn't match the current
  event shape — a harness artifact, not a product issue; the offer is
  confirmed live by the done screen and picked up in R-3.)

### OBS-1 — production public RPC rate-limits (429) the harness wallet

The injected-wallet harness initially failed to submit the offer: the
page emitted repeated `429 Too Many Requests`. Root cause was the
harness's **own** signer RPC defaulting to the public `sepolia.base.org`;
pointing it at the dRPC endpoint fixed it immediately (offer mined in
2s). This is a **testing-harness note, not a confirmed product finding**
— production reads use the configured dRPC `VITE_*` RPC, so real users
shouldn't hit this. Flagged only so a future reviewer isn't surprised by
429s on the default public endpoint. (Worth a spot-check that no
first-paint frontend read falls back to a public endpoint under load.)

## R-3 — Liquid loan: HF DISPLAY — PASS ✅ (F-007 resolved)

A real active **liquid loan** was created on-chain (loan **#8**): 1 tLIQ
collateral ($2,000), 0.005 WETH principal ($10), both legs liquid.

On-chain truth (`RiskFacet`):
- `calculateHealthFactor(8)` = **180.0** (1e18-scaled 180e18)
- `calculateLTV(8)` = 50 bps
- `acceptOffer` **simulated + mined successfully** → the liquid HF gate
  at loan-init (HF ≥ 1.5) passes. Before the oracle mocks this was the
  exact `IlliquidLoanNoRiskMath` blocker (first pass F-007).

UI (`/positions/8` on `alpha02.vaipakam.com`, borrower wallet):
- The position page **renders the Health Factor** — label present, value
  consistent with ~180, "**Healthy**" badge shown. ✅
- Repay / manage actions render; **no "not found" / unavailable** state;
  zero non-429 console errors. ✅

This is the headline unblock: the Tier-1 oracle mocks make the liquid
path work end-to-end through the UI — the position HF gauge that was
dark for every mock asset now shows a real, correct value.

**Note on how the loan was created:** because the offer book is
indexer-sourced and the staging indexer is stalled (F-001/F-004), the
borrower's UI accept can't discover a freshly-created offer, so loan #8
was created by a scripted accept (approve tLIQ→Diamond, ensure vault,
sign the same EIP-712 `AcceptTerms` the app signs, `acceptOffer`). The
loan is a normal on-chain loan; the position page reads it live. A live
indexer would let the whole accept happen in the UI too.

### R-3b — repayPartial full-principal revert (#953 item 3)

Loan #8 has `allowsPartialRepay = false`, so it can't exercise the new
`repayPartial` guard. Verifying the `PartialWouldRetireFullPrincipal`
revert needs a partial-enabled liquid loan — noted as a follow-up drive
(a second scripted loan with the partial-repay offer flag).

### R-3c — Tier-2 HF-swap liquidation — PASS ✅

Full end-to-end HF-based liquidation of loan #8 via the registered
`MockSwapAdapter` (Tier-2). The tricky part — forcing HF < 1 while the
collateral stays **Liquid** — was handled by moving the tLIQ feed AND
the mock pool's `sqrtPriceX96` in **lockstep** (so the oracle's
value-balance guard, pool-spot ≈ feed-ratio, keeps holding):

1. Funded the `MockSwapAdapter` with 0.005 WETH (the loan's principal =
   swap output) and set its output multiplier so proceeds clear the
   oracle slippage floor.
2. Dropped tLIQ feed → $5 and the pool ratio → 400 tLIQ/WETH in lockstep.
   Result verified on-chain: **`calculateHealthFactor(8)` = 0.40** AND
   **`checkLiquidity(tLIQ)` still = 0 (Liquid)** — exactly the state a
   real HF liquidation needs. ✅
3. `triggerLiquidation(8, [{adapterIdx: 0, data: 0x}])` (permissionless
   caller) — **simulated OK and mined**. ✅
4. On-chain outcome verified: the **`MockSwapAdapter` received the 1 tLIQ
   collateral** (balance 1,000,000 → 1,000,001) and **paid out ~0.003
   WETH proceeds**; **loan #8 → status 2 (Defaulted/liquidated)**,
   terminal. ✅
5. Restored tLIQ → $2,000 + pool 1:1 so the faucet's liquid
   classification stays correct for future demos.

UI (`/positions/8`): the page now shows a **defaulted/closed** state and
no longer shows Active/Healthy. ✅

This confirms the entire Tier-2 stack the PR added — the registered
adapter, the swap-failover path, and the oracle value-balance guard —
works end-to-end on the live testnet.

### OBS-2 — a repay affordance may still render on the defaulted loan

On `/positions/8` after liquidation, a repay-related string is still
present in the page. It may be inert help text, but a live "repay"
button on a terminal (Defaulted) loan would be a minor UI defect (the
repay would revert). Flagged for a quick confirm — low severity, not
blocking.

## R-5 — VPFI discounts / tiers / interaction rewards — DORMANT on testnet (deploy/config, not an alpha02 defect)

Checked on-chain against the Base Sepolia Diamond:

- **`getVPFIToken()` returns `address(0)`** — VPFI is **not registered**
  in the deployed Diamond. (The VPFI token *contract* exists at
  `deployments.vpfiToken`, but the Diamond's discount/reward machinery
  has no VPFI pointer set.)
- Consequently every VPFI read is zero for every wallet:
  `getEffectiveDiscount` = `[tier 0, 0 bps]`,
  `getTrackedVPFIDiscountTier` = `[0, 0, 0]`,
  `getVPFIBalanceOf` = 0.
- `previewInteractionRewards` / `getInteractionClaimability` = all zero —
  the platform interaction-reward accrual (global reward calc) is not
  active on this deploy either.

So the VPFI **discount/tier mechanism and interaction-reward global
calculation cannot be functionally exercised** on the current testnet
Diamond — this is a deploy/config gap, not an app bug.

What the UI does with the dormant state — verified, correct:
- **`/vpfi`** renders honestly: "VPFI deposits aren’t available on Base
  Sepolia yet. Everything else on Vaipakam works without VPFI." + the
  educational tier explanation, **no crash, no console errors**. It does
  NOT fabricate a tier table or a fake discount. ✅ (This matches the
  page's `!snapshot.registered` branch and its honesty rule: "not
  available on this chain" only when the chain positively says so.)
- **Claims → Rewards card** correctly shows the empty (0 pending)
  interaction-rewards state, not an error. ✅

### R-5a — VPFI enablement helper (`DeployTestnetVPFI.s.sol`)

To make VPFI reviewable, added `contracts/script/DeployTestnetVPFI.s.sol`
— an operator-run one-shot (mirrors `DeployTestnetMocks`) that:

1. (admin) `setVPFIToken(deployments.vpfiToken)` — registers VPFI so
   `getVPFIToken()` is non-zero and the discount machinery activates.
   Tier thresholds (100 / 1,000 / 5,000 / 20,000 VPFI → 10 / 15 / 20 /
   24 %) already have on-chain defaults, so no tier config is needed.
2. (admin) `setVPFIDiscountETHPriceAsset(WETH)` + `setVPFIDiscountRate`
   — the ETH-price reference (now oracle-priced via the mocks) and the
   wei-per-VPFI rate the borrower LIF-rebate quote uses.
3. (VPFI holder = treasury, which holds the full 23M initial supply on
   testnet) transfers VPFI to up to four recipient wallets.

**Run (Base Sepolia):**
```bash
export ADMIN_PRIVATE_KEY=<admin>
export VPFI_SOURCE_PRIVATE_KEY=<treasury holder 0xca3E…7413>
export VPFI_RECIPIENT_1=0xC86BB89f8ddF703c34724Cf11137498bC69F039D  # borrower
export VPFI_RECIPIENT_2=0x1DAefA360ED370285f003Fa2d92DB75628088282  # lender
# VPFI_AMOUNT_EACH defaults to 25000 (top tier)
forge script script/DeployTestnetVPFI.s.sol --rpc-url <base-sepolia> --broadcast
```
The 23M VPFI sits in the **treasury** (`0xca3E735C…7413`), so
`VPFI_SOURCE_PRIVATE_KEY` must be that holder's key (the token's minter
is the Diamond, so VPFI can't be freshly minted from an EOA). No new
contracts are deployed and no `deployments.json` change is needed —
`vpfiToken` is already recorded.

Once run, I can review: the `/vpfi` page going active (tier table +
deposit), a VPFI deposit climbing tiers (`getEffectiveDiscount`), and —
with a settled loan — the discount actually applied. **The script was
NOT compiled here (foundry unavailable); it mirrors `DeployTestnetMocks`
with every facet signature verified against source.**

## R-3d — What remains (lower priority / harder to exercise)

- **repayPartial full-principal revert (#953 item 3)** — needs a
  partial-repay-enabled liquid loan (loan #8 has it off). A second
  scripted loan with the partial flag would exercise the
  `PartialWouldRetireFullPrincipal` revert.
- **Refinance completion (first pass F-006/F-007)** — now unblocked on
  the contract side (liquid HF math works); a full New-Lender refinance
  of a liquid loan through the UI is the remaining drive, gated on the
  same indexer/UI-accept friction as R-3.
- **claimInteractionRewards sanctions gate (#953 item 1)** — deployed;
  hard to exercise live because the testnet sanctions oracle is unset
  (fail-open → no wallet is flagged), so the gate is a no-op to observe.
  The UI's own live re-read gate (RewardsCard) remains as belt-and-braces.

## R-4 — Branch features smoke (preview) — PASS ✅

Read-only pass on the branch preview with the `borrower` wallet
(no loan required):

- **Home testnet nudge** — "Get test assets" nudge renders on testnet
  and links to `/faucet`. ✅
- **Nav** — testnet-only "Get test assets" sidebar entry present. ✅
- **Claims (on-chain claimables port, #958)** — the page renders via the
  new `useMyClaimables` on-chain hook: it is NOT stuck on "Checking for
  claims…", and shows a clean empty/rows state (no "couldn't load"
  error). Confirms the indexer→on-chain candidate+confirm path executes
  against the live Diamond without throwing. ✅
- **Positions** — renders. ✅
- **Live-sync (WebSocket layer)** — after letting the block watcher run
  several blocks: **zero non-429 console errors and no `LiveChainSync`
  errors**. With no `VITE_*_WSS_URL` configured on the preview, the
  layer degrades to HTTP block polling exactly as designed — no crash,
  no error spam. ✅

(429s from the public RPC still appear in the console under load —
OBS-1; they are provider rate-limits, not app errors, and are filtered
out above.)

## Summary of this pass

| Item | Result |
| --- | --- |
| Infra (tLIQ Liquid, adapter registered+funded) | ✅ verified on-chain |
| R-1 Faucet mint tLIQ/tILQ/vRENT | ✅ PASS (balances confirmed) |
| R-2 Liquid offer creation (illiquid warning absent) | ✅ PASS |
| R-3 Liquid loan HF **display** (loan #8) | ✅ PASS (HF 180 "Healthy" shown) |
| R-3c Tier-2 HF-swap **liquidation** (loan #8) | ✅ PASS (HF→0.40 liquid, adapter swap, loan Defaulted, UI reflects) |
| R-3b repayPartial full-principal revert (#953 item 3) | ⏳ pending a partial-enabled loan |
| R-3d Refinance completion / sanctions-gate | ⏳ contract-unblocked; UI drive pending (indexer) / not observable (oracle unset) |
| R-4 Home nudge / faucet nav / Claims on-chain / live-sync | ✅ PASS |
| VPFI discounts / tiers / interaction rewards (R-5) | ⚠️ dormant on testnet (`getVPFIToken()==0`); UI handles it honestly ✅; functional review needs VPFI enablement |

Net: the faucet, the Tier-1 liquid-classification-in-UI, the HF display,
and the full Tier-2 liquidation are all verified working end-to-end on
the live testnet. Remaining UI drives (partial-repay revert, full
refinance) are gated on the same stalled-indexer friction, not on this
PR's code.
