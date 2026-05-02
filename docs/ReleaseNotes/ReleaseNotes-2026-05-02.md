# Release Notes — 2026-05-02

Functional record of work delivered on 2026-05-02, written as
plain-English user-facing / operator-facing descriptions — no
code. Continues from
[`ReleaseNotes-2026-05-01.md`](./ReleaseNotes-2026-05-01.md).

Coverage at a glance: one piece of housekeeping — **merging six
commits from `main` into `feat/range-orders-phase1`** (LayerZero
buyOptions defaults, BuyVPFI error fixes, README whitepaper
content, gitignore housekeeping) so the feature branch is current
with everything that landed on the trunk while range-orders work
was in flight. No new contract logic. No new frontend features
beyond what the merge brought in.

## main → feat merge

Background: while the Range Orders Phase 1 work has been
progressing on `feat/range-orders-phase1` for several weeks, six
commits landed on `main` in parallel — small operator-quality
items (a deployment-script ergonomics pass, a Buy VPFI error fix,
a README whitepaper update, a `.gitignore` cleanup). To avoid the
feature branch drifting too far from the trunk before its
eventual merge, today's batch pulls those six commits in.

**Commits brought across:**

- `715290a` — Buy VPFI error fix: `quoteBuy` was reverting with
  `LZ_ULN_InvalidWorkerOptions` (selector `0x6592671c`) on a
  freshly-deployed adapter when the operator forgot the post-deploy
  `setBuyOptions` call. The fix encodes a default Type-3 LayerZero
  payload inline at deploy via
  `OptionsBuilder.addExecutorLzReceiveOption(LZ_RECEIVE_GAS,
  LZ_RECEIVE_VALUE)` so the adapter is buyable end-to-end without
  the follow-up step. Default gas budget 200,000; tunable per chain
  via env. Frontend gained a `journeyLog` hook around the
  bridged-buy `quoteFee` call so a `quoteBuy` revert now lands in
  the Diagnostics drawer instead of just the inline `quoteError`.
- `098c6ea` — `SetBuyOptions.s.sol` companion script for
  post-deploy gas-budget adjustments to an already-live BuyAdapter.
  Same encoding shape as the deploy-time inline default, so the
  two paths produce byte-identical options when configured the
  same way.
- `e495c3c` — `.gitignore` adds `.claude/` (the Claude Code
  per-machine / per-session runtime state — `scheduled_tasks.lock`
  rewrites every session, `settings.local.json` is per-user,
  `worktrees/` is ephemeral). Two old per-machine lock files
  removed from tracking on the same commit.
- `1777ee4` — LayerZero scripts harness: cleans up the deploy
  script's options-building so all three flows (deploy-time,
  post-deploy `setBuyOptions`, the `BridgeVPFI` runtime quote)
  share one `OptionsBuilder` recipe.
- `5c77612` — README is now the canonical Whitepaper text — the
  same content shipped under `frontend/src/content/whitepaper/`
  is the repo's top-level README so anyone landing on the public
  GitHub gets the protocol overview directly without hunting.
- `9eb4784` — `docs/ProjectDetailsREADME.md` added — the
  internal/operator-facing companion to the public whitepaper.

**Conflicts hand-resolved during the merge:**

| File | Resolution |
|---|---|
| `.claude/scheduled_tasks.lock` | Accepted main's deletion (lock file, no value) |
| `.claude/settings.json` | Accepted main's deletion |
| `.gitignore` | Both branches' additions kept — `.claude/` block (from main) sits alongside the `docs/internal/RoughNotes.md` operator-scratchpad rule (from feat) |
| `README.md` | Replaced with the verbatim contents of `frontend/src/content/whitepaper/Whitepaper.en.md` per operator direction — the whitepaper IS the README, single source of truth |
| `contracts/script/DeployVPFIBuyAdapter.s.sol` | **Both branches' additions combined.** Main contributed the `OptionsBuilder` import + `_defaultBuyOptions()` helper + the inline buy-options encoding at deploy time. Feat contributed the `_chainRequiresWethPaymentToken()` pre-flight gate (T-036, mainnet WETH-pull mode enforcement on BNB / Polygon). Both functions coexist; the deploy flow now does the WETH-pull pre-flight first, then encodes default buyOptions if the env is unset, then broadcasts. |

**Auto-merged with no conflict markers** but worth noting:

- `frontend/src/pages/BuyVPFI.tsx` — main's `journeyLog` hook
  around the bridged-buy quote sat at lines that didn't overlap
  with feat's T-038 asset-symbol + CoinGecko-link work.
