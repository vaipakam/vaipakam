# Vaipakam — Pre-Mainnet Deploy Runbook

**Status gate.** This runbook is the single source of truth for everything
that MUST happen between "smart contracts pass all tests on fork" and "real
users can route real value through the protocol." Every step below is a hard
prerequisite. Skipping one is a security regression, full stop.

**Scope.** Applies to mainnet deploys on Ethereum, Base, Arbitrum, Optimism,
Polygon zkEVM, and BNB Chain (Phase 1 chain scope — Polygon PoS and Solana
are out of Phase 1; see
[`contracts/README.md`](README.md#cross-chain-security-mandatory-pre-mainnet-hardening)).

---

## 0. Before you start

- External security audit is **complete** and all findings are addressed or
  accepted. Audit reports archived in `audits/`.
- Timelock + multisig (Gnosis Safe recommended) deployed on each target
  chain. Signer set and threshold agreed with the team.
- Off-chain monitoring (see §9) is stood up and firing test alerts.
- Cloudflare Pages / frontend hosting is configured on a domain you control
  with valid TLS and HSTS. Env vars populated per
  [`frontend/src/contracts/config.ts`](../frontend/src/contracts/config.ts).

If any of the above is not true, **do not proceed**.

---

## 1. Deployment environment

Each deploy host must have:

- Foundry toolchain (`forge --version` ≥ 1.0).
- Node ≥ 20.x + npm ≥ 10 for frontend build.
- Network access to the target chain's RPC endpoints (list per chain).
- Broadcasting key (`PRIVATE_KEY` env) that is **NOT** the long-term owner.
  Use a throw-away deployer key held only for the duration of the run;
  rotate ownership to the timelock in §6.

**Secrets never checked in. Never printed to logs. Use `.env.local` +
`source` from outside the repo, or a proper secret manager.**

### Required env vars (populate from `.env.local` per chain)

Cross-referenced against the deploy scripts in `contracts/script/` and
[`frontend/src/contracts/config.ts`](../frontend/src/contracts/config.ts).

```bash
# Broadcaster (deployer key — rotate away from it in §6)
PRIVATE_KEY=0x…

# Per-chain RPC (one per chain you target)
ETHEREUM_RPC_URL=…
BASE_RPC_URL=…
ARBITRUM_RPC_URL=…
OPTIMISM_RPC_URL=…
POLYGON_ZKEVM_RPC_URL=…
BNB_RPC_URL=…

# Deployer + admin signing keys — both are EOAs during a fresh
# rehearsal; on mainnet the admin equivalent is a multisig batch (see
# the cutover runbook). The deployer key holds the deploy + ownership
# handover; the admin key runs ConfigureCcip after every chain in the
# deployment has been deployed.
DEPLOYER_PRIVATE_KEY=0x…  # read by DeployCrosschain.s.sol
ADMIN_PRIVATE_KEY=0x…     # read by ConfigureCcip.s.sol
ADMIN_ADDRESS=0x…         # the admin EOA's address — read by
                          # DeployCrosschain.s.sol as the post-deploy
                          # owner-transfer target.

# Treasury (Diamond-managed; deployer-controlled multi-sig on mainnet)
TREASURY_ADDRESS=0x…      # read by DeployCrosschain.s.sol (canonical
                          # chain only — wired into VpfiBuyReceiver
                          # as the VPFI funding source).

# Chainlink CCIP wiring (post-T-068, 2026-05-18)
# Per-chain Router + RMN proxy + TokenAdminRegistry addresses from
# https://docs.chain.link/ccip/directory
CCIP_ROUTER=0x…                         # this chain's CCIP Router
CCIP_RMN_PROXY=0x…                      # this chain's RMN proxy
                                        # (Risk Management Network endpoint)
CCIP_TOKEN_ADMIN_REGISTRY=0x…           # this chain's TokenAdminRegistry
CCIP_REGISTRY_MODULE_OWNER_CUSTOM=0x…   # CCIP owner-based CCT registrar

# Per-chain lane set: comma-separated EVM chain ids of every REMOTE
# chain to wire a CCIP TokenPool lane to (mirrors connect to Base;
# Base connects to every mirror).
CCIP_LANE_CHAIN_IDS=11155111,421614,…

# Mirror chains also need the canonical Base chain id (the hub).
BASE_CHAIN_ID=8453  # mainnet; 84532 on Base Sepolia

# Optional overrides (defaults set inside the scripts).
CCIP_GUARDIAN=             # incident-response guardian; default unset → skipped
CCIP_RATE_CAPACITY=        # per-lane token-bucket capacity; default 50,000 VPFI
CCIP_RATE_REFILL=          # per-lane refill rate, VPFI/s; default ~5.8 VPFI/s
CCIP_DEST_GAS_LIMIT=       # CCIP message dest-gas limit; default 400,000
VPFI_BUY_PAYMENT_TOKEN=    # mirror-chain buy-adapter payment token;
                           # 0x0 ⇒ native gas (Ethereum / Base / Arbitrum /
                           # Optimism / Polygon zkEVM + their testnets);
                           # bridged WETH9 address ⇒ WETH-pull (BNB Chain
                           # mainnet, Polygon PoS mainnet). See CLAUDE.md
                           # § "VpfiBuyAdapter — payment-token mode by chain."
VPFI_BUY_REFUND_TIMEOUT=   # seconds before stuck buys can be refunded;
                           # default 900 (15 min)
CHAIN_ID=                  # override block.chainid (rarely needed)
```

---

## 2. Deploy order per chain

All forge scripts live in `contracts/script/`. Run per-chain, in this
order. **Never parallelise across chains without a consistency
plan** — the CCIP lane + channel-peer wiring in §4 depends on the
addresses written by §2.1's deployment artifacts on every chain.

### 2.1 Cross-chain stack (every chain): `DeployCrosschain.s.sol`

```bash
forge script script/DeployCrosschain.s.sol \
  --rpc-url $<CHAIN>_RPC_URL --broadcast --verify
```

Per-chain, branches on `block.chainid ∈ {8453, 84532}` = canonical:

- **Canonical (Base)**: deploys `VPFIToken` (`ERC20Capped` 230M) +
  the stock CCIP `LockReleaseTokenPool` over it + `VpfiBuyReceiver` +
  `CcipMessenger` + `VaipakamRewardMessenger` + `VpfiPoolRateGovernor`.
- **Mirrors**: deploys `VPFIMirrorToken` (proxy) + stock CCIP
  `BurnMintTokenPool` + `VpfiBuyAdapter` + `CcipMessenger` +
  `VaipakamRewardMessenger` + `VpfiPoolRateGovernor`. Mirror token
  supply is driven by the BurnMintPool; no independent minter
  surface.

Owner of every proxy = `VPFI_OWNER` (multisig → timelock at mainnet
per the cutover runbook).

### 2.2 Diamond deploy (every chain)

Follow the existing Diamond deploy procedure (see
[`contracts/README.md#repository-layout`](README.md)). Set `vpfiToken`
to the mirror (or canonical token on Base) post-deploy via
`AdminFacet.setVPFIToken`.

---

## 3. Verification gate

After the above, for every chain, confirm:

- All proxies' owner is `VPFI_OWNER` / `REWARD_OWNER` (the timelock).
- Block explorers have verified source for every contract.
- Each contract's runtime bytecode matches the compiled artifact. Use
  `cast code` and diff against local `out/`.

---

## 4. Wire CCIP — `ConfigureCcip.s.sol`

After `DeployCrosschain.s.sol` has run on every chain in the deployment,
run `ConfigureCcip.s.sol` on each chain (idempotent — re-runs are safe).
It wires four things in one pass:

- **`CcipMessenger`**: chainId ↔ CCIP selector, the remote-messenger
  allowlist, the `vpfi-buy` + `vpfi-reward` channels (local handler +
  remote peers), the guardian.
- **VPFI CCIP `TokenPool`**: accepts the pending ownership handover
  from the deployer, registers `VpfiPoolRateGovernor` as
  `rateLimitAdmin`, adds a lane per remote chain
  (`applyChainUpdates`), then sets each lane's rate limits through
  the bounds-checked governor.
- **Registers** the VPFI token + its pool in the CCIP
  `TokenAdminRegistry` (CCT enablement).
- **Canonical-only**: sets `VaipakamRewardMessenger.setBroadcastDestinations`
  (the mirror chain-id list the daily reward broadcast fans out to).
- **Mirror-only**: `VPFIMirrorToken.setTokenPool(burnMintPool)`,
  pointing the mirror VPFI at its Burn/Mint pool.

```bash
CCIP_LANE_CHAIN_IDS=11155111,421614,… \
  forge script script/ConfigureCcip.s.sol \
    --rpc-url $<LOCAL>_RPC_URL --broadcast -vvv
```

Channel topology is hub-and-spoke (the `vpfi-buy` and `vpfi-reward`
channels always pair a mirror with canonical Base, never
mirror ↔ mirror). The TokenPool **lane** topology, by contrast, is
whatever `CCIP_LANE_CHAIN_IDS` lists — pass Base-only on each mirror
for a hub-spoke token graph, or the full chain set for a full mesh
(direct mirror ↔ mirror VPFI transfers).

---

## 5. Security: Risk Management Network + per-lane rate limits

**T-068 (2026-05-18) removed the operator-configurable verifier
hardening step.** Under Chainlink CCIP the security model is
**operated by Chainlink**: a committing DON + an executing DON +
an **independent Risk Management Network** (RMN, a separate codebase
and operator set) that re-verifies every message — uniform for
every integrator. There is no DVN fleet to assemble per-integrator,
and no "1-required / 0-optional default" footgun reachable by
configuration mistake.

The operator-visible defence-in-depth that DOES need to be wired
runs through §4's `ConfigureCcip.s.sol`:

- **Per-lane rate limits** on every VPFI TokenPool via
  `VpfiPoolRateGovernor` (capacity 50,000 VPFI, refill ≈5.8 VPFI/s
  by default; ET-008-bounded — the governor refuses to disable a
  lane's limit and range-bounds every value).
- **CCT admin** (`TokenAdminRegistry`) + every cross-chain contract
  owner = the admin multisig → governance timelock at mainnet.
- **GuardianPausable** on every cross-chain contract with a runtime
  send / receive path: `CcipMessenger`, `VaipakamRewardMessenger`,
  `VpfiBuyAdapter`, `VpfiBuyReceiver`, and the mirror-chain
  `VPFIMirrorToken` (see §6 below).

The 2024 LayerZero-era DVN hardening script (`ConfigureLZConfig.s.sol`)
and the `LZConfig.t.sol` assertion suite are deleted — they have no
CCIP equivalent because there is no operator-configurable verifier
surface to harden. The migration ADR is
[`docs/adr/0004-ccip-over-layerzero.md`](../docs/adr/0004-ccip-over-layerzero.md);
the design doc is
[`docs/DesignsAndPlans/LayerZeroToChainlinkCcipMigration.md`](../docs/DesignsAndPlans/LayerZeroToChainlinkCcipMigration.md).

---

## 6. Ownership rotation

For every proxy + facet across every chain:

1. Current owner (deployer key) calls `transferOwnership(timelock)` on each
   `Ownable2Step` contract.
2. Timelock accepts ownership via `acceptOwnership()`.
3. Confirm `owner()` on each contract returns the timelock address.
4. **Burn the deployer key.** Out of key vault, out of CI, out of wallet.

Until this step is complete, the deployer key is a single-point-of-failure
for every contract in the deployment. Do not let any user-facing flow go
live with the deployer still holding ownership.

---

## 7. VPFI minter rotation

On the canonical chain (Base):

```bash
# Executed by current VPFI minter (deployer multisig during setup)
cast send $VPFI_TOKEN "setMinter(address)" $BASE_DIAMOND \
  --private-key $PRIVATE_KEY
```

After this, `TreasuryFacet.mintVPFI` is the only mint path, gated by
facet-level roles. On every other chain, `isCanonicalVPFIChain` is false
and the mint gate short-circuits.

---

## 8. Initial protocol config (Diamond)

Per chain, via timelock-originated txs:

- `ConfigFacet.setGracePeriod(...)` — per documented spec.
- `ConfigFacet.setMinHealthFactor(...)` — default 1.5e18 unless governance
  changes.
- `OracleFacet.set*PriceFeed(...)` — Chainlink feed addresses per
  `AssetRegistry`.
- `ProfileFacet.setKYCThresholds(...)` — USD-denominated tier cutoffs.
- `AdminFacet.setBridgedBuyReceiver(receiver)` on Base only (links the
  Diamond to the `VpfiBuyReceiver` for `processBridgedBuy` access control).
- `VPFIDiscountFacet.setVPFIBuyRate(...)` on Base only — fixed rate for the
  early-stage buy program.
- `VPFIDiscountFacet.setVPFIBuyCaps(globalCap, perWalletCap)` on Base only.
- `VPFIDiscountFacet.setVPFIBuyEnabled(true)` on Base only — opens the buy.

Every `ConfigFacet` / `AdminFacet` setter emits an event. Capture all event
receipts in `deployments/<network>/initial-config.json` for audit trail.

---

## 9. Monitoring + alerting (must be live before opening deposits)

Off-chain watcher subscribed to:

- **CCIP RMN curse-event drift**: alert if the Risk Management
  Network ever curses a chain or lane (the CCIP Router's
  `isCursed*` views go to true). Continuous check every 15 min.
- **CCT mint/burn imbalance**: sum mirror supplies (VPFIMirrorToken
  totalSupply on each mirror) vs. lock balance in the
  `LockReleaseTokenPool` on Base. Delta > 0.1% = alert.
- **Large VPFI flow**: any single Transfer of > 10k VPFI on a mirror
  that doesn't correlate with a Base-side BurnMint/LockRelease event
  on the matching CCIP message id.
- **Lane rate-limit saturation**: per-lane `currentRate /
  rateCapacity` > 80% = warn, 95% = alert (the
  `VpfiPoolRateGovernor` exposes the lane view).
- **Pause lever health**: synthetic monthly drill that calls
  `pause()` on a dev `CcipMessenger` to verify the runbook path
  works end-to-end.
- **CCIP fee funding**: per-chain LINK (or wrapped-native) balance
  on the chain's outbound CCIP sender < 30-day projected fee
  burn = page oncall.

Alerts route to a 24/7 oncall rotation. No "alert email that sits in
someone's spam folder" patterns.

---

## 10. Incident runbook (in-band)

**Suspected CCIP message-forge / RMN curse / unexpected VPFI mint**:

1. Page oncall. Timelock signers on call immediately.
2. Call `pause()` on the affected cross-chain contracts (the
   `GuardianPausable` lever is reachable to either the guardian
   or the owner):
   - `VPFIMirrorToken` on each affected mirror — freezes mirror
     token transfers + the BurnMintPool path.
   - `VpfiBuyAdapter` (mirror) + `VpfiBuyReceiver` (Base) —
     freezes the buy mesh.
   - `CcipMessenger` (all chains) — freezes the channel-message
     path (BUY_REQUEST / REWARD_REPORT / REWARD_BROADCAST).
   - `VaipakamRewardMessenger` (all chains) — freezes reward
     aggregation. A paused inbound is recorded by CCIP as a
     failed message and is manually re-executable once unpaused
     — nothing is lost.
3. Publish status page update within 15 min of pause.
4. Investigate. Identify attack vector. Decide:
   - If isolated to one chain: keep other chains running, unpause
     after verification.
   - If RMN-wide: stay paused, coordinate with Chainlink CCIP
     operators + the protocol's incident commander.
5. If funds at risk:
   - Check pending refunds on `VpfiBuyAdapter` — buyers can call
     `reclaimTimedOutBuy` after the refund window (default 15 min);
     the pause doesn't block reclaim.
   - Pool lock balance on Base (`LockReleaseTokenPool`) is
     ultimately L1-recoverable via a timelock-governed admin call
     if the mesh is fully compromised.
6. Post-mortem within 72h. Public.

Reference: a 46-minute operator pause in the April 2026 cross-chain
bridge incident (the Kelp / LayerZero exploit that drove the
T-068 migration to CCIP) prevented ~$200M of follow-up drain.
Speed of first pause > everything else.

---

## 11. Phase 1 go/no-go checklist

Tick every box before opening the frontend to public traffic.

```
[ ] External audit complete. Findings addressed or documented.
[ ] All contracts deployed, source-verified on block explorers.
[ ] Diamond facets cut; DiamondLoupe reflects every expected facet selector.
[ ] Owner is timelock on every proxy, every facet.
[ ] Deployer key destroyed.
[ ] VPFI minter = Base Diamond.
[ ] DeployCrosschain.s.sol run on every chain in the deployment.
[ ] ConfigureCcip.s.sol run on every chain (channel peers + lane rate
    limits + TokenAdminRegistry registration).
[ ] CCIP_GUARDIAN set on every cross-chain contract with
    GuardianPausable (CcipMessenger, VaipakamRewardMessenger,
    VpfiBuyAdapter/VpfiBuyReceiver, VPFIMirrorToken on mirrors).
[ ] Per-lane rate limits set on every VPFI TokenPool through
    VpfiPoolRateGovernor (default 50,000 capacity / ~5.8 VPFI/s refill).
[ ] VpfiBuyAdapter.setRateLimits called on every mirror chain to
    move the adapter's own per-request + 24h-rolling buy caps off
    their `type(uint256).max` boot defaults (separate from the
    TokenPool lane caps — the adapter has its own pre-CCIP-send
    throttle on `amountIn`). Recommended starting values match the
    pre-T-068 LayerZero-era defaults: per-request 50,000 VPFI,
    24h-rolling 500,000 VPFI. Pre-mainnet gate.
[ ] Initial protocol config (grace period, HF, oracles, KYC, buy rate) set.
[ ] Monitoring live; test alerts received end-to-end.
[ ] Incident runbook drilled (pause + unpause on a test OApp).
[ ] Frontend deployed on production domain, TLS + HSTS verified.
[ ] Status page + support channel ready.
```

Until all 14 items are ticked, we are not open.
