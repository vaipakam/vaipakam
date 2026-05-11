# Release notes — 2026-05-11

A continuation-day session focused on the post-rehearsal cross-chain
configuration surface: Tenderly project setup, peer wiring, DVN
policy, swap-adapter strategy, and the operator-grade authority
matrix that sits underneath all of them. Most of the day's work
was decision-tree pruning — discovering that several of the
operator-action items in the runbook are mainnet-cutover ceremonies
rather than testnet rehearsals, and committing the small script
changes needed to keep both modes coherent.

The headline thread: **OApp + Diamond ownership has split across
three authority contexts** (ADMIN-EOA on arb-sepolia, Safe
multisig on base-sepolia + sepolia, Timelock everywhere for
Diamond admin), and every cross-chain action now picks one of the
three at runtime. Two Safe Transaction-Builder JSONs landed for
the multisig-routed work; four ADMIN-signable broadcasts went
through directly.

## Tenderly — REST API setup, account configured

`tenderly init` from inside `ops/tenderly/` failed with the
"no Brownie/Hardhat/Buidler/OpenZeppelin/Truffle config detected"
error: the directory is not a project root. Walked the REST API
path instead using the credentials in `/home/pranav/Codes/Vaipakam/vaipakam/.env`
(`TENDERLY_API_KEY` + `TENDERLY_API_URL` against
`api.tenderly.co/api/v1/account/Vaipakam/project/vaipakam`).

Auth confirmed via project-metadata GET — slug `vaipakam`,
project id `30848d2e-64bb-465c-b949-d4161da0209a`, owner
username `Vaipakam`. Five contracts were already in the project
on arb-sepolia (3 ERC1967Proxies + Diamond + Timelock) — they
auto-imported when transactions hit them earlier in yesterday's
rehearsal.

`account_id: Vaipakam` is now filled in `ops/tenderly/tenderly.yaml`,
unblocking `tenderly actions deploy` from inside that directory.

**Bulk contract-add via REST is not workable**: the v1 `/contracts`
POST endpoint is the legacy "push verified source" shape — it
expects full Solidity source code in the request body, not a
"track-by-address" import. Multiple body-shape attempts (single
object, `{contracts:[...]}` array, `id:"eth:<chainId>:<addr>"`,
`addresses:[...]`) returned either `Contract list cannot be empty`
validation errors or `Internal server error`. Practical path
forward: every other deployed address auto-tracks the moment
traffic hits it, OR the operator drops a single address into the
dashboard's "Add Contract" UI ahead of first traffic.

## Cross-chain peer wiring — 4 ADMIN-signed + 10 Safe-batch

Confirmed the OApp ownership split via on-chain `owner()` reads:

| Chain         | OApps                                      | Owner |
|---------------|--------------------------------------------|-------|
| base-sepolia  | VPFIOFTAdapter, VPFIBuyReceiver, RewardOApp | Safe `0x2C7B…1dd0` |
| sepolia       | VPFIMirror, VPFIBuyAdapter, RewardOApp      | Safe `0x2C7B…1dd0` |
| arb-sepolia   | VPFIMirror, VPFIBuyAdapter, RewardOApp      | ADMIN-EOA `0xF718…2030` |

`deploy-peers.sh` overrides `PRIVATE_KEY → ADMIN_PRIVATE_KEY` on
the assumption that ADMIN owns every OApp post-deploy. That's
true on chains where the multi-party Safe acceptance hasn't
happened yet (arb-sepolia, blocked on Safe SDK not supporting
that chain) but wrong on the chains where it has (base-sepolia
+ sepolia: ADMIN-signed `setPeer` reverts `OwnableUnauthorizedAccount`).

The 14-leg peer matrix split 4 / 10 by source-chain authority:

- **4 ADMIN-signable** (all from arb-sepolia → other chains):
  broadcast directly via `cast send` with `ADMIN_PRIVATE_KEY`.
  Tx hashes:
  - VPFIMirror.setPeer(40245, base-sep VPFIOFTAdapter)
    → `0x2d73f35061ffbca7fdc26548b9a6eebdb56b5dad64ce9bddb639cb67e0e5b33e`
  - VPFIBuyAdapter.setPeer(40245, base-sep VPFIBuyReceiver)
    → `0xfc24d6f66fdcb784f483cfc746a03dc6aaa968cd91e6a31e4dbef46cce5e4fb8`
  - RewardOApp.setPeer(40245, base-sep RewardOApp)
    → `0x97d8d93794f7a33ce85a9b181ef17d85c35eb4743c583b548c6cdde71afabee8`
  - RewardOApp.setPeer(40161, sep RewardOApp)
    → `0x945729ccb1d960aa3271d7bbcfeddc5e561eb27dd175427707fc74c2322da78b`
  Each peer reads back as the right-padded peer address (verified
  immediately after broadcast via `peers(uint32)(bytes32)`).

- **10 Safe-signable** (6 from base-sepolia + 4 from sepolia):
  emitted as Safe Transaction-Builder JSONs at
  [`docs/ops/safe-batches/`](../ops/safe-batches/). Each file lists
  every `setPeer` with its decoded `_eid` + `_peer` arguments
  pre-rendered for visual eyeball-check in the Builder UI.
  Operator path: open `app.safe.global` → switch to the right
  chain → Apps → Transaction Builder → drag JSON in → review →
  propose → 2-of-3 signers approve → execute.

  Files: `peer-wiring-base-sepolia.json` (24 KB, 6 tx) and
  `peer-wiring-sepolia.json` (16 KB, 4 tx). Companion README
  documents the authority split + the verify-with-cast post-execute
  step.

## DVN policy — script edit committed, broadcast parked