- `frontend/src/lib/decodeContractError.ts` — minor adjustment.

**Verified after the merge:**

- `forge build` clean on the combined state.
- `RepayFacet` targeted suite 63/63 passing (regression sanity
  check — repay path was the busiest area in T-037).
- Full no-invariants regression run as the final gate before the
  merge commit lands.

## T-031 cross-chain VPFI buy hardening — Layer 2 + Layer 4a

A multi-round threat-model review of the cross-chain VPFI buy flow
landed two complementary hardenings on top of the existing DVN
policy + caps + pause infrastructure. The full layered rationale
sits in the T-031 entry of [`docs/ToDo.md`](../ToDo.md); this
section is the operator-facing summary.

**The threat being closed.** Today's Phase-1 fixed-rate VPFI buy
(1 VPFI = 0.001 ETH) crosses LayerZero in two messages: a
`BUY_REQUEST` from the source-chain `VPFIBuyAdapter` to the
canonical `VPFIBuyReceiver` on Base, and a `BUY_SUCCESS` reply that
drove ETH-release-to-treasury on the source chain. Pre-T-031, a
forged inbound `BUY_REQUEST` (e.g. via a compromised LayerZero DVN)
could mint VPFI on Base and OFT-bridge it directly to an
attacker-controlled wallet on the source chain. The DVN policy + caps
bounded the damage, but the on-chain cross-check that "this VPFI
delivery actually corresponds to an ETH inflow on the named source
chain" did not exist.

**Layer 2 — buy-flow VPFI now routes through the source-chain
adapter via OFT compose.** The receiver no longer OFT-sends VPFI
directly to the buyer's wallet — it sends to the source-chain
*adapter contract* with the LayerZero V2 OFT-compose feature, where
the compose payload carries `(uint64 requestId)`. The adapter's new
`lzCompose` handler then cross-checks `pendingBuys[requestId].buyer`
— set by the actual ETH-paying `buy()` call's `msg.sender`, the only
place in the entire mesh with authoritative local truth about who
paid on the source chain — and forwards VPFI to that wallet only if
a matching pending entry exists. Side-effect: the LZ message count
per buy drops from 3 to 2 (BUY_SUCCESS reply eliminated; the OFT
compose IS the success signal now).

A forged BUY_REQUEST under the new flow lands VPFI on the
source-chain adapter, the adapter sees `pendingBuys[forgedId].buyer
== address(0)`, records the VPFI as stuck (owner-recoverable via the
new `recoverStuckVPFI`), and the attacker gets nothing. Replay
attacks (same compose landing twice) hit the `status != Pending`
guard on the second arrival — also recorded as stuck, no
double-payout. Auth gates on `lzCompose`: `msg.sender == endpoint`
and `_from == vpfiMirror` (operator-set via the new
`setVPFIMirror`). Source-chain adapter additionally needs
`setVPFIToken(localMirrorErc20)` before bridged buys can settle.

**Receiver-side changes** (`VPFIBuyReceiver.sol`): new `mapping(uint32
=> address) public buyAdapterByEid` plus `setBuyAdapter(eid, adapter)`
owner-only setter — the OFT compose target is read from this
registry, NOT from the buyer's address. `_tryOftSend` now takes
`(requestId, buyer, dstEid, vpfiOut)`; sets `to =
addressToBytes32(buyAdapterByEid[dstEid])` and `composeMsg =
abi.encode(requestId)`. Soft-fails with `"buy-adapter-unset"` when
the registry slot is empty (caller stamps `VPFIStuckForManualBridge`
for owner recovery, same as any other OFT-side misconfig). The
`_sendResponse(MSG_TYPE_BUY_SUCCESS, ...)` reply call is removed —
the OFT-compose mint to the source-chain adapter is the success
signal now. `BUY_FAILED` reply path unchanged. New
`OPT_KIND_OFT_BACK_LEG = 4` constant for the OptionsSet event tag
(replaces the retired `MSG_TYPE_BUY_SUCCESS = 2` slot, which is
preserved in the protocol enum for in-flight payload-shape
compatibility but no longer dispatched).

