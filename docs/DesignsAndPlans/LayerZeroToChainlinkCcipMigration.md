# LayerZero → Chainlink CCIP Migration — Design (T-068)

**Card:** T-068 · **Issue:** [#5](https://github.com/vaipakam/vaipakam/issues/5)
**Status:** design — pre-implementation, pre-mainnet.

## 1. Context

Vaipakam's entire cross-chain layer runs on **LayerZero** — five contracts
(§3). LayerZero's security is the *integrator's* responsibility: you choose
and configure a DVN set, and DVNs beyond the defaults are self-hosted or
contracted from third parties. The protocol shipped an insecure default
(1-required / 0-optional DVN).

In **April 2026** that default was exploited: the Kelp DAO bridge lost
**~$292M** of rsETH — a single-verifier (1/1 DVN) config let an attacker
get a forged cross-chain message accepted. ~47% of LayerZero apps ran the
same config. A migration wave followed — Kelp, Solv, Re, Lombard, Kraken —
**~$4B of assets moved to Chainlink CCIP** within weeks.

**Decision (operator):** migrate Vaipakam's cross-chain layer to **Chainlink
CCIP**. CCIP's security is *operated by Chainlink* — a committing DON + an
executing DON + an independent **Risk Management Network** (separate
codebase, separate operators) + **per-lane rate limits** — uniform for every
integrator, with no insecure default and **no DVN fleet to run**. The
trade-off — minutes of finality-bound latency — is acceptable for VPFI
token movement and reward accounting (neither is latency-sensitive). See the
T-068 discussion thread for the full rationale.

**Timing — this is done pre-mainnet.** Vaipakam has not launched cross-chain
on mainnet, so there are **no live assets to strand** (the exact problem
that made Kelp's 20-chain situation unrecoverable). This is the cheapest
this migration will ever be.

## 2. Goals / non-goals

**Goals**
- Replace the 5 LayerZero OApps/OFTs with Chainlink CCIP equivalents.
- Adopt CCIP's **Cross-Chain Token (CCT)** standard for VPFI.
- Build the integration behind a **modular adapter seam** (ports & adapters)
  so a future provider swap is *contained*, not spread through the codebase
  — this directly addresses the T-081 audit finding that LayerZero was one
  of only two *deeply-integrated* third-party dependencies.
- Preserve the buy economics, the caps, and the reward-accounting math
  exactly — this is a transport swap, not a behaviour change.

**Non-goals**
- **No Diamond facet logic changes.** The Diamond is already decoupled — it
  references OApp *addresses* and plain `uint32` chain ids, never a
  LayerZero type. Migration rotates those addresses; facet code is untouched.
- **No generic multi-provider runtime framework.** Modularity here means a
  *contained* swap (a handful of adapter files), not a runtime plugin system.
  YAGNI — one provider, one clean boundary.
- No change to the fixed buy rate, caps, or numeraire math.

## 3. Current LayerZero architecture (what we replace)

Five UUPS-upgradeable **standalone** contracts (none are Diamond facets);
all carry `LZGuardianPausable` (guardian + owner emergency pause):

| Contract | Chain | LZ base | Role |
| --- | --- | --- | --- |
| `VPFIOFTAdapter` | Base (canonical) | `OFTAdapter` | Lock / unlock — wraps the canonical VPFI ERC20 |
| `VPFIMirror` | each non-Base chain | `OFT` | The mirror VPFI token itself; burn out / mint in |
| `VPFIBuyAdapter` | each non-Base chain | `OApp` + `IOAppComposer` | Cross-chain fixed-rate buy entry point |
| `VPFIBuyReceiver` | Base only | `OApp` | Buy hub — mints via the Diamond, routes VPFI back |
| `VaipakamRewardOApp` | every chain | `OApp` | Reward accounting — REPORT (mirror→Base) + BROADCAST (Base→mirrors) |

**Token model.** VPFI is canonical on Base (a real ERC20, 230M cap). The
`VPFIOFTAdapter` locks/unlocks it; `VPFIMirror` on every other chain is a
burn/mint OFT with **no admin mint surface** — it only mints via an
authenticated inbound message. Global supply = canonical locked + mirror
minted.

**Buy flow (today).** A user on a mirror chain calls `VPFIBuyAdapter.buy()`,
which locks ETH / bridged-WETH **on the source chain** (in the adapter,
keyed by `requestId` in `pendingBuys`) and sends a `BUY_REQUEST` to the Base
`VPFIBuyReceiver`. The receiver calls `Diamond.processBridgedBuy` — which
mints VPFI at the fixed rate (`vpfiFixedRateWeiPerVpfi`, default 1e15 wei =
0.001 ETH/VPFI, ADMIN-settable) and debits the global + per-wallet caps —
then **OFT-composes the VPFI back to the source-chain `VPFIBuyAdapter`
contract — not the buyer's wallet**. The adapter's compose handler
cross-checks the `requestId` against its own `pendingBuys` record, and only
then transfers VPFI to the recorded buyer and releases the locked payment to
treasury. (The "T-031 Layer 2 hardening" — see §5.)

**Reward flow (today).** `VaipakamRewardOApp` carries two message kinds:
REPORT (a mirror Diamond's daily lender/borrower numeraire totals → Base)
and BROADCAST (Base's finalized global denominator → every mirror).

**Coupling — already shallow.** LayerZero types (`Origin`, `MessagingFee`,
`OFTComposeMsgCodec`, `IOFT`, …) appear **only** in these 5 contracts and
the deploy scripts. The Diamond facets (`VPFIDiscountFacet`,
`RewardReporterFacet`, `RewardAggregatorFacet`) take a plain `uint32` eid
and call OApp addresses through interfaces. So the migration's blast radius
is the 5 contracts + scripts — **not the Diamond**.

## 4. Target CCIP architecture

### 4.1 The adapter seam (modularity)

Ports & adapters. Two seams, because the cross-chain layer is two concerns:

**Messaging seam.** An internal interface — `ICrossChainMessenger` —
expressed entirely in **Vaipakam's own types**: a Vaipakam chain id, a plain
`bytes` payload, an optional token-amount list, a `sendMessage(...)` and a
receive callback. **No CCIP type ever crosses this interface.** A single
`CcipMessenger` adapter implements it — the *only* contract that imports
CCIP (the `IRouterClient`, `Client.EVM2AnyMessage`, chain selectors, the
`CCIPReceiver` base, the sender allowlist). All business logic — buy,
reward — calls `ICrossChainMessenger` and never knows CCIP exists.

**Token seam (CCT).** VPFI is kept as a plain mint/burn ERC20 — provider-
agnostic. CCIP's **TokenPool** is the adapter:
- Base: a `LockReleaseTokenPool` — a thin Vaipakam subclass — wrapping the
  canonical VPFI ERC20.
- Each mirror: a `BurnMintTokenPool` — a thin Vaipakam subclass — over a
  plain mirror VPFI ERC20.

The pools are *thin subclasses* of the stock CCIP pools so they can add a
**bounds-checked, admin→governance rate-limit setter** (§10 #2) without
forking CCIP's audited pool logic.

*Why Base is the canonical chain.* The canonical chain hosts VPFI's
reservoir and the buy hub — every cross-chain buy round-trips to it, and
CCIP's fee (paid once by the user on the source chain) **embeds the gas to
execute on the destination chain**. A canonical chain on Ethereum L1 would
bake L1 gas into every cross-chain VPFI fee and every hub mint; on Base (an
L2) those are ~2–3 orders of magnitude cheaper. Base is therefore canonical
for cost. VPFI keeps a first-class presence on Ethereum L1 — as a *mirror* —
so L1 liquidity / composability is not lost.

CCT separates *token* from *pool* by design — modularity is built in: a
future provider swap deploys new pools; the VPFI token contracts are
untouched.

**The one hard rule:** no domain contract imports a CCIP library; CCIP types
never appear in `ICrossChainMessenger`. If they leak, the abstraction is
fake. A future swap = rewrite `CcipMessenger` + the pools, redeploy,
re-configure lanes — the buy logic, reward logic and VPFI token are
untouched.

### 4.2 Contract-by-contract mapping

| LayerZero (today) | CCIP (target) |
| --- | --- |
| `VPFIOFTAdapter` (Base lock/unlock) | VPFI **`LockReleaseTokenPool`** on Base (CCT) |
| `VPFIMirror` (token + OFT logic fused) | **split** → plain mirror VPFI ERC20 **+** a **`BurnMintTokenPool`** (CCT) |
| `VPFIBuyAdapter` (OApp) | `VpfiBuyAdapter` — business logic only; calls `ICrossChainMessenger` |
| `VPFIBuyReceiver` (OApp) | `VpfiBuyReceiver` — business logic only; calls `ICrossChainMessenger` |
| `VaipakamRewardOApp` (OApp) | `VaipakamRewardMessenger` — business logic only; calls `ICrossChainMessenger` |
| — | **NEW** `ICrossChainMessenger` — the port (Vaipakam types only) |
| — | **NEW** `CcipMessenger` — the adapter (the only CCIP-aware contract) |

`LZGuardianPausable` and the UUPS-upgradeable pattern carry over unchanged.

## 5. The buy flow under CCIP — and the two-step release

The operator asked whether the **two-step release** (VPFI delivered to a
holding adapter, released to the buyer only after a local cross-check) is
still needed under CCIP, since it looks like "two transactions."

**Verified — and the recommendation is to KEEP it.** Reasoning:

The two-step encodes a provider-independent principle: **the protocol's own
authoritative state — never the inbound cross-chain message — decides where
value goes.** VPFI always lands at the `VpfiBuyAdapter`; the adapter
releases it only against a local `pendingBuys[requestId]` record it itself
originated. A forged or replayed delivery for an unknown `requestId` is
parked as "stuck", not sent anywhere.

This is **not** an extra cross-chain transaction. CCIP supports
**programmable token transfers** — tokens *and* data in a single message.
So the buy flow stays **two cross-chain legs** (the same as today):

1. **Leg 1 — `BUY_REQUEST` (source → Base), data only.** `VpfiBuyAdapter`
   locks the user's ETH/WETH on the source chain, sends a data-only CCIP
   message to `VpfiBuyReceiver` on Base.
2. **Base — mint.** `VpfiBuyReceiver` calls `Diamond.processBridgedBuy`
   (fixed-rate mint + cap debit) — unchanged.
3. **Leg 2 — VPFI delivery (Base → source), tokens + data in ONE message.**
   `VpfiBuyReceiver` sends a CCIP **programmable token transfer**: the VPFI
   *and* the `requestId` data, addressed to the source-chain
   `VpfiBuyAdapter`.
4. **Source — local release.** The adapter's `ccipReceive` cross-checks
   `requestId` against its own `pendingBuys`, then transfers VPFI to the
   recorded buyer and releases the locked payment to treasury.

Step 4's "second step" is a **cheap local transfer** inside `ccipReceive` —
not a second cross-chain leg. So keeping the guard costs almost nothing.

Why keep it under CCIP specifically:
- **Defense in depth.** CCIP's RMN + rate limits make a *forged* message far
  less likely than LayerZero's weak-DVN case — but CCIP is still a trust
  assumption (DON + RMN operators). The guard means even a CCIP-verification
  compromise, or a bug in `VpfiBuyReceiver`, cannot drain VPFI to an
  arbitrary address.
- **Replay protection** — a re-delivered `requestId` is caught locally.
- **Blast-radius cap** — CCIP's per-lane rate limit is an *additional*
  backstop the LayerZero design never had natively.

The **primary** forgery guard under CCIP is the **sender allowlist**:
`ccipReceive` rejects any message whose source chain selector + source
sender address is not the allowlisted peer `VpfiBuyReceiver`. This is the
CCIP equivalent of LayerZero's peer registry. The two-step is the
*secondary* guard.

**Net:** keep the two-step. It is cheap, provider-independent, and the right
posture for a protocol moving real value.

## 6. The reward flow under CCIP

`VaipakamRewardMessenger` sends REPORT / BROADCAST as **data-only** CCIP
messages via `ICrossChainMessenger`. The REPORT (mirror → Base) and
BROADCAST (Base → every mirror, one message per destination) keep their
payload shape and the Diamond callbacks (`onChainReportReceived`,
`onRewardBroadcastReceived`) unchanged. The 128-byte payload-size pin and
the sender-allowlist check carry over.

## 7. Security model

- **CCIP RMN** — an independent network re-verifies ("blesses") every
  committed message; can halt a lane. No integrator config.
- **Per-lane rate limits** — a hard value/time cap per lane: even a
  worst-case verification failure cannot drain more than the limit. (Today
  Vaipakam bolts a manual cap onto `VPFIBuyAdapter`; CCIP gives it natively.)
- **Sender allowlist** — every `ccipReceive` validates `msg.sender ==
  ccipRouter`, the source chain selector, and the source sender address
  against the allowlisted peer. Primary forgery guard.
- **Two-step buy release** (§5) — secondary guard; value destination decided
  by local authoritative state.
- **Pause** — `LZGuardianPausable` carries over (renamed); every CCIP-facing
  contract keeps owner + guardian emergency pause on send and receive.
- **Finality** — CCIP waits for source-chain finality before delivery
  (~15 min on Ethereum, faster on L2s). This is the security; accepted.

## 8. Surface deleted

The migration *removes* security-config surface:
- `ConfigureLZConfig.s.sol` (DVN sets, libraries, confirmations per
  (OApp, eid)), `WireVPFIPeers.s.sol`, `SetBuyOptions.s.sol`, `LZConfig.t.sol`.
- The "Cross-Chain Security Policy (DVN + Pause)" section of `CLAUDE.md` /
  `contracts/README.md` — the 3+2 DVN policy, the per-operator diversity
  rules, the mainnet-deploy DVN gate.

Replaced by: CCIP **lane configuration** (enable lanes, set per-lane rate
limits) + token-pool registration. The RMN is automatic — nothing to
configure. Net: **less** security-critical config code to write, audit and
maintain.

## 9. Phasing

Each phase: build + unit-test (mock `ICrossChainMessenger`) → testnet deploy
+ lane config → cross-chain flow test → next.

| Phase | Scope |
| --- | --- |
| 0 | This design ratified; verify CCIP lane availability for every Vaipakam chain (§10). |
| 1 | The seam — `ICrossChainMessenger` + `CcipMessenger` + a `MockMessenger` for tests. |
| 2 | VPFI as a CCT — `LockReleaseTokenPool` (Base) + `BurnMintTokenPool` + plain mirror ERC20; register pools; bridge-parity test. |
| 3 | Buy flow — `VpfiBuyAdapter` + `VpfiBuyReceiver` on the seam; the §5 two-step. |
| 4 | Reward flow — `VaipakamRewardMessenger` on the seam. |
| 5 | Deploy scripts: replace the LZ wiring scripts with CCIP lane/pool config; delete the LZ apparatus (§8); ABI + deployments re-export. |
| 6 | Full cross-chain rehearsal on testnets; then the mainnet cutover plan. |

All of this lands **before** the mainnet cross-chain launch.

## 10. Open decisions

1. **CCIP lane availability** — RESOLVED (operator, 2026-05-18). The
   cross-chain chain set is **Ethereum, Base, Arbitrum, Optimism, BNB** — all
   well-supported CCIP lanes. zk-rollup chains (Polygon zkEVM, zkSync) are
   **excluded by operator decision** — Vaipakam will not use zk chains — so
   no zkEVM lane check is needed.
2. **Per-lane rate-limit values** — RESOLVED (operator, 2026-05-18). Each
   CCIP TokenPool lane carries a token-bucket limiter — `capacity` (max
   burst) + `rate` (refill/sec), inbound and outbound per lane. Starting
   values: **`capacity = 50,000 VPFI`, `rate ≈ 5.8 VPFI/s`** (≈ 500,000
   VPFI/day) — mirroring the buy adapter's existing manual caps. These values
   are **admin-configurable, governance-later, and range-bounded** by
   compile-time `MIN_/MAX_` constants per the protocol's config-knob-bounds
   standard (ET-008) — implemented via a thin Vaipakam `TokenPool` subclass
   exposing a bounds-checked rate-limit setter (exact override/wrap mechanism
   settled in Phase 2). Conservative start; raise once real volume data
   exists.
3. **CCT token-admin role** — RESOLVED (operator, 2026-05-18). The CCT admin
   (CCIP's `TokenAdminRegistry` entry — the role that registers and
   configures VPFI's pools) follows the protocol's standard governance
   phasing: the **admin multisig** initially, handed to
   **`VaipakamTimelock` / governance** later — the *same* governance entity
   that owns every other protocol knob, never a separate key.
4. **Mirror VPFI ERC20** — `VPFIMirror` today fuses token + OFT logic;
   splitting it into a plain ERC20 + a pool means the mirror VPFI token
   address changes. Pre-mainnet there are no holders, so this is free — but
   confirm no testnet state depends on the current mirror address.
5. **Reward messenger** — RESOLVED (operator, 2026-05-18). **One shared
   `CcipMessenger`** for both buy and reward messaging, dispatching inbound
   by message kind — a single seam, one contract that touches CCIP.

All §10 decisions are now resolved — the design is ratified and ready for
Phase 1.

## 11. Out of scope

- Diamond facet changes — none needed (§2).
- A runtime multi-provider framework — explicitly rejected (§2).
- Non-EVM chains (Solana etc.) — out of all phases, as today.