`ConfigureLZConfig.s.sol` is hardcoded to the mainnet 3R+2O
shape (3 required DVNs + 2 optional, threshold 1-of-2 — the
post-incident hardening pinned in `contracts/README.md` and
`CLAUDE.md`). For testnet rehearsal, the user wanted a
1R+1O shape ("1:1 for now in testnet"). Added a `DVN_POLICY_MODE`
env-var escape hatch — `testnet1of1` switches the script to read
1R+1O from env (`DVN_REQUIRED_1` + `DVN_OPTIONAL_1` only),
threshold 1-of-1. Empty / unset / any other value preserves the
mainnet 3R+2O shape so the production policy remains the default
and `LZConfig.t.sol`'s mainnet-fork assertion stays meaningful.

Surface details:

- New `_isTestnetMode()` helper using `keccak256(bytes(...))`
  string equality (avoids the empty-string-leading-null-byte
  comparison gotcha).
- `_policyForChain` branches on the mode flag, returns
  `requiredDVNCount: 1, optionalDVNCount: 1, optionalDVNThreshold: 1`
  in testnet mode.
- `_loadDvnSet` returns variable-size arrays per mode.
- `_assertDvnsConfigured` slot-iterates so testnet mode only
  asserts the 2 active slots (operator can leave
  `DVN_REQUIRED_2/3` + `DVN_OPTIONAL_2` unset without tripping
  pre-flight).
- Cross-group duplicate detection still runs in both modes.
- Per-chain default-confirmation table preserved unchanged.

`deploy-testnet.sh`'s `phase_lz_config` refusal message rewritten
to document both shapes side-by-side so a future operator running
`--confirm-dvn-policy-reviewed` knows which env vars are read in
each mode.

**Why the actual broadcast is parked for testnet** — even with the
script edit, pushing 1R+1O on testnet requires:
- Sourcing 3 `DVN_OPTIONAL_1` addresses from the LayerZero DVN
  registry (the `metadata.layerzero-api.com/v1/metadata/dvns`
  endpoint exposes mainnet-only — testnet entries are gated, and
  the LZ docs UI is JS-rendered).
- 56 `setConfig` broadcasts total: 16 ADMIN-signable on arb-sepolia
  + 40 Safe-batch (24 base-sep + 16 sep).

Current on-chain state on all 3 chains is the LZ default 1R+0O,
which is functionally equivalent to 1R+1O for security (both are
single-point-of-verification-failure shapes). The mainnet 3R+2O
hardening is where the policy actually matters; running 1R+1O
on testnet adds 56 broadcasts of essentially-zero rehearsal value.

ULN302 send/recv libraries discovered per chain via
`endpoint.defaultSendLibrary(eid)` / `defaultReceiveLibrary(eid)`:

| Chain         | SendLib | ReceiveLib |
|---------------|---------|------------|
| base-sepolia  | `0xC1868e054425D378095A003EcbA3823a5D0135C9` | `0x12523de19dc41c91F7d2093E0CFbB76b17012C8d` |
| arb-sepolia   | `0x4f7cd4DA19ABB31b0eC98b9066B9e857B1bf9C0E` | `0x75Db67CDab2824970131D5aa9CECfC9F69c69636` |
| sepolia       | `0xcc1ae8Cf5D3904Cef3360A9532B477529b177cCE` | `0xdAf00F5eE2158dD58E0d3857851c432E34A3A851` |

LZ Labs DVN address per chain (decoded from current default ULN
config via `getUlnConfig(oapp, remoteEid)`):

| Chain         | LZ Labs DVN | confirmations |
|---------------|-------------|--------------:|
| base-sepolia  | `0xe1a12515F9AB2764b887bF60B923Ca494EBbB2d6` | 2 |
| arb-sepolia   | `0x53f488E93b4f1b60E8E83aa374dBe1780A1EE8a8` | 5 |
| sepolia       | `0x8eebf8b423B73bFCa51a1Db4B7354AA0bFCA9193` | 2 |

These values are stashed in this release-notes for future operator
reference; not yet pushed to `.env.example` because the broadcast
is parked.

## Swap-adapters phase — parked for testnet

Discovered three obstacles that combined make this phase a
mainnet-cutover-only ceremony:

1. **Diamond is fully Timelock-governed**. `owner()` on the
   Diamond and `hasRole(ADMIN_ROLE, ...)` checks both resolve to
   the Timelock (`0xb985F8987720C6d76f02909890AA21C11bC6EBCA`)
   on all 3 chains. ADMIN-EOA does NOT hold `ADMIN_ROLE`; Safe
   does NOT hold `ADMIN_ROLE`. Every `AdminFacet.addSwapAdapter`
   call must therefore go through Safe → Timelock.schedule →
   wait minDelay → Safe → Timelock.execute. 9 such ceremonies
   would be needed for 3 adapters × 3 chains.

2. **base-sepolia is missing the canonical AllowanceHolder**.
   `cast code 0x0000000000001fF3684f28c67538d4D072C22734` returns
   empty on base-sepolia. The `AggregatorAdapterBase` constructor
   (post Phase 7a allowance-target split) treats the AllowanceHolder
   as load-bearing for the ERC20-pull path. Deploying the 0x adapter
   on base-sepolia would either revert at init or land in a state
   where any liquidation route through it fails. AllowanceHolder
   IS deployed on arb-sepolia + sepolia.

3. **Testnet has no real DEX liquidity**. Even with adapters
   deployed and registered, the actual swap routing path won't
   exercise — there's no aggregator backend to quote against on
   Base Sepolia / Arb Sepolia / Sepolia for our mock asset pairs.
   The rehearsal value is the Timelock plumbing, not the swap
   path.

Decision: park the entire phase. Mainnet cutover runs
DeploySwapAdapters + the 9 Timelock ceremonies fresh. Testnet
HF-liquidation falls back to the legacy single-aggregator path
via `setZeroExProxy` — which is also operator-blocked because
the 0x Settler addresses are part of the Chainlink/0x address-
sourcing block under `--phase configure`.

## lz-watcher OAPP_* secrets — deferred to mainnet cutover

`ops/lz-watcher/src/chains.ts` is mainnet-only by construction:

- `EID_BY_CHAIN_ID` lists only the 6 mainnet eids (Ethereum 30101,
  Base 30184, Arbitrum 30110, Optimism 30111, Polygon zkEVM 30267,
  BNB Chain 30102).
