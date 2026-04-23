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

# Protocol owner — timelock/multisig address per chain
# (same address across EVM chains is fine; deterministic deploy via CREATE2
# is tracked in DeployRewardOAppCreate2.s.sol)
VPFI_OWNER=0x…       # VPFI token / OFT adapter / mirrors / buy-adapter / receiver
REWARD_OWNER=0x…     # VaipakamRewardOApp

# Treasury (Diamond-managed; deployer-controlled multi-sig)
TREASURY=0x…

# LayerZero endpoint addresses per chain
# (from https://docs.layerzero.network/v2/deployments/deployed-contracts)
LZ_ENDPOINT=0x1a44076050125825900e736c501f859c50fE728c  # mainnet canonical

# ULN library addresses per chain (same page as above)
SEND_LIB=0x…
RECV_LIB=0x…

# DVN operator set (3 required + 2 optional, threshold 1)
DVN_REQUIRED_1=0x…   # LayerZero Labs
DVN_REQUIRED_2=0x…   # Google Cloud
DVN_REQUIRED_3=0x…   # Polyhedra OR Nethermind
DVN_OPTIONAL_1=0x…   # BWare Labs
DVN_OPTIONAL_2=0x…   # Stargate OR Horizen Labs

# Optional overrides
CONFIRMATIONS=        # only if overriding the per-chain default in
                      # ConfigureLZConfig.s.sol
CHAIN_ID=             # override block.chainid (rarely needed)
```

---

## 2. Deploy order per chain

All forge scripts live in `contracts/script/`. Run per-chain, in this
order. **Never parallelise across chains without a consistency
plan** — the OFT peer wiring in §5 depends on addresses from §3/§4.

### 2.1 Canonical chain (Base) only: `DeployVPFICanonical.s.sol`

```bash
forge script script/DeployVPFICanonical.s.sol \
  --rpc-url $BASE_RPC_URL --broadcast --verify
```

Deploys `VPFIToken` (ERC20Capped 230M) + `VPFIOFTAdapter` (OFT V2 lock/release).
Owner for both is `VPFI_OWNER` from env.

### 2.2 Every other chain: `DeployVPFIMirror.s.sol`

```bash
# per chain, e.g. Arbitrum
forge script script/DeployVPFIMirror.s.sol \
  --rpc-url $ARBITRUM_RPC_URL --broadcast --verify
```

Deploys `VPFIMirror` (pure OFT V2). No mint surface — supply is driven by
bridged lock-ins on canonical.

### 2.3 Cross-chain buy adapters (non-Base chains)

```bash
forge script script/DeployVPFIBuyAdapter.s.sol \
  --rpc-url $<CHAIN>_RPC_URL --broadcast --verify
```

Deploys `VPFIBuyAdapter` on every non-Base chain. Pairs with the
`VPFIBuyReceiver` deployed next.

### 2.4 Base: `DeployVPFIBuyReceiver.s.sol`

```bash
forge script script/DeployVPFIBuyReceiver.s.sol \
  --rpc-url $BASE_RPC_URL --broadcast --verify
```

### 2.5 Diamond deploy (every chain)

Follow the existing Diamond deploy procedure (see
[`contracts/README.md#repository-layout`](README.md)). Set `vpfiToken` to
the mirror (or canonical token on Base) post-deploy via
`AdminFacet.setVPFIToken`.

### 2.6 Reward OApp (every chain, CREATE2-deterministic)

```bash
# Same salt + impl on every chain ⇒ same address. Deploy impl + proxy
# in one script.
forge script script/DeployRewardOAppCreate2.s.sol \
  --rpc-url $<CHAIN>_RPC_URL --broadcast --verify
```

---

## 3. Verification gate

After the above, for every chain, confirm:

- All proxies' owner is `VPFI_OWNER` / `REWARD_OWNER` (the timelock).
- Block explorers have verified source for every contract.
- Each contract's runtime bytecode matches the compiled artifact. Use
  `cast code` and diff against local `out/`.

---

## 4. Wire peers — `WireVPFIPeers.s.sol`

For every ordered (srcChain, dstChain) pair of **each** OApp mesh:

- VPFI OFT mesh: adapter ↔ every mirror, plus mirror ↔ every other mirror
  *if* mirror-to-mirror user bridging is desired.
- VPFI Buy mesh: every BuyAdapter ↔ BuyReceiver on Base.
- Reward OApp mesh: every mirror ↔ Base; plus broadcast destinations
  (Base → every mirror).

```bash
LOCAL_OAPP=0x<local>  REMOTE_EID=<peer-eid>  REMOTE_PEER=0x<remote> \
  forge script script/WireVPFIPeers.s.sol \
    --rpc-url $<LOCAL>_RPC_URL --broadcast
```

Symmetric — run BOTH directions per pair. Missing one leg = messages land
but responses are black-holed.

---

## 5. Harden LayerZero config — `ConfigureLZConfig.s.sol`

**This is the DVN-hardening gate. Do not skip, do not shortcut.**

For every (OApp × chain) pair:

```bash
OAPP=0x<oapp>  SEND_LIB=$SEND_LIB  RECV_LIB=$RECV_LIB \
REMOTE_EIDS=30110,30111,30184,30101,30267,30102 \
DVN_REQUIRED_1=…  DVN_REQUIRED_2=…  DVN_REQUIRED_3=… \
DVN_OPTIONAL_1=…  DVN_OPTIONAL_2=… \
  forge script script/ConfigureLZConfig.s.sol \
    --rpc-url $<CHAIN>_RPC_URL --broadcast
```