**Adapter-side changes** (`VPFIBuyAdapter.sol`): now implements
`IOAppComposer` from the LZ V2 oapp-evm package. New
`lzCompose(_from, _guid, _message, _executor, _extraData)` external
payable function decodes the OFTComposeMsgCodec envelope, extracts
`amountLD` (= VPFI minted to this contract by the local mirror) plus
the inner `(uint64 requestId)`, runs the local cross-check against
`pendingBuys[requestId]`, and on the happy branch transfers VPFI to
the recorded buyer + calls `_releaseToTreasury(amountIn)` to settle
ETH escrow → treasury in the same step. The forged + replay branches
both record into `mapping(uint64 => uint256) public stuckVPFIByRequest`
and bump `totalStuckVPFI` — sweepable by owner via the new
`recoverStuckVPFI(requestId, recipient)`. The `MSG_TYPE_BUY_SUCCESS`
branch is dropped from `_lzReceive`; only `MSG_TYPE_BUY_FAILED`
plus the unchanged timeout-refund path remain on the OApp inbound.
New errors `NotEndpoint`, `UnauthorizedComposeSource`,
`VpfiMirrorNotSet`, `VpfiTokenNotSet`, `NoStuckVPFI`. New events
`VPFITokenSet`, `VPFIMirrorSet`, `UnsolicitedComposeArrival`,
`StuckVPFIRecovered`. New setters `setVPFIToken`, `setVPFIMirror`.

**Layer 4a — cross-chain reconciliation watchdog Worker.** A new
`buyWatchdog.ts` module landed in the existing `ops/hf-watcher`
Cloudflare Worker, piggybacking on its scheduled cron. Each pass
reads `BridgedBuyProcessed(requestId, originEid, buyer,
ethAmountPaid, ...)` events on Base from the last ~60 blocks,
resolves the `originEid` to the source chain's RPC + adapter
address, and queries that adapter for a matching `BuyRequested`
event. Mismatch — either no source-chain `buy()` ever made for the
named requestId, or the buyer/amount fields diverge — surfaces via
`console.error` on Cloudflare's log pipe (operator sees in real
time via `wrangler tail`). The pass has a hard kill switch: it
calls `receiver.reconciliationWatchdogEnabled()` first and exits
quietly when the on-chain flag is false. Auto-`pause()` is
intentionally NOT wired in this first cut (would require the
watchdog to hold a constrained pauser-multisig key — separate
ops decision, deferred to a follow-up); for now the watchdog
alerts and the operator triggers `pause()` from the
governance multisig.

**Governance flag** (`VPFIBuyReceiver.reconciliationWatchdogEnabled`):
new `bool public` storage default-`true` post-init, with
`setReconciliationWatchdogEnabled(bool)` owner-only setter and
`ReconciliationWatchdogToggled(bool)` event. Lets governance
silence the watchdog during a planned bridge ceremony or known
reconciliation gap without redeploying the Worker.