- The `shortKey` union literal-types `'BASE' | 'ETH' | 'ARB' | 'OP' | 'ZKEVM' | 'BNB'`
  so testnet entries can't be added without expanding the type.
- `env.ts` lists mainnet-shaped env keys (`OAPP_VPFI_OFT_ADAPTER_BASE`,
  etc.) — there's no `OAPP_VPFI_OFT_ADAPTER_BASE_SEPOLIA` slot.

Setting `OAPP_*_BASE` to a base-sepolia address would make the
DVN-drift watcher report "Base mainnet drift" with sepolia data —
wrong dashboard, wrong eids, wrong corresponding mainnet bridge
operator.

The watcher is detection-only with a 5-minute cron; alert value
on testnet (no real money at stake) is essentially zero. Defer
the chains.ts surgery and the OAPP_* secret-puts to the mainnet
cutover, where DVN-drift / OFT mint-burn imbalance / oversized
flow alerts have real load-bearing value.

## --phase configure — operator-blocked on address sourcing

`ConfigureOracle.s.sol` reads ~9 per-chain addresses that were
holes in `contracts/.env`:

- `ARB_SEPOLIA_*` (5): ETH/USD feed, USDC/USD feed, sequencer
  uptime feed, Uniswap V3 factory, WETH (already in deployments
  manifest, just not in .env).
- `SEPOLIA_*` (4): ETH/USD feed, USDC/USD feed (verified via the
  Sepolia reference-data CDN), V3 factory, WETH9.
- `0x` proxies × 3 chains (6 vars).
- `BASE_SEPOLIA_SEQUENCER_UPTIME_FEED` is currently set to
  `0xBCF85224fc0756B9Fa45aA7892530B47e10b6433` in
  `.env.example:225` and `tenderly.yaml:214` — but the Chainlink
  L2-sequencer-feeds documentation lists that address as Base
  **mainnet**, not Base Sepolia. Likely a miscopy from mainnet;
  flagged for verification before configure runs.

Multiple WebFetch attempts to the Chainlink docs page, the
`reference-data-directory.vercel.app` CDN, and the `smartcontractkit/documentation`
GitHub repo all hit dead-ends — the docs page is JS-rendered, the
CDN file for arb-sepolia is staging-only, and the GitHub data
layout is fragmented. The two values that the Sepolia CDN file
DID expose authoritatively:

```
SEPOLIA_ETH_USD_FEED=0x694AA1769357215DE4FAC081bf1f309aDC325306
SEPOLIA_USDC_FEED=0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E
```

Configure phase is parked pending operator address sourcing.

## --phase configure — half-landed (correction + actual run on arb-sepolia)

The morning's "operator-blocked on Chainlink/0x address sourcing"
parking decision turned out to be a partial picture. The user came
back with: 5 of the 9 missing addresses sourced (ETH/USD + USDC + V3
factory for arb-sepolia, ETH/USD + USDC for sepolia, all verified via
on-chain `description()` reads) plus one observation worth keeping —
the `0xd30e2101…` address listed as `ARB_SEPOLIA_ETH_USD_FEED` is the
**same** address listed as `BASE_SEPOLIA_USDC_FEED` in `.env.example`,
which initially read as a typo. It's not. Chainlink reuses identical
proxy addresses for different feeds across different chains routinely;
the on-chain `description()` call confirms each chain's address really
is what its prefix claims.

The unresolved 0x addresses needed a different solve. 0x v1
ExchangeProxy (`0xDef1C0…`) is deployed only on Sepolia among the
three testnets; AllowanceHolder is on arb-sepolia + sepolia but
**missing** on base-sepolia; v2 Settlers rotate per release so a hand-
sourced address goes stale. Fix: the existing
[`DeployZeroExMock.s.sol`](contracts/script/DeployZeroExMock.s.sol) +
[`ZeroExProxyMock`](contracts/test/mocks/ZeroExProxyMock.sol) test
double — already chain-id-guarded against mainnets. Deployed once per
chain, recorded as both `<CHAIN>_ZEROX_PROXY` and
`<CHAIN>_ZEROX_ALLOWANCE_TARGET` (v1 single-contract surface
convention). 3 mock addresses landed:

| Chain         | ZeroExProxyMock |
|---------------|-----------------|
| base-sepolia  | `0x4401616da011913d47bdF50b2f81a074b1Bc28c1` |
| arb-sepolia   | `0xde4164d66d843D3406E24062329E5A4E9131D408` |
| sepolia       | `0x1a39B714a6B095E4408797925b7b564f9274BA3d` |

Full configure-relevant block (denominators + per-chain feeds + V3
factories + WETH + sequencer feeds + 0x mock) appended to
`contracts/.env`.

### Stale-Diamond cleanup

Discovered `.env` and `.env.example` both held **stale** Diamond
addresses for all 3 chains — pointing at orphaned Diamond instances
from prior `--fresh` rehearsals. The deploy scripts read
`deployments/<slug>/addresses.json` directly via
`Deployments.readDiamond()`, so they were always working against the
canonical instance; only manual `.env` reads were misled (including
mine — see "stale-Diamond ownership transfer artifact" below).

| Chain         | `.env` (stale) | `.env.example` (stale) | Canonical (`addresses.json`) |
|---------------|---------------|------------------------|--------------------------------|
| base-sepolia  | `0x890700BB…` | `0xae4A906c…` | `0x804Bc3E9…` |
| arb-sepolia   | `0xfe9B4609…` | `0x8d89Ad16…` | `0x17Fe0D80…` |
| sepolia       | `0x6C284Ae8…` | `0xc815c2C2…` | `0xD2903cbb…` |

`.env` synced to canonical with a comment block explaining the
divergence + how the canonical artifact reader works. `.env.example`
is the operator-maintained template; left for follow-up.

### Stale-Diamond ownership transfer artifact