Broadcaster key must be the OApp delegate (i.e. the timelock / multisig
signer). On a Gnosis Safe setup, run via `forge script --ledger` or batch
through the Safe transaction builder.

### 5.1 Verify the config readback (CI gate)

```bash
LZ_CONFIG_VERIFY_DVNS=1 \
DVN_REQUIRED_1=…  DVN_REQUIRED_2=…  DVN_REQUIRED_3=… \
DVN_OPTIONAL_1=…  DVN_OPTIONAL_2=… \
  forge test --match-path test/LZConfig.t.sol -vvv
```

All 5 tests must pass. `test_dvnsPopulatedForMainnetDeploy` ONLY runs
under `LZ_CONFIG_VERIFY_DVNS=1` — that's the mainnet gate. If sentinel
addresses (0x01..0xff) are used, the test fails loudly by design.

### 5.2 Rate-limit the buy adapter

```bash
cast send 0x<VPFIBuyAdapter> "setRateLimits(uint256,uint256)" \
  50000000000000000000000  \
  500000000000000000000000 \
  --private-key $PRIVATE_KEY
```

(50k VPFI / request, 500k VPFI / 24h rolling. Tunable by governance post-
deploy.) **Pre-mainnet gate — the contract ships with `type(uint256).max`
defaults that are effectively no cap.**

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
  Diamond to the `VPFIBuyReceiver` for `processBridgedBuy` access control).
- `VPFIDiscountFacet.setVPFIBuyRate(...)` on Base only — fixed rate for the
  early-stage buy program.
- `VPFIDiscountFacet.setVPFIBuyCaps(globalCap, perWalletCap)` on Base only.
- `VPFIDiscountFacet.setVPFIBuyEnabled(true)` on Base only — opens the buy.

Every `ConfigFacet` / `AdminFacet` setter emits an event. Capture all event
receipts in `deployments/<network>/initial-config.json` for audit trail.

---

## 9. Monitoring + alerting (must be live before opening deposits)

Off-chain watcher subscribed to:

- **DVN-count drift**: alert if any OApp on any eid has
  `endpoint.getConfig(oapp, lib, eid, CONFIG_TYPE_ULN)` decoded
  `requiredDVNCount < 3`. Continuous check every 15 min.
- **OFT mint/burn imbalance**: sum mirror supplies vs. lock balance in
  `VPFIOFTAdapter` on Base. Delta > 0.1% = alert.
- **Large VPFI flow**: any single Transfer of > 10k VPFI on a mirror
  that doesn't correlate with an adapter-side `_debit` event on Base.
- **Buy-adapter rate-limit saturation**: daily used / daily cap > 80% =
  warn, 95% = alert.
- **Pause lever health**: synthetic monthly drill that calls
  `pause()` on a dev OApp to verify the runbook path works end-to-end.
- **Executor funding**: LZ executor ETH balance on each chain < 0.05 ETH =
  page oncall.

Alerts route to a 24/7 oncall rotation. No "alert email that sits in
someone's spam folder" patterns.

---

## 10. Incident runbook (in-band)

**Suspected DVN compromise / forged message / unexpected VPFI mint**:

1. Page oncall. Timelock signers on call immediately.
2. Call `pause()` on:
   - `VPFIOFTAdapter` (Base) — freezes lock/release.
   - Every `VPFIMirror` — freezes mint/burn on each mirror.
   - `VPFIBuyAdapter` + `VPFIBuyReceiver` — freezes the buy mesh.
   - `VaipakamRewardOApp` (all chains) — freezes reward aggregation.
3. Publish status page update within 15 min of pause.
4. Investigate. Identify attack vector. Decide:
   - If isolated to one chain: keep other chains running, unpause after
     verification.
   - If DVN-wide: stay paused, coordinate with LZ team + DVN operators.
5. If funds at risk:
   - Check `totalPendingAmountIn` on `VPFIBuyAdapter` — buyers can call
     `reclaimTimedOutBuy` after the refund window (default 15 min); the
     pause doesn't block reclaim.
   - Adapter's lock balance on Base is ultimately L1-recoverable via a
     timelock-governed `rescueERC20` call if the peer mesh is fully
     compromised.
6. Post-mortem within 72h. Public.

Reference: a 46-minute operator pause in the April 2026 cross-chain
bridge incident prevented ~$200M of follow-up drain. Speed of first
pause > everything else.

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
[ ] WireVPFIPeers run for every (src, dst) in the mesh.
[ ] ConfigureLZConfig run for every OApp × eid.
[ ] LZConfig.t.sol passes with LZ_CONFIG_VERIFY_DVNS=1.
[ ] setRateLimits called on every VPFIBuyAdapter.
[ ] Initial protocol config (grace period, HF, oracles, KYC, buy rate) set.
[ ] Monitoring live; test alerts received end-to-end.
[ ] Incident runbook drilled (pause + unpause on a test OApp).
[ ] Frontend deployed on production domain, TLS + HSTS verified.
[ ] Status page + support channel ready.
```

Until all 14 items are ticked, we are not open.