**What remains the same.** The DVN policy (3 required + 2 optional,
operator-diversity-mandatory per `contracts/README.md "Cross-Chain
Security"`) is unchanged — Layer 2 is defense-in-depth, not a
replacement. Per-source-chain `setRateLimits(50_000e18,
500_000e18)` is unchanged. The plain OFT lane
(`VPFIOFTAdapter` ↔ `VPFIMirror`) is unchanged — keeping it on
standard OFT semantics so third-party bridges (Stargate, etc.) can
integrate VPFI cross-chain later via the canonical lane. The Layer 2
guard applies specifically to the buy flow, where the receiver
controls the OFT-compose destination; user-initiated cross-chain
VPFI transfers continue to land on user wallets directly via the
standard OFT receive path. That residual surface is the same trust
class as every OFT-class token (USDC's CCTP, etc.) and watchdog
reconciliation can be extended to monitor it as a follow-up.

**Verification:**
- 9 new targeted tests in
  [`contracts/test/token/VPFIBuyAdapterComposeTest.t.sol`](../../contracts/test/token/VPFIBuyAdapterComposeTest.t.sol)
  cover happy path, forged-stuck, replay, three auth gates
  (non-endpoint caller, wrong `_from`, unset mirror), and two
  recovery paths (owner sweep + non-owner revert + unknown-id
  revert). All 9 green.
- Full no-invariants regression on the merged state:
  **1503 passing / 0 failed / 5 skipped** (up from 1494 pre-T-031).
- Watcher TypeScript: `npx tsc -p . --noEmit` clean from
  `ops/hf-watcher/`.

**Operational notes for the redeploy:**
1. Add `setBuyAdapter(eid, adapterAddress)` calls to the receiver's
   post-deploy script for every source chain in the mesh — without
   this, BUY_REQUESTs from that chain refund instead of settling.
2. Add `setVPFIToken(localMirrorErc20)` and
   `setVPFIMirror(localMirrorContract)` calls to each source-chain
   adapter's post-deploy script.
3. Operator-curated `oftSendOptions` now needs to include both the
   LzReceive (mint) and LzCompose (calling adapter.lzCompose) gas
   budgets — re-run `OptionsBuilder.addExecutorLzReceiveOption` +
   `OptionsBuilder.addExecutorLzComposeOption` and call
   `setOFTSendOptions(...)`.
4. `wrangler secret put` the additional source-chain RPCs the
   watchdog needs: `RPC_POLYGON`, `RPC_SEPOLIA`, `RPC_ARB_SEPOLIA`,
   `RPC_OP_SEPOLIA`, `RPC_POLYGON_AMOY`, `RPC_BNB_TESTNET`,
   `RPC_BASE_SEPOLIA`. Without these, the watchdog skips
   reconciliation for that lane and logs.

## T-033 Pyth-as-numeraire-redundancy + project-wide setter range audit

The previous oracle phase (7b.2) deliberately removed Pyth because
its `bytes32 priceId` requires a per-asset governance mapping, which
conflicts with the project's no-per-asset-config policy that lets
new collateral assets list without a governance write. T-033
re-introduces Pyth in a **single-feed-per-chain** shape that keeps
that policy intact: one Pyth feed (ETH/USD on ETH-native chains;
bridged-WETH/USD on BNB / Polygon mainnet) is registered as a
sanity gate against the most load-bearing oracle reading in the
protocol — the Chainlink WETH/USD numeraire that every
TWAP-derived asset price depends on. Per-asset redundancy keeps
working through the existing symbol-derived Tellor + API3 + DIA
secondary quorum, untouched.

**On-chain shape.** `OracleFacet._validatePythNumeraire` runs after
every Chainlink ETH/USD reading on the primary-price path. It reads
Pyth's snapshot of the same peg, normalises the `(price, expo)`
representation into Chainlink's decimal scale, and:

- Soft-skips (returns silently — Chainlink-only proceeds) when Pyth
  oracle is unset, the feed id is unset, the snapshot is older than
  `pythMaxStalenessSeconds`, the `conf / price` ratio exceeds
  `pythConfidenceMaxBps`, or the price is non-positive.
- Reverts `OracleNumeraireDivergence(chainlinkPrice, pythPrice,
  deviationBps, maxDeviationBps)` when the cross-oracle delta
  exceeds `pythNumeraireMaxDeviationBps`. Fail-closed by design — a
  numeraire reading the protocol can't agree on between two
  independent oracles is a strong signal that one of them is
  compromised; blocking is preferable to accepting a price the
  system itself can't trust.

**Five new governance knobs, all bounded.** Every Pyth tunable on
the new `OracleAdminFacet` surface is range-bounded so a compromised
admin or governance multisig cannot push it outside the policy
window without a contract upgrade:

| Knob | Range | Default |
|---|---|---|
| `pythOracle` (address) | non-zero contract / zero=disabled | unset |
| `pythNumeraireFeedId` (bytes32) | any non-zero / zero=disabled | unset |
| `pythMaxStalenessSeconds` | [60, 3600] | 300 |
| `pythNumeraireMaxDeviationBps` | [100, 2000] (1% – 20%) | 500 |
| `pythConfidenceMaxBps` | [50, 500] (0.5% – 5%) | 100 |

Out-of-range writes revert with the new shared
`ParameterOutOfRange(bytes32 name, uint256 value, uint256 min,
uint256 max)` error in `IVaipakamErrors`. The error name is a
short bytes32 tag identifying the parameter, so callers can
disambiguate the reverted setter without parsing free-form text.

**Project-wide setter range audit applied as a bonus.** While
adding the Pyth knobs, every existing governance-tunable numeric
parameter was audited and re-bounded where the prior guards were
weak or missing. Same `ParameterOutOfRange` error used throughout.
Specific changes:

| Setter | Prior bound | New bound | Reason |
|---|---|---|---|
| `setSecondaryOracleMaxDeviationBps` | (0, 9999) | [100, 2000] | Prior window was so wide it allowed degenerate settings (1bps DoS-fail-closes; 9999 disables the gate). Tightened to the same 1%-20% policy as Pyth. |
| `setSecondaryOracleMaxStaleness` | only `!= 0` | [60, 29h] | Prior had no upper — could be set arbitrarily high. 29h leaves 5h buffer above the 24h heartbeat that USDC / USDT Chainlink feeds publish on; tighter would soft-skip those legitimate feeds. |
| `setRewardGraceSeconds` | unbounded | [5min, 30 days] | Prior had no bounds. Floor stops "instant grace" misconfig; ceiling stops "indefinite grace" defeating the purpose. |
| `setInteractionCapVpfiPerEth` | unbounded | [1, 1M] | Prior had no bounds. Documented sentinels (`0` = reset to library default; `type(uint256).max` = emergency disable cap) preserved as escape paths. |
| `setStakingApr` | ≤ 100% | ≤ 20% | Prior allowed nonsensically-high APRs. 20% is generous for VPFI staking; above is governance-error vector. |
| `updateRiskParams.maxLtvBps` | (0, 10000] | [10%, 100%] | Prior `> 0` allowed `1`-bp setting that effectively disables borrowing for the asset. Floor of 10% is the credible minimum. |
| `updateRiskParams.liqThresholdBps` | (maxLtv, 10000] | [15%, 100%] AND > maxLtv | Same logic — added absolute floor on top of the existing relative-to-maxLtv constraint. |
| `updateRiskParams.reserveFactorBps` | ≤ 100% | ≤ 50% | Prior allowed `100% reserveFactor` = lender receives zero interest, defeats lending product. |
| `updateKYCThresholds` (tier0, tier1) | tier0 < tier1 only | each in [$100, $1M] | Belt-and-suspenders on retail (KYC OFF there); load-bearing on industrial fork. |

Most of these were tightenings of "loose-but-not-missing" bounds.
The truly-unbounded ones (`setRewardGraceSeconds`,
`setInteractionCapVpfiPerEth`) had been latent governance-attack
vectors the audit closed.

**New `/docs/ops/AdminConfigurableKnobs.md` runbook.** Functional /
no-code reference covering every governance-tunable knob and flag
in the Diamond. Auditor-facing — describes what each knob does,
what the operational range allows, and what the consequence would
be if a compromised admin pushed it to either extreme. Cross-
references the constants alongside their declarations in
`LibVaipakam.sol` so the source of truth is always one click away.

**Verification:**
- New `contracts/test/OracleNumeraireGuardTest.t.sol` — **10/10 green**.
  Below-floor + above-ceiling rejections on each of the three
  bounded Pyth setters; in-range happy writes; boundary-exact
  writes; default-fallthrough on the effective getters; non-owner
  reverts. The Pyth read-path divergence behavior is exercised
  indirectly through the bounded-setter assertions plus the
  existing OracleFacet read-path coverage in the regression suite
  (which now exercises the gate's soft-skip branch on every
  WETH-priced asset since Pyth defaults to unset post-init).
- Forge build clean. Full no-invariants regression:
  **1513 passing / 0 failed / 5 skipped** (up from 1503 pre-T-033 —
  +10 from `OracleNumeraireGuardTest` + +9 retrofitted existing
  tests now exercising the new bounded behavior with the
  `ParameterOutOfRange` error).

**Operational note for the redeploy.** Three new chain-level
governance writes per chain to enable the Pyth gate
(`setPythOracle`, `setPythNumeraireFeedId`, optionally tighten the
three bounded knobs from their defaults). Without these, the gate
is a no-op — protocol falls back to Chainlink-only on the WETH/USD
leg, identical to today's Phase 7b.2 behavior. So the change is
**zero-config-friendly**: the setter writes are additive; an
operator can roll out the upgrade and configure Pyth on a separate
day if they prefer.

## Notes for follow-up

The feat branch is now ~59 commits ahead of main (53 pre-existing
+ 1 T-037 + 1 merge commit + the 6 inherited from main, minus
overlaps). The eventual feat → main merge at the end of Range
Orders Phase 1 should be straightforward — most of the
recent-trunk-vs-feat conflict surface was DeployVPFIBuyAdapter,
which today's merge already reconciled.

**T-031 follow-ups deferred** (when volume justifies):
- **Layer 4a auto-pause** — wire a constrained pauser-multisig key
  into the watchdog so mismatch detection can preemptively call
  `receiver.pause()` instead of relying on the operator to act on
  the alert. Single-purpose key, gated to the `pause()` selector
  only, low quorum (e.g. 2-of-3 ops engineers).
- **Active co-signer (Layer 4b)** — Vaipakam-operated signing
  service co-signs every legitimate cross-chain message; receiver
  enforces an AND-gate of `(LZ DVN ∩ Vaipakam signature)` before
  minting. Strongest preventive defense short of zkLightClient
  proofs; deferred until cumulative bridged volume crosses ~$10M
  or a credible LZ DVN advisory lands.
- **zkLightClient state proofs** — receiver verifies a Merkle proof
  of source-chain ETH inflow before minting. Highest assurance,
  highest cost (~100K-500K gas + proof latency); reserved for
  Phase 2+.

## In-app logo routes to dashboard, not landing page

Previously: clicking the Vaipakam logo while the user was inside
the app (any `/app/...` route) sent them back to the public
marketing landing page. Returning users who had drilled into
`/app/loans/<id>` and tapped the logo expecting to "go up one
level to the dashboard" instead found themselves looking at
"Welcome to Vaipakam — sign up." Surprising and easy to misread as
a sign-out.

Now: the in-app logo routes to `/app` (the locale-aware dashboard
root). The public marketing navbar's logo behaviour is unchanged
— it still routes to `/`. The two navbars live in different
components (`Navbar.tsx` for marketing, the sidebar in
`AppLayout.tsx` for the in-app shell), so the change scoped
cleanly.

Side effect: the in-app sidebar no longer doubles as an "exit to
website" affordance. A separate "Exit to website" link can be
added near the bottom of the sidebar if user research shows
people miss it; for now the only feedback was the surprise of
landing back on marketing.

## T-041 — shared chain-indexer worker (offers, loans, activity, claimables)

The frontend's homepage and offer book both used to do a per-
browser scan of the Diamond's `eth_getLogs` history at page load
to build a list of active offers. On a busy chain (or a slow
public RPC like Sepolia's) the cold-load took 10-30 seconds; the
"how many offers are open right now?" hero card had to wait the
full scan. The fix is a shared, server-side cache.

A Cloudflare Worker (`hf-watcher`) now runs a chain indexer on
every cron tick:

- ONE `getContractEvents` scan per tick across the full event
  allow-list — offers, loans, VPFI history, claim events. A new
  domain added in a future phase costs zero extra RPC round trips
  per tick because every handler shares the same scan output.
- A single `kind='diamond'` cursor in D1 advances atomically per
  tick. No per-domain cursor → no chance of two domains drifting
  out of sync.
- Per-domain handlers persist to D1 tables: `offers`, `loans`,
  `activity_events`. Cross-domain reuse: when LoanInitiated fires,
  the loan row pulls asset metadata via JOIN from the matching
  offer row instead of re-fetching the offer struct from the
  chain.
- The `activity_events` ledger is the unified append-only feed
  consumed by the Activity page, the LoanTimeline component, and
  per-wallet history surfaces — every event from every domain
  lands in one table, so per-page filters are simple SQL queries
  (`?actor=X`, `?loanId=N`, `?kind=...`) instead of fan-out joins.
- Frontend hooks (`useIndexedActiveOffers`, `useIndexedActiveLoans`,
  `useIndexedLoansForWallet`, `useIndexedActivity`,
  `useIndexedClaimables`, `useOfferStats`) all return a `source`
  field that flips between `'indexer'` and `'fallback'`. On any
  worker error / timeout / `VITE_HF_WATCHER_ORIGIN` unset, the
  consumer falls through to the existing per-browser
  `lib/logIndex.ts` scan. The worker is a CACHE, not an oracle —
  decentralization is preserved end to end. Every offer card will
  carry a "verify on-chain" affordance that triggers a direct
  Diamond read regardless of indexer state.

REST surfaces (open CORS — public reads, no auth-relevant data):

- `/offers/stats` — aggregate counts (active / accepted /
  cancelled / total). Sub-100ms response. Powers homepage hero +
  offer-book preloader.
- `/offers/active`, `/offers/:id`, `/offers/by-creator/:addr` —
  paginated newest-first cursor pages of cached offer rows.
- `/loans/active`, `/loans/:id`, `/loans/by-lender/:addr`,
  `/loans/by-borrower/:addr` — same shape for the loan-side
  surface (Dashboard "Your Loans," Risk Watch, Analytics).
- `/activity?actor=X&loanId=N&offerId=N&kind=K&before=block:logIndex`
  — the unified ledger, paginated by `(block, logIndex)` so a
  cron-deferred boundary block can never drop rows.
- `/claimables/:addr` — Phase E view that joins loans +
  activity_events to return open lender-side and borrower-side
  claim opportunities (terminal status, no matching
  `*FundsClaimed` event yet). Replaces the per-browser scan that
  the Claim Center used to run on cold-load.

The OfferBook page is the first consumer migrated. When the
worker returns active offers, the page renders them directly and
skips its existing per-id `getOfferDetails` pagination; on
fallback the existing flow runs unchanged. The browser's
`watchContractEvent` listener stays running regardless of source
so a freshly created offer surfaces within seconds of the
matching tx confirming.

Out of scope for this drop, deferred to follow-ups:
- Phase C — NFT lifecycle table (current-owner-by-tokenId for the
  position NFT). Smaller surface, separate state cache; today's
  NftVerifier hits the chain directly with `ownerOf`, which is
  fine at current volumes.
- Deep dual-source migration of Dashboard / ClaimCenter /
  VPFIPanel — these consumers track current NFT ownership via
  `useLogIndex` Transfer-event scanning. The indexer's
  lender/borrower columns reflect LoanInitiated state, not who
  currently holds the position NFT, so a full swap to the
  indexer-fed path waits for Phase C.

## T-041 follow-up — multi-chain fan-out, lag badge, single verify affordance

Three follow-up decisions landed in the same commit window:

**Multi-chain fan-out.** The chain indexer now loops over every
chain in `getChainConfigs(env)` per cron tick — Base + Ethereum +
Arbitrum + Optimism + Polygon zkEVM + BNB on the mainnet meta
list, plus Base Sepolia + Sepolia + Arb Sepolia + OP Sepolia +
Polygon Amoy + BNB Testnet on the testnet meta list. A chain is
silently skipped when either the `RPC_*` secret or the
`deployments.json` entry is missing, so adding a chain is purely
operator-side: set the secret, deploy the diamond, the next cron
picks it up. Single Worker for now per the user's call; future
horizontal scaling = one Worker per chain (no schema changes
needed — `chain_id` PK already keys every table).

**Visible "indexer lag" badge.** New
`components/app/IndexerStatusBadge.tsx` renders inline next to
every page title that reads cached data — OfferBook, Activity,
Dashboard, ClaimCenter, LoanDetails, BuyVPFI. Two states:
- **Cached** (worker reachable): green pill showing
  "Indexed 2 min ago" with a Rescan button. Ticks once per minute
  in-place. Click Rescan to force a per-browser on-chain scan
  (calls the page's existing `reloadIndex` / `loadLoan` /
  `reload` callback, which goes back to the chain bypassing the
  cache).
- **Live** (worker unreachable / no cache yet): amber pill
  showing "Live chain scan" with a tooltip explaining "pages may
  load slower but all data is live."

The badge surfaces the cache-age contract that was previously
invisible — without it, users couldn't tell whether they were
looking at fresh state or a 5-minute-old snapshot. Modeled on
Etherscan's "Last block: 3s ago" pill.

**Single verify-on-chain affordance.** The original spec called
for a per-row "verify on-chain" button on every offer / loan
card. After surveying what major DEXes do (Uniswap, Aave,
OpenSea, Blur, dYdX v4, Aster), none of them ship per-row verify
affordances — it's overkill. Replaced with a single
"Verify on-chain" link in the in-app footer
(`AppLegalFooter.tsx`) that opens the active chain's Diamond
contract on the block explorer in a new tab. Users who want to
audit a specific record paste its ID into the explorer's
read-contract UI — same workflow Etherscan / Basescan already
expose, no custom UI needed. The public marketing footer's
existing `ChainPicker → "View Diamond on explorer"` carries the
same affordance for unconnected visitors.

## T-041 Phase C-alt — live `ownerOf` for current NFT holders

The original Phase C plan called for a `nft_positions` table that
tracked the position NFT's current owner by indexing every
`Transfer` event. Replaced with a cleaner pattern at the user's
suggestion:

> **State goes to RPC, history goes to D1.**

The `loans` table keeps **immutable origination data** (lender at
init, borrower at init, token IDs, interest rate, start time —
all stamped at LoanInitiated, never updated). For "who currently
owns this NFT?" the worker calls `ownerOf(tokenId)` directly
against the chain at query time. No `nft_positions` table, no
Transfer-event-driven row updates, no re-org window, no
maintenance — `ownerOf` is a single SLOAD against the current
state root, flat cost regardless of chain history depth.

**Schema additions (migration 0006):**

`loans.lender_token_id`, `loans.borrower_token_id`,
`loans.interest_rate_bps`, `loans.start_time`,
`loans.allows_partial_repay` — all populated once per loan via a
`getLoanDetails(loanId)` bootstrap call after LoanInitiated.
After the bootstrap fires, all values are immutable; the next
indexer tick filters bootstrapped rows out of the work queue
via `WHERE lender_token_id = '0'`. Per-loan one-time RPC cost.

**Live-ownership rewire on three endpoints:**

- `/loans/by-lender/:addr` — pulls every loan with bootstrapped
  token IDs, fans out a multicall(`ownerOf`, lender_token_id) per
  row, filters to wallet matches.
- `/loans/by-borrower/:addr` — same for the borrower side.
- `/claimables/:addr` — multicalls BOTH lenderTokenId and
  borrowerTokenId per terminal-status loan, joined against
  `activity_events` to exclude already-claimed positions.

A wallet that **bought a position NFT secondary** now correctly
surfaces in the buyer's by-lender / by-borrower / claimables
views — and a wallet that **sold its position NFT** stops seeing
the loan in their list. No staleness window. No re-org risk on
ownership state.

**Audit trail via `activity_events`:**

ERC-721 `Transfer` events are now in the chain indexer's event
allow-list. They land in the unified `activity_events` ledger
automatically — same row shape as every other event — so the
public ownership history of any tokenId is queryable via
`/activity?kind=Transfer&...`. No separate `nft_positions` table
needed; the events ledger IS the audit trail.

**Dashboard migration:**

Dashboard's "Your Loans" card is the first consumer migrated. New
adapter `indexedToLoanSummary(IndexedLoan, role)` shape-bridges the
indexer JSON to the existing `LoanSummary` rendering type. When
indexer source is live, the page renders directly from the
worker's response — no per-loan `getLoanDetails` multicall, no
per-loan `ownerOf` probe in the browser. When the worker is
unreachable, the existing `useUserLoans` flow runs unchanged.
Role on each loan comes from which endpoint produced it
(by-lender → 'lender', by-borrower → 'borrower') — the worker
already live-filtered via `ownerOf`, so the role reflects current
on-chain ownership.

**Two surfaces intentionally stay direct-from-chain (by design, not as TODOs):**

The chain indexer accelerates list-style reads (offer book,
loan list, activity feed, dashboard) where first-paint speed
matters and per-row truth is recoverable via the manual rescan +
verify-on-chain footer link. The two surfaces below are
deliberately exempt:

- **ClaimCenter** — money-relevant state. The page renders
  `ClaimableEntry[]` with full per-claim payload (asset, amount,
  tokenId, quantity, heldForLender, hasRentalNFTReturn,
  lifRebate). Reading these from a 5-min-stale cache could
  surface "Claim 100 USDC" while the chain only owes 50 USDC —
  the kind of mis-render that erodes trust on the surface where
  trust matters most. ClaimCenter stays on `useClaimables` —
  every page load, every browser, fresh `getClaimable(loanId,
  isLender)` reads against the chain. The indexer's
  `/claimables/:addr` endpoint exists and is correct (it tells
  CALLERS which loans have open claims, ownership-filtered via
  live `ownerOf`); ClaimCenter just doesn't consume it because
  the per-loan claim PAYLOAD comes from the chain regardless.
- **VPFIPanel** — low-volume per-user history. The panel renders
  ERC-20 `Transfer` events on the VPFI token contract, scoped
  to the current wallet via topic filters. A typical user has
  10-50 transfers in their lifetime — not thousands — so a
  single filtered `eth_getLogs` is cheap and burns no
  meaningful RPC quota. Adding the VPFI token contract as a
  second indexer scan target would add complexity for a
  negligible speedup, and the protocol-side VPFI events that
  ARE in `activity_events` (`VPFIDepositedToEscrow`,
  `VPFIWithdrawnFromEscrow`, `VPFIPurchasedWithETH`) cover the
  protocol-relevant slice already.

**The emergent architectural principle**: high-stakes state
reads truth from the chain on every render; high-volume
list-style data reads from the cache with manual-rescan and
verify-on-chain escape hatches; low-volume per-user history
stays as direct filtered scans.

**Why no Durable Objects / WebSocket push.** The cron-tick
staleness window only matters for *cold-load* freshness. Once a
user is on a page, `useLogIndex.watchContractEvent` already
debounces 750 ms after relevant events fire and triggers an
incremental rescan from `lastBlock+1` — sub-second user-perceived
latency on every offer / loan / activity update. The worker's
job is only to make first-paint fast; pushing real-time updates
isn't necessary because the browser is already event-driven via
RPC subscriptions. Dropping push reduces the architecture to one
moving part (cron) instead of two (cron + WebSocket subscribers).