While diagnosing the configure-broadcaster auth check, I queried the
Diamond owner using `BASE_SEPOLIA_DIAMOND_ADDRESS` from `.env.example`
(`0xae4A906c…`) — the stale instance. Its owner was the deployer EOA
(pre-handover state of that orphaned Diamond). Concluded the
"Diamond hasn't been handed over" and broadcast a fix:

- 3 `transferOwnership(ADMIN-EOA)` calls — one per chain, signed by deployer
- 3 `grantRole(ADMIN_ROLE, ADMIN-EOA)` calls — same shape
- Tx hashes recorded in chain history; status `0x1` on all 6

These all hit the **stale** Diamond instances, not the canonical ones.
On the canonical Diamonds (which are owned by per-chain Timelock
contracts post-handover), the ownership state is unchanged. The 6 txs
are harmless on protocol state but worth flagging for the audit trail
— stale Diamonds on testnet retain `OwnershipFacet` and accept owner
calls from whoever currently holds them. Lesson captured in the
runbook §1's authority-state matrix subsection.

### `DiamondConfigSpell` chain-branch surgery

`ConfigureVPFIBuy._ethPriceAsset()` hard-reverts on chainids other
than 8453 (Base mainnet) and 84532 (Base Sepolia). The old spell
called `ConfigureVPFIBuy.run()` unconditionally as step 3 of 4, so
mirror-chain runs aborted before reaching ConfigureNFTImageURIs. Added
an `_isCanonicalVPFIChain()` helper and gated step 3 behind it; mirror
chains now log the deliberate skip and continue to step 4. Same shape
as `ConfigureRewardReporter._isCanonicalRewardChain()` — convention
preserved. Build clean.

### Configure landed on arb-sepolia

With `.env` populated + `DiamondConfigSpell` patched + the canonical
arb-sepolia Diamond `0x17Fe0D80…` still ADMIN-EOA-owned (Safe SDK
isn't on Arb Sepolia testnet, so the Diamond handover never happened
there), `--phase configure` ran cleanly:

```
[DiamondConfigSpell] 1/4: ConfigureOracle               ✓
[DiamondConfigSpell] 2/4: ConfigureRewardReporter       ✓
[DiamondConfigSpell] 3/4: ConfigureVPFIBuy (SKIPPED)    ✓ (non-canonical)
[DiamondConfigSpell] 4/4: ConfigureNFTImageURIs         ✓
ONCHAIN EXECUTION COMPLETE & SUCCESSFUL.
```

All 9 oracle setters + 5 reward-reporter setters + NFT URIs landed on
arb-sepolia in one operator action. Marker file written; phase will
refuse re-broadcast unless the operator manually deletes it.

### base-sepolia + sepolia configure — Timelock-routed (parked)

Both canonical Diamonds on base-sepolia (`0x804Bc3E9…`) and sepolia
(`0xD2903cbb…`) are owned by per-chain Timelock contracts and
`ADMIN_ROLE` is held only by those Timelocks. ConfigureOracle's
pre-flight check fails with the explicit error message: *"This script
is the pre-handover bootstrap path; post-handover oracle changes must
go through the timelock proposer flow."*

Pushing configure on those two chains requires composing a Safe
Transaction Builder JSON with ~14 setter calls per chain encoded as
`Timelock.schedule(target, value, data, predecessor, salt, delay)`,
waiting `minDelay`, then a second batch with `Timelock.execute(...)`
calls. Same governance shape as the swap-adapters phase. Parked for
testnet rehearsal — same rationale as the lz-config + swap-adapters
parking decisions: testnet rehearsal value is the governance plumbing
exercise, not the actual oracle reads (no real liquidation flow runs).
Mainnet cutover composes the real batches.

## Peer-wiring Safe-batch operator walkthrough

Wrote a step-by-step walkthrough for executing the two peer-wiring
batches via `app.safe.global → Apps → Transaction Builder` in
[`docs/ops/safe-batches/README.md`](../ops/safe-batches/README.md).
Captures: per-batch eyeball-check tables (decoded `to` / `_eid` /
`_peer` for every setPeer), the network-switch step (same Safe
deterministic at `0x2C7B…1dd0` on both chains), the post-execute
`cast call peers(...)` verification one-liner, and the "common
surprises that aren't bugs" section (the Reward-OApp peer matching
`to` because of CREATE2 mesh-shape).

Added a new "Mixed-authority case" subsection to the deployment
runbook §2 cross-chain peer wiring step that captures the
ADMIN-vs-Safe authority split during phased handovers — ties the
runbook to the safe-batches README for operator follow-through.

## Arbitrum block.number L1/L2 deployBlock bug — root-cause fix

User reported that the OfferBook UI showed zero offers on arb-sepolia
even after switching chains. Indexer health probe came back fine —
all 3 chains' cursors caught up to head, no errors — but on-chain
`getActiveOffersCount()` reports **8 active offers + 14 active loans**
on the canonical arb-sepolia Diamond. So the indexer was missing
real on-chain state.

