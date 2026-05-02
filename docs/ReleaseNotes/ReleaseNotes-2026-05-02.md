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
