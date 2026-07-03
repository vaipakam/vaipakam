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

<!-- Remaining sections (R-3 HF display, refinance, liquidation,
     live-sync, claimables) appended as each flow is driven. -->