**Root cause traced to a single line**:
[`DeployDiamond.s.sol:332`](contracts/script/DeployDiamond.s.sol#L332)
called `Deployments.writeDeployBlock(block.number)`. On Arbitrum
chains, the EVM `block.number` opcode returns the **L1 block number**
(an "approximate" L1 block the sequencer acknowledged when sequencing
the L2 transaction), NOT the L2 block where the deploy actually
landed. The L2 block number is exposed only via the precompile
`ArbSys(0x64).arbBlockNumber()`. This is documented Arbitrum behavior
([docs.arbitrum.io/build-decentralized-apps/arbitrum-vs-ethereum/block-numbers-and-time](https://docs.arbitrum.io/build-decentralized-apps/arbitrum-vs-ethereum/block-numbers-and-time))
but easy to forget when other chains (OP Stack, BNB, Polygon zkEVM,
Ethereum L1) have no L1/L2 distinction in `block.number` semantics.

Empirical verification on arb-sepolia at session-time:

| Source | Block number |
|--------|-------------:|
| `cast block-number` (JSON-RPC `eth_blockNumber`) | 267,155,876 (L2 head) |
| `ArbSys(0x64).arbBlockNumber()` precompile | 267,155,878 (L2, ±1 of head) |
| L2 block's `l1BlockNumber` field (= EVM `block.number`) | 10,828,973 |

The recorded `deployBlock` for arb-sepolia was **10,824,269** — clearly
in the L1 (sepolia) block range. Binary-searched via `cast code` to
confirm the canonical Diamond's actual deploy block is **266,947,649**
(zero bytecode at 266,947,648; non-zero at 266,947,649). Off by ~256M.

Downstream consequences traced through the indexer:
1. After today's D1 purge wiped the cursor, the indexer cron's
   first run re-fell-through to `lastBlock = deployBlock - 1n`
   ([chainIndexer.ts:242](apps/indexer/src/chainIndexer.ts#L242)).
2. With deployBlock = 10,824,269, scan started at L1-range blocks
   that are valid blocks on arb-sepolia (its L2 history goes back
   to genesis), but contained zero Diamond events because the
   canonical Diamond doesn't exist there.
3. The cursor advanced through 256M empty blocks via the standard
   2000-blocks-per-tick × round-robin pacing (mechanism still
   unclear how it caught up so fast — fast-forward path TBD).
4. By the time it reached the actual deploy block 266,947,649,
   the cursor logic had already passed it OR the round-robin was
   otherwise advancing without scanning the right range. Net
   result: the indexer lastBlock is now near current head with
   zero of the 8 offers ingested.

### Three-layer fix

**Layer 1 — Source-level immunity** so this bug class can't recur:

New `Deployments.currentL2Block()` helper in
[`contracts/script/lib/Deployments.sol:243-254`](contracts/script/lib/Deployments.sol#L243).
Branches on `block.chainid`: for Arbitrum One (42161), Arb Sepolia
(421614), and Arb Nova (42170), it `staticcall`s the ArbSys
precompile at `0x64` for `arbBlockNumber()`. For every other chain
(OP Stack, BNB, Polygon zkEVM, Ethereum L1, anvil) it returns
`block.number` directly — the EVM opcode there already maps to the
chain's native height.

New no-arg `Deployments.writeDeployBlock()` overload that uses the
helper internally. The old `writeDeployBlock(uint256)` overload is
retained for backwards compat (any future caller that already has a
correctly-derived block can still use it explicitly), but the
recommended path is the no-arg form.

`DeployDiamond.s.sol:332` switched from
`Deployments.writeDeployBlock(block.number)` to
`Deployments.writeDeployBlock()`. Inline comment beside the call
documents the Arbitrum gotcha + names the indexer-cursor incident as
the test case so future maintainers see the rationale.

`forge build` clean, ec=0.

**Layer 2 — Backfill the corrupted artifact**:

`contracts/deployments/arb-sepolia/addresses.json` deployBlock
patched: 10,824,269 → 266,947,649. Re-exported via
`exportFrontendDeployments.sh`; consolidated
`packages/contracts/src/deployments.json[421614].deployBlock` now
agrees. `_deployments_source.json` provenance stamp regenerated.

**Layer 3 — Indexer cursor recovery (deferred per user direction)**:

The fixed deployBlock is in the artifact, but the live D1 cursor for
chainId=421614 is still at the old (head-tracking) value. Resetting
it via `wrangler d1 execute vaipakam-archive --remote --command
"DELETE FROM indexer_cursor WHERE chain_id=421614 AND kind='diamond'"`
would re-trigger the deployBlock-fallback path, scanning ~205,000
blocks of history and recovering the 8 historical offers + 14 loans
within ~5 hours of cron ticks. Deferred for now: testnet rehearsal
value of those specific offers is low; the source fix prevents the
bug from recurring on any future deploy (including mainnet cutover).
New offers created via the UI on arb-sepolia work normally — the
`useIndexedActiveOffers` hook does an inline `chunkedGetLogs`
catch-up beyond the indexer cursor for live-tail freshness.

### Auto-reseed-at-safe-head: the actual root cause

After landing the deployBlock fix, an additional probe of the live D1
revealed that the indexer cursor for chainId=421614 is at
**267,157,428** — past the corrected deployBlock (266,947,649). And
yet `/offers/stats` returns zero offers. The cursor SHOULD have
scanned the `[266,947,649, 267,157,428]` range that contains the 8
historical offers + 14 loans. So the buggy deployBlock value alone
doesn't explain the missing offers.

Tracing this through revealed the actual root cause: the
`seed_indexer_cursor_safe_head` helper at
[deploy-testnet.sh:531](../../contracts/script/deploy-testnet.sh#L531)
was being auto-invoked from `phase_contracts` under `--fresh`. Its
documented purpose: "skip the empty pre-deploy block range" so the
indexer cron doesn't waste budget on backfilling. Its actual
behavior: **jumps the cursor past any pre-existing on-chain events
that were created before now**.

The user's purge today (separate from a `--fresh` run) wiped the
cursor to zero rows. Then somewhere the seed helper ran, writing the
cursor at current safe-head (~267,150,000). The `[deploy_block,
seed_point]` range — containing yesterday's flow-test offers — was
never scanned.

The user's simple-but-correct framing: **after a purge, the cursor
should start from `deployBlock`, not from `safe-head`.** The natural
`chainIndexer.ts:242` fallback already does this — `lastBlock =
cursorRow ? BigInt(cursorRow.last_block) : deployBlock - 1n`. The
seed helper was clobbering the natural fallback.

### Layer 4 — Auto-reseed removal + orphan-state guard

Two additional source-level fixes landed on top of the
deployBlock helper:

1. **Removed the auto-`seed_indexer_cursor_safe_head` invocation
   from `phase_contracts`** under `--fresh`
   ([deploy-testnet.sh:822](../../contracts/script/deploy-testnet.sh#L822)).
   The natural fallback is correct in both cases:
   - Fresh deploy with no prior events: `deployBlock ≈ current
     safe-head`, so the cron's `scanFrom > head` short-circuit
     fires after one ~30-block scan that picks up admin role-grants
     + init calls. Zero wasted work.
   - Purge with pre-existing on-chain events: cron scans from
     deployBlock forward, recovers all events naturally.
   The seed helper is left in the script for manual operator use
   if a future scenario genuinely needs it, but no longer auto-runs.

2. **Pre-archive orphan-state guard** in both `deploy-testnet.sh`
   and `deploy-mainnet.sh`. Before `archive_chain_state` runs under
   `--fresh`, the script now reads `getActiveOffersCount()` +
   `getActiveLoansCount()` from the prior Diamond. If either is
   non-zero, the script refuses with a clear error message
   explaining the on-chain-vs-off-chain consequence ("a --fresh
   archives OFF-chain artifacts but cannot wipe ON-chain Diamond
   storage; post-deploy, those offers/loans still exist on the
   prior Diamond, but every off-chain consumer points at the new
   one"). Operator can override with
   `--confirm-orphans-prior-onchain-state` for the genuinely-
   intentional planned-migration case. Mainnet variant has
   stricter wording ("THIS IS REAL-MONEY MAINNET STATE") and
   requires THREE deliberate flags to bypass:
   `--fresh`, `--confirm-purging-prior-mainnet-deploy`,
   `--confirm-orphans-prior-onchain-state`.

   The guard catches the exact scenario that produced today's
   incident: a `--fresh` running against a chain whose Diamond
   has live state. Off-chain consumers (indexer, frontend, keeper)
   would silently lose visibility of those offers/loans without
   the guard. With it, the operator either confirms the orphan or
   winds down the prior Diamond's state first.

### Mainnet implication

Arbitrum One mainnet (chainId 42161) is **in scope** for Phase 1
([CLAUDE.md Cross-Chain Security Policy](../CLAUDE.md)) — Ethereum,
Base, Arbitrum, Optimism, Polygon zkEVM, BNB Chain. Without the
Layer 1 fix, the mainnet deploy would have stamped an L1-range
block as `deployBlock` for Arbitrum, causing the same indexer
cold-start failure in production. This is exactly the kind of
testnet-rehearsal value-add the user has been pushing for — the bug
surfaced on testnet with zero economic impact and forced a fix that
mainnet would otherwise have inherited silently.

## Both Safe batches executed + verified

Operator executed both Safe Transaction-Builder batches via
`app.safe.global → Apps → Transaction Builder` later the same day.
Post-execute `cast call peers(uint32)(bytes32)` readback against
every (oapp, eid) pair returned the expected right-padded peer
address — none returned `bytes32(0)`. Verification matrix:

| Lane | base-sep ↔ arb-sep | base-sep ↔ sep | arb-sep ↔ sep |
|------|:------------------:|:--------------:|:-------------:|
| VPFI lane (OFT)    | ✓ both directions | ✓ both directions | n/a (mirror-only) |
| Buy lane           | ✓ both directions | ✓ both directions | n/a (mirror-only) |
| Reward mesh        | ✓ both directions | ✓ both directions | ✓ both directions |

All 14 setPeer legs landed. Cross-chain LayerZero packets can flow
in every direction across the three-chain testnet mesh. WireVPFIPeers
phase is **complete** for the testnet rehearsal.

## Late-session frontend reliability + indexer-first migration wave

The OfferBook empty-data report opened a long thread that ended
up closing **every cross-cutting frontend reliability gap** the
codebase carried. Twelve commits landed, in roughly three groups:

### Group 1 — chain-switch reactivity (`fdb6ebe`, `9eed21e`)

Six hooks had module-scope caches keyed without `chainId`
(`useActiveOffersByAssetPairRanked`, `useDashboard{Offers,Loans,
LoansBothSides,Claimables}`, `useProtocolConfig`). Switching the
wallet from arb-sepolia to base-sepolia served the previous
chain's rows from cache until the user clicked the manual refresh
button — the bug the user reported with "after the chain change
the offers and loans only load after clicking the refresh
button." Cache keys now chain-prefixed; the lookup naturally
misses on chain switch and refetches.

Six hooks gained `if (!chain.diamondAddress) return` short-
circuits to stop firing `readContract` calls against
`ZERO_ADDRESS` (the `useDiamondRead` fallback when no Diamond
exists on the connected chain). Surfaced 2026-05-10 in the
diagnostics drawer as a `getProtocolConfigBundle` + 4 sibling
errors from chainId 421614 + wallet-not-connected.

The OfferBook surface also got a separate fix: the `indexerServingOpen`
gate at `OfferBook.tsx:502-524` now also requires the indexer's
result to agree with the on-chain log index. When the indexer
returns empty `[]` but `useLogIndex` has scraped real
`OfferCreated` events from the chain (the stale-indexer scenario
from the 2026-05-11 cursor-skipped-range bug earlier today), the
gate flips to false → falls through to the legacy log-scan path
→ auto-load fires at mount. No more "click Load More to see your
offers" UX bug.

### Group 2 — source-level `useReadyDiamond` helper (`048d14a`, `e1d017d`)

Diagnostics audit revealed the null-diamondAddress bug class was
broader than 6 hooks — ~30 more hooks read from the Diamond
without per-hook guards. Manual per-hook patches don't scale and
future hooks would need a reviewer to remember the pattern.

Added two helpers to `apps/defi/src/contracts/useDiamond.ts`:
- `useReadyDiamond()` returns `DiamondHandle | null` (null when
  `chain.diamondAddress` is null)
- `useReadyDiamondClient()` returns
  `{ client, diamond, chain } | null` for hooks that drive
  multicalls directly

Migrated 10 hooks: `useLoan`, `useKeeperStatus`, `usePositionLock`,
`useEscrowUpgrade` (newly fixed), and the 6 already-guarded hooks
consolidated to the helper. Net code change: −20 lines, codebase
uniformly safe. Future hooks adopt the helper naturally; the null
check is impossible to forget at the call site.

### Group 3 — RPC-quota-reduction refactors (`8432aaa`, `7e24172`, `e4e83a5`, `b283d85`)

`useClaimables` and `useUserLoans` were walking every loan in the
protocol per dashboard mount (3-6 sequential RPCs per loan × 40+
loans on a populated chain). Replaced with a 3-layer narrowing:

1. **Indexer HTTP** — `fetchLoansByLender` + `fetchLoansByBorrower`
   (parallel, ~50-100ms total).
2. **On-chain user-filter view** — `getUserDashboardClaimables` /
   `getUserDashboardLoans` server-side filtered, one multicall
   (~200ms).
3. **Walk-all knownLoans** — legacy, originally Layer 3 fallback;
   later dropped when the user observed that Layer 2 is
   authoritative for everything the storage index tracks.

Mid-wave regression caught (`e4e83a5`): the original 3-layer
treated an indexer `{loans: []}` empty page as authoritative,
short-circuiting before Layer 2 ever ran. On arb-sepolia (where
the indexer cursor was reseeded past historical events earlier
today), every user appeared to have zero claims even when the
chain held them. Fix: trust Layer 1 only when its pages return
>0 entries; empty → fall through.

Then walk-all dropped entirely (`b283d85`): with on-chain Layer 2
authoritative for `userLoanIds`-tracked loans, the legacy walk-all
just burned RPC quota for nothing on chains where the view exists.
Trade-off: secondary-market NFT recipients (users who received a
position NFT via Transfer rather than as the LoanInitiated party)
become invisible until the planned by-current-holder support
lands. That work followed immediately.

## Secondary-market NFT recipient support (full feature, 8 commits)

The walk-all drop intentionally regressed the secondary-market
NFT-recipient case — users who hold a position NFT they didn't
mint (received via ERC721 Transfer) couldn't see their claims.
Closed via full layered support across contracts + indexer +
frontend.

### Contracts (`bf6a3ef`, `f7032f8`, `a457bd1`)

Storage: new `offerIdByPositionTokenId` reverse map in
`LibVaipakam.Storage` mirroring the existing `loanIdByPositionTokenId`.
Populated in `OfferFacet._writeOfferFields` at offer creation;
cleared in `OfferCancelFacet.cancelOffer` and in
`LibMetricsHooks.onLoanInitiated` (when the offer's position NFT
transitions to a loan position).

Two new views on MetricsFacet:
- `getUserPositionLoans(user) → (loanIds[], tokenIds[])`
- `getUserPositionOffers(user) → (offerIds[], tokenIds[])`

Both walk `ERC721Enumerable` (`balanceOf(user)` +
`tokenOfOwnerByIndex(user, i)` over `[0, balance)`) and resolve
each tokenId via the existing/new reverse map. O(user's NFT
count) — typical user holds 1-20 position NFTs; constant-time
enumeration vs. the O(all loans) walk the legacy views did.

DeployDiamond.s.sol hand-maintained `_getMetricsSelectors()`
array bumped from 38 → 40 to register the two new selectors.
Caught by a `0xa9ad62f8` (FunctionNotFound) revert on first
anvil smoke test — the selector array is the second hand-
maintained spot after the new view itself; both have to be in
sync. End-to-end verified on anvil after PartialFlows populate:
every test wallet's `balanceOf` exactly equals
`loans.length + offers.length` from the new views.

### Indexer (`a7308da`, `41ac564`)

D1 migration 0012 adds three columns + indexes:
- `loans.lender_current_owner`
- `loans.borrower_current_owner`
- `offers.creator_current_owner`

`chainIndexer.ts` gains an ERC721 Transfer event handler that
fires batched UPDATEs on every non-burn transfer: token-id keyed
against `loans.lender_token_id` / `loans.borrower_token_id` /
`offers.position_token_id`. Plus initial seeding at LoanInitiated
+ OfferCreated time so the no-transfer case is correct out-of-
the-box. The migration backfills existing rows.

Two new GET endpoints:
- `/loans/by-current-holder/:addr` — union of lender+borrower-
  side holdings via the new columns
- `/offers/by-current-holder/:addr` — creator-NFT holdings

Both are pure D1 lookups — zero RPC cost per request. Unlike the
existing `/loans/by-lender` route which multicalls `ownerOf` per
loan at query time.

### Frontend Layer wires (`4d65f06`, `86b65ba`)

`useClaimables` + `useUserLoans` Layer 1 switched from
`(fetchLoansByLender + fetchLoansByBorrower)` parallel pair to a
single `fetchLoansByCurrentHolder` call — one HTTP call instead
of two, NFT-holder-keyed (covers secondary-market). Layer 2
switched from `(getUserDashboardClaimables + getUserDashboardLoans)`
parallel pair to a single `getUserPositionLoans` call — one
on-chain read instead of two, also NFT-holder-keyed.

`indexerClient` exports `fetchLoansByCurrentHolder` and
`fetchOffersByCurrentHolder` with `HolderLoansPage` /
`HolderOffersPage` response types.

### What this unlocks

Three end-state properties of the read path that didn't exist
before today:
1. **Secondary-market NFT recipients are visible** at both layers
   without per-hook event scanning or walk-all fan-out.
2. **One HTTP / one on-chain call** per ClaimCenter or Dashboard
   mount (was two of each prior).
3. **Zero RPC quota on the happy path** — indexer Layer 1 serves
   the answer; Layer 2 only fires when the indexer is unreachable
   AND the user has on-chain data the indexer hasn't seen yet.

The prelive arb-sepolia + sepolia + base-sepolia deploys don't
yet carry the new MetricsFacet selectors / `offerIdByPositionTokenId`
storage / `0012_current_holder` D1 migration. That ships in the
next coordinated deploy cycle — testnets are scheduled for
redeploy anyway, so cutting it on the next scheduled rehearsal
is the natural delivery vehicle. anvil end-to-end smoke confirms
the surface works.

## Late-session frontend reliability — `PRIVATE_KEY` rename, watermark singleton, app-chain-pinned public client

Three changes that all share one motif: cutting **fan-out** by moving
the right primitive to a single canonical site.

### `PRIVATE_KEY` → `DEPLOYER_PRIVATE_KEY` sweep (36 files)

The bare `PRIVATE_KEY` env slot was ambiguous against the role-
prefixed siblings (`ADMIN_PRIVATE_KEY`, `KEEPER_PRIVATE_KEY`,
`LENDER_` / `BORROWER_` / `NEW_LENDER_` / `NEW_BORROWER_PRIVATE_KEY`,
`REWARD_PRIVATE_KEY`). `DEPLOYER_PRIVATE_KEY` makes the role explicit
and matches how the deploy scripts already read `DEPLOYER_ADDRESS` as
the paired var. Sweep regex was
`(?<![A-Za-z0-9_])PRIVATE_KEY(?![A-Za-z0-9_])` so every role-prefixed
sibling is preserved verbatim and `deploy-peers.sh`'s
`ORIGINAL_PRIVATE_KEY` trap (its restore mechanism) keeps working.
`forge build --force --skip test` confirmed clean compile.

### Watermark probe — per-instance fan-out → singleton

`useLiveWatermark` grew to 16 call sites across hooks and components,
several of them mounted on every page (`IndexerStatusBadge` in
`AppLayout`, plus `useLogIndex` + `useOfferStats` + `useIndexedLoans`
+ `useIndexedActivity` from Dashboard, plus the OfferBook hot-tier
subscriber). Each call site spawned its own `setTimeout` loop firing
TWO `eth_call`s per tick (`getGlobalCounts` + `getBlock({safe})`). The
timers drifted out of phase so they didn't fire together — visible
in DevTools as a near-continuous trickle of RPC reads. Dashboard
landed at ~12 reads per 30 s.

Refactor hoists the probe loop into a Context-provided singleton:
new `WatermarkProvider` in `apps/defi/src/context/WatermarkContext.tsx`
runs ONE timer per `(chainId, diamondAddress)`. Subscribers register
on mount via `useWatermarkContext`, deregister on unmount; the provider
takes the **min** of all subscribers' currently-effective active
intervals as the next probe cadence (so a `hot`-tier subscriber pulls
everyone to 5 s, absent that `warm` 30 s wins, absent both `cool`
180 s wins). Activity gating — `idleAfterMs` → `idlePollIntervalMs`,
`pausedAfterMs` → no timer — is evaluated per-subscriber on every
reschedule. Register / unregister calls clear the pending timer and
reschedule so a brand-new fast subscriber doesn't wait on the previous
slow tick. Tab-visibility + user-activity logic centralised in the
provider, unchanged in semantics.

API surface unchanged. Every existing `useLiveWatermark(opts)` call
site keeps compiling without edits. Types (`UseLiveWatermarkOptions` /
`WatermarkSnapshot` / `WatermarkStatus` / `UseLiveWatermarkResult`)
re-exported from `useLiveWatermark.ts` so external imports compile
clean. Dead `probeWatermarkOnce` export dropped (zero callers in tree).

Expected effect: Dashboard 12 reads / 30 s → ~2 reads / 30 s (one
batch per cadence tier from one timer). Network-tab trickle collapses
to one batched probe per cadence step instead of drifting waves.

### App-chain-pinned `useDiamondPublicClient` everywhere — chain-leakage class fix

Bare `usePublicClient()` (no `chainId` arg) returns the **wallet's**
current chain client in wagmi v2, which diverges from the
**app-selected** chain (ChainContext via `useReadChain`) whenever
the user changes the chain dropdown but their wallet hasn't followed
yet (typical UX: in-app switch first, then a separate wallet prompt).
The diamond address correctly tracks the app chain because every
caller reads it from `useReadChain`, but the `publicClient` continues
hitting the previous chain's RPC. Net effect:
`eth_call(prevChainRPC, newChainDiamondAddress)` — silent failure on
the read path, but the request hits the OLD chain's URL in the
network tab. That's exactly what surfaced post-singleton-refactor:
once the watermark stopped fanning out across 6 independent timers,
the remaining single probe was easy to inspect, and the chain
leakage became visible.

Six call sites carried this bug, all preceding the watermark refactor
— it just wasn't inspectable through the noise. Migrated each one to
`useDiamondPublicClient()` (canonical wrapper in
`contracts/useDiamond.ts` — `usePublicClient({ chainId: chain.chainId })`
with a transport-only http fallback for chains wagmi hasn't bound):
`WatermarkContext`, `useIndexedActiveOffers`, `useIndexedLoans`,
`useERC20`, `CreateOffer`, `BuyVPFI`. `useLiquidationQuotes` was the
one legit exception (caller-parameterised `chainId` for cross-chain
liquidation quoting); kept with an inline `eslint-disable` carve-out
and an explainer.

Regression-prevention: ESLint `no-restricted-imports` rule banning
direct `usePublicClient` import from `'wagmi'`, with an explanatory
message pointing to `useDiamondPublicClient`. Carve-out for
`useDiamond.ts` itself (it owns the wrapper and must import the
underlying bare hook). Zero `no-restricted-imports` violations
across the codebase after the migration.

### What this unlocks

End-state properties of the read path that didn't exist before today:

1. **Chain switch is now structurally correct.** Dropdown change →
   diamond AND publicClient both flip to the new chain in one effect
   cycle. No mid-switch limbo where reads target the previous chain's
   RPC.
2. **Network-tab traffic is inspectable.** One probe timer instead of
   six = clear cause-and-effect when investigating which surface
   fires which call.
3. **Future regressions caught at lint.** A new hook that
   accidentally imports `usePublicClient` from `'wagmi'` fails the
   build with a pointer to the right primitive.

## Release-notes mid-stream date roll

The conversation that produced this release-notes file started on
2026-05-10 and rolled over to 2026-05-11 mid-session. The work
documented here lands on the 2026-05-11 file by date-of-completion
convention; the predecessor file `ReleaseNotes-2026-05-10.md` covers
the deploy rehearsals + Phase 2 hardening that closed out the prior
day.
