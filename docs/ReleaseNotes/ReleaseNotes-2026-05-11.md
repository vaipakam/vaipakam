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

## Fresh testnet redeploy — base-sepolia + sepolia (2026-05-11)

Both Phase-1 testnets fresh-deployed off the current contracts tree
(`REWARD_VERSION=v4-rehearsal-2026-05-11`), then the consumer surface
(indexer, keeper, agent Workers + the two SPAs) redeployed against the
new addresses + ABIs. Deployer/admin EOAs retained — handover to the
governance Safe deliberately skipped per the rehearsal policy (testnet
flow-test scripts broadcast against ADMIN-gated functions; a handover
would break them).

### Live addresses

| Chain | Diamond | RewardOApp proxy (CREATE2 cross-chain identical) |
| --- | --- | --- |
| base-sepolia (84532, canonical-VPFI) | `0x725C7912956b254030A2DBF152B2F739C46C07c0` | `0x8CA436fae773b058851F364a1ea77588889E53f4` |
| sepolia (11155111, mirror) | `0x492f83F2Ab99B7b13E1F8CAf6fbAeB7300B85302` | `0x8CA436fae773b058851F364a1ea77588889E53f4` |

Both RewardOApp proxies landed at the same address — confirms the
CREATE2 salt (derived from `REWARD_VERSION`) was seeded identically on
both deploys, so cross-chain reward-mesh parity holds.

Master kill-switch flags on both chains: `rangeAmountEnabled=true`,
`rangeRateEnabled=true`, `partialFillEnabled=true` (testnet ergonomics
— mainnet ships these dormant). On base-sepolia the deploy script's
`partialFillEnabled` cast-send silently failed (RPC-side timing — no
status echo), so it was flipped manually post-deploy; sepolia's set
cleanly.

### Phases run

- **base-sepolia**: `preflight → contracts --fresh → configure → verify`,
  plus the full flow-test suite (PartialFlows Phase A+B = 13 UI-midpoint
  scenarios; PositiveFlows = 31/31 — 15 legacy lifecycle + 16
  new-features incl. range-match, partial-fill, preclose options 2/3,
  refinance, keeper-per-action, sanctions Tier-1/2, stuck-token
  recovery).
- **sepolia**: `preflight → contracts --fresh → configure → verify`.
  No flow tests (mirror chain — single-chain flows would just duplicate
  base-sepolia's coverage).
- **lz-config + swap-adapters skipped on both**: those phases need
  operator-supplied env vars (DVN set, LZ libraries, REMOTE_EIDS for
  lz-config; INITIAL_SETTLERS for swap-adapters) that aren't load-
  bearing for single-chain flow tests. Cross-chain reward routing +
  DEX swap failover stay un-rehearsed on this cycle.

### Consumer surface redeployed

| Surface | URL | Notes |
| --- | --- | --- |
| Indexer Worker | `indexer.vaipakam.com` | D1 migration `0012_current_holder` applied — adds `lender_current_owner` / `borrower_current_owner` to `loans`, `creator_current_owner` to `offers`, 3 indexes. Cron `* * * * *`. |
| Keeper Worker | `vaipakam-keeper.dawn-fire-139e.workers.dev` | HF-liquidation autonomous keeper. Cron `* * * * *`. |
| Agent Worker | `vaipakam-agent.dawn-fire-139e.workers.dev` | Notifications + frames + quote/scan proxies (4 rate-limiters). Cron `* * * * *`. |
| defi SPA | `vaipakam-defi.dawn-fire-139e.workers.dev` | 8-locale vite build, static-assets Worker. |
| www site | `vaipakam-www.dawn-fire-139e.workers.dev` | Static-assets Worker. |

Every Worker passed the per-Worker `RPC_BASE_SEPOLIA` secret-presence
check. The consolidated `packages/contracts/src/deployments.json`
(read by all five) was refreshed; **arb-sepolia retired** from the
bundle (commented out in `contracts/deployments/.active-chains` for
this rehearsal cycle — the on-disk artifact stays for forensic value
but it stops appearing in the frontend chain picker and stops being
crawled).

### Two bugs fixed in-flight

1. **`BASE_SEPOLIA_SEQUENCER_UPTIME_FEED` pointed at a Base MAINNET
   address with zero bytecode on Base Sepolia.** `ConfigureOracle`
   wrote it to storage; `checkLiquidity` then reverted with "call to
   non-contract address" (forge's pre-call code probe fails before the
   on-chain `try/catch` can swallow it). Set to `address(0)` —
   `OracleFacet._requireSequencerHealthy` / `_sequencerHealthy` both
   short-circuit on zero, which is the right behaviour for testnet
   (the sequencer-down scenario isn't a meaningful failure mode there).
   Fixed on-chain (`OracleAdminFacet.setSequencerUptimeFeed(0x0)`) +
   in `.env` so the next rehearsal doesn't re-trip it.

2. **`deploy-testnet.sh` `--fresh` D1-purge skipped when addresses.json
   was already archived.** The archive step and the D1 purge were both
   gated on `existing_diamond = jq .diamond addresses.json`. After a
   prior half-failed `--fresh` moved the artifacts into `.archive/<ts>/`,
   a re-run saw "nothing to archive" and silently skipped the D1 purge
   too — stale rows from the prior Diamond would then pollute the new
   deploy. Extracted `purge_chain_d1()` out of `archive_chain_state` and
   fire it unconditionally under `--fresh`, regardless of whether the
   on-disk addresses.json is present. Chain-scoping (`WHERE chain_id =
   $CID`) preserved unchanged. `deploy-mainnet.sh` intentionally NOT
   touched — its `archive_chain_state` is archive-only by design
   (mainnet never auto-purges D1; the orphaned-position audit trail
   stays operator-driven).

3. **`AnvilNewPositiveFlows.s.sol` N12 (Keeper Per-Action
   Authorization) wasn't idempotent.** It called `approveKeeper(Bot,
   INIT_PRECLOSE)` without revoking first; on persistent-state testnets
   where `PartialFlows` Phase B's P-P scenario already granted Bot the
   same authorization, N12 reverted `KeeperAlreadyApproved()`. Added a
   `try revokeKeeper(Bot) {} catch {}` before the approve so multi-suite
   reruns work while the first-run case stays revert-free.

### Outstanding (deliberately not done this cycle)

- `--phase handover` — testnets stay deployer/admin-owned (policy).
- `--phase lz-config` + `--phase swap-adapters` — need operator env
  vars; not load-bearing for single-chain flow tests.
- Cross-chain reward-mesh peer wiring (`WireVPFIPeers.s.sol` /
  `oapp.setPeer`) — separate ceremony.

## Watermark cold-chain backoff + the data-freshness badge

Two follow-ups to the watermark singleton refactor, both in `apps/defi`.

### Cold-chain backoff

On a freshly-deployed chain (zero offers + zero loans — e.g. the
empty Sepolia OfferBook right after a `--fresh` redeploy) the watermark
probe was still firing at the hot-tier 5 s cadence
(`getGlobalCounts` + `getBlock` per tick), burning RPC for a chain that
has nothing for any data hook to display. `WatermarkContext`'s
`chooseInterval()` now checks the last probe: if it observed
`nextOfferId == 0n && nextLoanId == 0n`, the cadence stretches to 30 s
regardless of subscriber tier. The first non-zero counter is itself an
`advanced` event — it bumps `version` (subscribers refetch) AND
restores the tier-driven min cadence, so the chain "wakes up" within
~30 s of the first offer/loan landing. 30 s (not the 180 s `cool`
tier) because a fresh chain is typically one you're actively testing —
you want the first offer to surface promptly; it's still a 6× cut from
the 5 s heartbeat. On mainnet the chain is never cold so this never
fires. The offer's creator sees their own offer immediately anyway via
the post-tx receipt refetch; only another user's *first* offer lags up
to ~30 s.

The watermark probe IS the "is there any offer?" direct-view check
(`getGlobalCounts` is a one-call existence probe); the walk-all
fallback was already a no-op on an empty chain. So the only real cost
was the 5 s heartbeat itself.

### Data-freshness badge — green ⟺ frontier fresh ∧ idle

The top-bar `IndexerStatusBadge` answers "is what I'm looking at on
this page near-real-time?". It previously measured staleness as
`chainSafeHead − indexer.lastBlock`, which has two blind spots:

1. **It ignored the client-side RPC tail scan.** When the central
   indexer lags but the page's own chunked `eth_getLogs` catch-up
   (`useIndexedActiveOffers` / `useIndexedActiveLoans`, scanning
   `[indexer.lastBlock+1, watermark.safeBlock]` on top of the indexer
   page) has reached head, the *displayed data* is fresh-to-head — but
   the badge screamed "5000 blocks behind".
2. **It said nothing about whether the page was still fetching.** A
   fresh frontier doesn't mean the DOM is done painting — a
   `getLoanDetails` multicall fan-out or an offer-page paginator can
   still be running after the frontier is fresh.

New model: a `DataFreshnessContext` registry that data hooks report
into. Each source reports `{ frontier?, loading? }`:

- `useOfferStats` → the central indexer's `lastBlock` + loading.
- `useIndexedActiveOffers` / `useIndexedActiveLoans` → their RPC
  tail-scan's upper bound (`watermark.safeBlock`) when the catch-up
  actually ran + loading.
- `useIndexedLoansForWallet` / `useUserLoans` / `useLogIndex` →
  loading only (they read point-in-time / don't track a scanned range).

The badge then derives two facts: `maxFrontier` (max scanned-through
block over all sources — so the RPC tail that filled the indexer's gap
gets credited) and `anyLoading` (OR of every reporter's loading flag).
Gap = `chainSafeHead − maxFrontier`. **Live (green) ⟺ gap < 100 blocks
AND nothing loading** — the trustworthy state. State machine:

- **Live** (green, Wifi) — fresh frontier AND idle. What you see =
  what's on chain right now.
- **Live · updating** (green, spinning icon) — fresh frontier, but a
  fetch is in flight (someone created an offer / a loan landed). Data
  on screen is fresh; a row or two more may appear in a moment.
- **Catching up** (amber) — gap below the severe threshold.
- **Behind** (red) — gap ≥ 5000 blocks. Operator-actionable.
- **Loading** (amber, spinning) — cold load, no frontier reported yet.
- **Live (direct RPC)** (green) — indexer worker unreachable, but the
  watermark probe is healthy and the log-scan path (always reaches
  head) is serving the page.
- **Live chain scan** (amber) — indexer AND watermark both unhealthy.
- **Local dev** (blue) — wallet on Anvil/Hardhat.

The colour is purely gap-driven; the spinning-icon decoration conveys
"and a fetch is in flight" *without* a colour change, so the badge
doesn't flicker green↔amber on every quick background refetch (which
on a busy mainnet would be constant). The ⓘ popover gains a "Freshest
data block" row (annotated "via indexer" / "via RPC tail-scan"
depending on which source produced the max) and a "Fetch in progress:
yes/no" row.

The context resets on chainId change — a stale higher frontier from the
prior chain would falsely claim freshness on the new chain. It returns
inert defaults outside the provider, so the reporting hooks stay safe
to mount without the wrapper (tests / storybook).

### Not yet deployed

Both changes are `apps/defi` only — they need a `--phase cf-defi`
re-run to reach the live `vaipakam-defi` Worker. Contract / Worker
state from the 2026-05-11 fresh redeploy is unaffected.

## Live chain-safe-head readout + diagnostics-drawer mirror + i18n sweep

Follow-ups to the data-freshness badge, all `apps/defi`.

### Live "Chain safe head" in the badge popover

The popover's safe-head row showed the watermark snapshot's `safeBlock`
— only as fresh as the last probe (5–30 s). Added a dedicated
`getBlock({safe})` poll that runs ONLY while the popover is open (2 s
cadence; popovers are open for seconds, so the RPC cost is bounded).
The row seeds from the watermark snapshot, then refines to the true
safe head and ticks up as blocks finalise — a small pulsing green dot
marks the value as live-polled. On close the poll stops and the last
value is dropped so the next open re-seeds fresh. This is the chain's
*actual* safe head, deliberately distinct from `maxFrontier` (what the
on-screen data covers — the data lags the chain head by design;
conflating the two would hide real staleness). On rollups
(Base/Arbitrum, where `safe ≈ latest`) the number visibly ticks every
~2 s; on L1 Sepolia it snaps forward in jumps when an epoch finalises.
`publicClient` comes from `useDiamondPublicClient()` so it follows the
chain dropdown like the rest of the read layer.

The row label was renamed from "Last safe block (available)" to "Chain
safe head" (with a "(live)" suffix while the poll is active) — clearer,
and the rename flows through to the ChainDiagnosticsPanel mirror too.

### Diagnostics drawer — "Chain & Indexer" card now carries the freshness rows

The diagnostics drawer's `ChainDiagnosticsPanel` (the operator-grade
deep view, above the journey-events feed) gained the same three
signals the badge popover surfaces:

- **Freshest data block** — `maxFrontier` from `DataFreshnessContext`,
  annotated "(via indexer)" or "(via RPC tail-scan)" by which source
  produced the max. Distinct from the existing "Last safe block
  (indexed)" row, which is the central indexer's frontier only —
  `maxFrontier` also folds in every client-side RPC tail-scan's
  scanned-through block.
- **Chain safe head (live)** — the same 2 s `getBlock({safe})` poll as
  the badge popover, but gated on the panel being *expanded* rather
  than the popover being open. Pulsing-dot indicator; falls back to
  the watermark snapshot until the first poll resolves.
- **Fetch in progress** — `anyLoading` (yes/no).

`Row` in both the badge popover and the diagnostics panel was widened
from `value: string` to `value: ReactNode` so the live-dot can render
inline.

### i18n — new keys translated across all 8 locales

`statusChainSafeHeadLive`, `statusFreshestBlock`, `viaIndexer`,
`viaRpcTail`, `statusFetchInProgress`, `statusFetchYes`,
`statusFetchNo`, `liveSafeBlockTooltip`, plus the `loading*` and
`liveUpdating*` popover heading/body strings — added to en, zh, ja, ar,
ta, ko, fr, de with proper translations (not en-fallback). The
`statusChainSafeHead` value was also retranslated in every locale
("Chain safe head" / "链上安全区块" / "チェーンの確定ヘッド" / "رأس
السلسلة الآمن" / "சங்கிலியின் பாதுகாப்பான ஹெட்" / "체인 안전 헤드" /
"Tête sûre de la chaîne" / "Safe-Head der Chain"). All 8 JSON files
validated; tsc clean.

## Indexer event-sourcing completeness — drift fix, missing handlers, payload completeness, guardrail

Triggered by "no claims showing for wallet 0xE873… on base-sepolia".
Root cause turned out to be deeper than the symptom: the indexer's
`loans` table had every flow-test loan stuck `active` even though most
had closed on-chain. Three interlocking problems, all now fixed.

### The drift — and why claimables came back empty

`apps/indexer/chainIndexer.ts` hand-maintained its event-decode
allow-list as a `parseAbi([...])` of literal signature strings, and
several had **drifted** from the deployed event shapes:

| event | indexer's typed sig | actual on-chain sig |
| --- | --- | --- |
| `LoanRepaid` | 4 args | 7 args (`…, outstandingPrincipal, accruedInterest, newStatus`) |
| `LoanDefaulted` | 2 args | 3 args (`…, newStatus`) |
| `PartialRepaid` | 3 args | 4 args (`…, accruedInterest`) |
| `OfferAccepted` | 3 args | 6 args (`…, matchAmount, newAmountFilled, newAccepted`) |
| `OfferMatched` | 8 args | 10 args (`…, borrowerAmountFilled, borrowerAccepted`) |
| `LenderFundsClaimed` / `BorrowerFundsClaimed` | 4 args | 5 args (`…, newBothClaimed`) |
| `BorrowerLifRebateClaimed` | 3 args | 4 args (`…, newEscrowVpfiBalance`) |

A wrong arg count changes the keccak event signature → different
`topic0` → the indexer never matched the log. So **`LoanRepaid` and
`LoanDefaulted` were never being decoded** — loans never flipped
terminal — and `/claimables/:addr` (which is computed from terminal
loans) returned empty for everyone. Same drift class as the May-2026
"Watcher offer-decode" incident the CLAUDE.md warns about.

On top of that, four terminal *paths* emitted events the indexer had
no handler for at all: `LoanPreclosedDirect` (preclose option 1),
`OffsetCompleted` (preclose option 3 — keyed by `originalLoanId`),
`LoanRefinanced` (keyed by `oldLoanId`), and the loan-sale events.

### Fix 1 — derive `EVENT_ABI` from the compiled bundle

`EVENT_ABI` is now built from `DIAMOND_ABI_VIEM` (the compiler-emitted
ABI bundle), filtering `type === 'event'` and deduping by canonical
signature (the bundle re-exports each facet verbatim, so `OfferClosed`,
`LoanSettlementBreakdown`, the `SwapAdapter*` trio, `Transfer`/`Approval`
appear in several facets — `decodeEventLog` throws on ambiguous
selectors, so dedupe keeping the first). The decode surface is now
incapable of drifting. (`OfferMatchFacet` was also missing from the
exported bundle entirely — added it to `exportFrontendAbis.sh`'s
`FACETS=(...)` list and the `packages/contracts/src/abis/index.ts`
barrel + `DIAMOND_ABI` spread, so its `OfferMatched`/`OfferClosed`
events are in the bundle now.)

### Fix 2 — handle the missing loan-state-change events

New branches in the loan-event dispatch:
`LoanPreclosedDirect` → flip Active→Repaid; `OffsetCompleted` → flip
`originalLoanId` Active→Repaid; `LoanRefinanced` → flip `oldLoanId`
Active→Repaid; `PartialRepaid` → `UPDATE loans.principal = newPrincipal`;
`CollateralAdded` → `UPDATE loans.collateral_amount = newCollateralAmount`;
`LoanObligationTransferred` → `UPDATE loans.borrower = newBorrower`.
`flipLoanStatus` gained an optional `loanIdOverride` for the non-`loanId`-
keyed terminal events. Deliberately not mirrored (documented inline):
the fallback states (transient — D1 stays `active` through the episode),
the loan-sale events (original loan stays Active with a new lender —
covered by the Transfer handler; the sale's internal temp-loan
Active→Repaid has no status event — contract-side follow-up), keeper /
`*Details` companion / `OffsetOfferCreated` events (not in schema).

Backfill: redeployed `vaipakam-indexer` with the fixed code, then
purged D1 for chain 84532 so the cron re-crawls from `deployBlock`.
Result: 33 base-sepolia loans, **22 now correctly terminal — was 0**.
(The re-crawl's `getLoanDetails` read-backs were erroring during the
catch-up, leaving rows `is_stub=1` with `token_ids='0'`; the
`refreshStaleLoanTokenIds` cron lane heals those over the next few
ticks. `/claimables/:addr` excludes stub rows, so it stays empty until
the heal completes — but the Claims *page* doesn't depend on that
endpoint: `useClaimables` reads each loan's details on-chain per-loan,
so it surfaces claims as soon as the loan-status flip lands.)

### Fix 3 — contract event payload completeness

Audit follow-up: a `state-change/*` event should carry the **primary
key + the post-state of every field it changes** so an indexer can
`UPDATE` from the payload without a read-back. Four events were carrying
deltas or implying state via the event name:

- `PartialCollateralWithdrawn` — added `newCollateralAmount` (was only
  carrying the `amount` delta; mirrors `CollateralAdded.newCollateralAmount`).
- `LoanObligationTransferred` — added `newCollateralAmount` (carried the
  new duration / rate / due-timestamp but not the new collateral).
- `OffsetCompleted` — added `uint8 newStatus` (the original loan's
  Active→Repaid transition was only implied by the event name).
- `LoanRefinanced` — added `uint8 oldLoanNewStatus`, same rationale.

`forge build` clean; the preclose / refinance / withdrawal / scenario8
suites pass (the four `vm.expectEmit` topic-only test sites updated).
The ABI re-export + the indexer's `PartialCollateralWithdrawn` handler
+ the facet redeploy land together in the next deploy cycle (changing
an event signature changes its `topic0`, so a half-deploy would leave
the indexer unable to decode in-flight events).

### Fix 4 — the guardrail (so this can't recur)

New `apps/indexer/scripts/check-event-coverage.mjs`: fails (exit 1) if
any contract event tagged `@custom:event-category state-change/loan-mutation`
or `state-change/offer-mutation` lacks a `log.eventName === '...'`
handler in `chainIndexer.ts` AND isn't in the script's
`DELIBERATELY_NOT_HANDLED` allowlist (each entry carries a one-line
reason; it also warns about stale allowlist entries — events that no
longer exist or have since been handled). Wired into
`pnpm --filter @vaipakam/indexer typecheck` and exposed standalone as
`pnpm --filter @vaipakam/indexer check-event-coverage`; documented in
CLAUDE.md. Current state: 33 enforced state-change events — 19 handled,
14 allowlisted. So a new loan/offer state-change event in the contracts
must either be handled in the indexer or consciously allowlisted — "the
indexer is a projection of on-chain state; keep it complete" is now
enforced, not aspirational.

### Also: the "no claims" immediate cause

Separately from all the above, the user's browser was pinned to a
months-old SPA bundle (`index-CfQ31b3L.js`) via the PWA service worker
— that bundle, built without `.env.local`, resolved `deployBlock` to 0
and tried to scan the chain from genesis in 10-block windows
(`getLogs 0-9: rate-limited`). `useLogIndex` failing → `knownLoans`
empty → `useClaimables` had nothing to walk. Fixed in earlier commits
this session (`loadLoanIndex` genesis-scan guard; `DEFAULT_CHUNK`
10→2000; the SW rewritten to network-first HTML so deploys propagate on
the next load). One-time fix for already-stuck clients: DevTools →
Application → Service Workers → Unregister → reload.

## Indexer: companion-event-driven inserts, stub-heal rename, and a cron-stall fix

Follow-up to the event-coverage work, prompted by the stub rows the
base-sepolia re-crawl left behind (`is_stub=1`, `token_ids='0'`).

### Why stubs happen, and how to stop them

The `LoanInitiated` handler did a `getLoanDetails(loanId)` RPC read-back
on every loan creation to fill the row's asset metadata / rates / token
ids. When that RPC rate-limits → fall back to a stub row → the heal lane
fixes it on a later cron tick. That read-back is the *only* cause of
stubs.

But the contracts already emit a self-sufficient companion event,
`LoanInitiatedDetails(loanId, lender, borrower, LoanInitDetails details)`
— its natspec literally says "construct the entire loan row from this
event without a follow-up `getLoanDetails`". It was missing only two
fields the loans table needs: `lenderTokenId` / `borrowerTokenId`, the
position NFTs minted at loan creation. Added those to the `LoanInitDetails`
struct (loan creation is a storage write to `loan.lenderTokenId` /
`loan.borrowerTokenId`, so per "every state change → event with the
changed fields" they belong there). 22-field payload now.

The indexer's `LoanInitiated` handler now pre-indexes the
`LoanInitiatedDetails` companions (always in the same tx, so always in
the same scan window) and builds the whole row from `details` + the
bare event's `(offerId, lender, borrower, principal, collateralAmount)`
— no RPC at insert time → no stub-on-rate-limit. Three-tier fallback:
companion → `getLoanDetails` read-back (companion somehow absent, ~never)
→ stub. `startTime` / `lastPeriodicInterestSettledAt` aren't in the
event (block.timestamp is in the log envelope) — both equal
block.timestamp at creation, so `blockAt` is used. Net immediately: one
fewer RPC per loan creation; fully stub-free once the `LoanInitDetails`
struct change is on-chain. (Offer side still uses the `getOfferDetails`
read-back — switching it to consume `OfferCreatedDetails` is a
follow-up; offers heal via `refreshStubOffers`, no visible bug.)

### Rename: `refreshStubLoans` / `refreshStubOffers`

`refreshStaleLoanTokenIds` was a legacy name — it had grown to re-fetch
the FULL stub loan row, not just token ids. Renamed to `refreshStubLoans`
to match; `refreshStaleOfferDetails` → `refreshStubOffers` for symmetry.
Pure rename. (`is_stub` itself is not new — it's the existing fail-soft
flag from migrations 0008/0009; the stub state is transient and
self-healing, it just got exercised heavily by the re-crawl burst.)

### Cron-stall fix — `getLogs` + manual decode

Deriving `EVENT_ABI` from the full Diamond ABI (~80 events) had a sting:
`getContractEvents({ abi: EVENT_ABI })` with no `eventName` builds an
`eth_getLogs` filter whose `topics[0]` is an OR-array of *every* event
selector — and several RPC providers reject a filter with that many
OR'd topics. The call errored, the cron bailed on the same scan window,
retried forever from the same block, and Cloudflare backed the cron off
entirely — the base-sepolia cursor froze at block 41352522 and
`wrangler tail` showed no scheduled invocations. Fix: a plain
address-filtered `client.getLogs({ address, fromBlock, toBlock })` (no
topic filter — no provider limit), then `decodeEventLog` each log
against `EVENT_ABI` ourselves; logs whose topic0 isn't in our ABI
(config-facet events, ERC-721 Approval, …) throw on decode and are
skipped. After redeploy the cron resumed (cursor advancing, stubs
healing), and `/claimables/0xE873…` now returns loan 30 (a repaid
lender position the wallet still holds) — so the wallet's claim shows.

### Net result for "no claims showing"

End-to-end: indexer loan statuses correct (terminal events decoded),
stubs healed (0 loan stubs / 0 offer stubs on base-sepolia), cron
healthy, `/claimables` returns the wallet's claims. On the frontend the
Claims page reads each loan on-chain per-loan anyway, so it surfaces
the claim as soon as the loan-status flip lands — once the user is off
the stale SW bundle (DevTools → Application → Service Workers →
Unregister → reload).

## Freshness popover — show the indexer frontier AND the RPC-tail frontier separately

The badge popover collapsed two distinct freshness signals into one
`Freshest data block N (via indexer | via RPC tail-scan)` row — you saw
which source produced the max, not the other one's value. That hides the
case that matters: the central indexer is N blocks behind, but the
page's own RPC tail-scan (the chunked-getLogs catch-up over
`[indexer.lastBlock+1, safeHead]` run by `useIndexedActiveOffers` /
`useIndexedActiveLoans`) has reached the chain head — so the on-screen
data is fresh-to-head even though the badge says "Behind" — or,
conversely, the indexer is behind AND no tail-scan is running on this
page (so the page genuinely IS stale, "Behind" is honest).

The popover now shows three rows: **Indexer frontier** (the central
indexer's `lastBlock`), **RPC tail-scan** (how far the page's own
chunked-getLogs catch-up reached — `— (not running on this page)` when
no OfferBook/Dashboard hook is mounted), and **Freshest data block** (=
max of the two — what the on-screen data actually covers). The `(via X)`
annotation is dropped (redundant once both components are visible).
`blockGap` is unchanged — still `safeHead − maxFrontier`, so "Behind"
only fires when *neither* the indexer nor the tail has covered the gap.
The ChainDiagnosticsPanel mirror gains the "RPC tail-scan" row beside
its existing "Last safe block (indexed)" (= the indexer frontier). New
i18n keys (`statusIndexerFrontier` / `statusRpcTailFrontier` /
`statusFrontierIdle` / `statusRpcTailIdle`) added to all 8 locales.

Build note: a `tsc -p . --noEmit` check passed but missed two leftover
`frontierOrigin: null` lines because `apps/defi/tsconfig.json` is a
references file (no-op under `-p`); `tsc -b --noEmit` caught it. Use
`tsc -b` for apps/defi typechecks.

## RPC-tail freshness now credited on every data page, not just OfferBook/Dashboard

The badge's "RPC tail-scan" frontier only populated on the OfferBook
(hot cadence) and Dashboard/Risk-Watch (warm cadence) — the two pages
with a dedicated `chunkedGetLogs` catch-up hook. On other data pages
(Claims, Loan Details, Activity, the wallet-menu loan list) the badge
read "Behind" whenever the central indexer lagged — even though those
pages mount `useLogIndex`, whose `loadLoanIndex` IS an RPC tail-scan
(chunked `eth_getLogs` over `[max(localCursor, indexer.lastBlock)+1,
safeHead]`). `useLogIndex` reported `loading` to `DataFreshnessContext`
but not a frontier, so the badge couldn't credit it.

Fix (no new RPC — the scan already happens): `loadLoanIndex` /
`LogIndexResult` now carry `lastBlock` (the chain `safe` head the scan
reached), `useLogIndex` reports it as a frontier
(`report('logIndex', { frontier: result.lastBlock })`), and `'logIndex'`
is added to the badge + panel's `RPC_TAIL_FRONTIER_SOURCES` so it shows
under the "RPC tail-scan" row. Net: any page mounting `useLogIndex`
contributes the RPC-tail frontier → the badge shows "Live" once the
scan has caught up, across the data pages. Pages with no data hook
(FAQ, /help/*, settings) still show "Behind" if the indexer lags — by
design: nothing on those pages is on-chain data, and a blanket
always-on tail-scan in `AppLayout` would burn RPC for no benefit there.

## Diagnostics drawer — per-source freshness breakdown

The top-bar badge popover now shows the indexer frontier and the
RPC-tail frontier separately, but it only ever shows the *aggregate*
of the RPC tail-scans. The diagnostics drawer's "Chain & Indexer" card
(the operator-facing expand panel) now also lists each data lane
individually: one row per source currently mounted on the page, showing
the human-readable lane name, the block it has reached, and whether a
fetch is in flight right now.

The lanes come straight from `DataFreshnessContext`'s `bySource`
registry — `offerStats` (the central indexer's `lastBlock`),
`activeOffers` / `activeLoans` (the OfferBook / Dashboard chunked-
getLogs catch-ups), `logIndex` (the legacy log scan that runs on most
data pages), and `userLoans` / `roleLoans` (loading-only lanes that
don't report a frontier). Only the lanes the current page actually
mounts appear; on a page with nothing on-chain (FAQ, settings) the
breakdown is empty.

This is what tells an operator *which* lane is behind when the badge
goes amber — "the central indexer is at block X but this page's own
RPC tail-scan is already at X+4000, so the data on screen is fresher
than the badge's pessimistic aggregate suggests", or conversely "every
lane is stuck at the same block, the page really is behind". The lane
labels are kept in English on purpose (operator detail naming internal
hooks / endpoints), consistent with the rest of the `chainDiagnostics.*`
namespace; the value strings (`block N · fetching|idle`) go through
i18n with English defaults.

## Diagnostics drawer — "Indexer endpoint" row was naming the wrong worker

The drawer's "Indexer endpoint" row was reading `VITE_AGENT_ORIGIN`
(the apps/agent worker — `agent.vaipakam.com`, the alerts / Blockaid
simulation / journey-log sink) instead of `VITE_INDEXER_ORIGIN` (the
apps/indexer worker — `indexer.vaipakam.com`, the D1 offer/loan read
API). The actual indexer data calls (`indexerClient.ts`, consumed by
`useOfferStats` and friends) were always hitting the right origin —
only the diagnostic label was wrong, a copy-paste leftover from when
the indexer + agent lived in one `ops/hf-watcher` worker before the
Stage 3 split.

Fix: `indexerClient.ts` now exports `indexerOrigin()` (a public
accessor over its existing private `baseUrl()`), and the panel reads
the endpoint through that — so the displayed value can never drift
from the URL the data calls actually use. The value is, and stays,
build-time operator config (`VITE_INDEXER_ORIGIN`, set in
`apps/defi/.env.local` for dev and the `apps/defi` build env for prod);
it is not fetched at runtime and there's nothing to discover it from —
the indexer is a cache the app must be told the address of.

## Diagnostics drawer — single scroll region (chain panel no longer crushes the journey log)

The drawer used to have only one scrollable child — the journey-events
list (`flex: 1; overflow-y: auto`) — with the hint text, support
action buttons, data-rights link, the Chain & Indexer panel, and the
filter tabs all fixed-height above it. Expanding the (now noticeably
taller, with the per-source freshness breakdown) Chain & Indexer panel
made it run past the viewport, which squeezed the events list toward
zero height and pushed the filter tabs + the top of the journey log
off the bottom of the screen with no way to scroll to them.

Restructured: the `<header>` (title + close button) stays pinned —
it's a slide-over, the close affordance must always be reachable — and
everything below it now lives in one `.diag-scroll` region
(`flex: 1; min-height: 0; overflow-y: auto`). An expanded Chain panel
just makes that region scroll instead of crushing the list. The
events list lost its own nested `overflow-y: auto` (the parent owns
scrolling now), and the filter tabs are `position: sticky; top: 0`
within the scroll region with an opaque background, so you can
re-filter the journey log without scrolling back up past the chain
panel. `min-height: 0` on `.diag-scroll` is the load-bearing rule —
without it the flex child refuses to shrink below its content height
and the overflow never engages.

## Diagnostics drawer — Chain & Indexer rows: label column no longer hogs the row

The Chain & Indexer table used `grid-template-columns: minmax(120px,
auto) 1fr`. The `auto` label track sized toward the longest i18n label
on one line — fine in English, but the Tamil (and other RTL/CJK)
strings run long, so on a phone the label column took ~75% of the row
and the `1fr` value column was squeezed so tight that `word-break:
break-word` chopped values a glyph at a time ("4 1 , 3 / 8 3 , / 4 8
6", "Base / Sepo / lia / (845 / 32)").

Fix: both tracks are now `minmax(0, …)` (so neither sizes to its
content's max-content width — `minmax(0, …)` lets a track shrink below
min-content so the text wraps instead of forcing the other to zero),
ratio ~1.3 : 1 label-to-value. `min-width: 0` on the `dt`/`dd` so the
grid items don't re-impose their min-content width over the track
ratio, and the value `dd` switched from `word-break: break-word` to
`overflow-wrap: anywhere` (same break-when-needed behaviour but it
also lowers min-content size, so the indexer URL / ISO timestamps fit
a narrow track cleanly). Below 480px (drawer is full-width there) the
two columns stack — value indented under label — since even a good
ratio is cramped at phone width.

## Status-badge popover trimmed to the glance summary + "Freshest data block" → "Page data up to block"

After the previous pass landed the per-lane freshness breakdown in the
diagnostics drawer's Chain & Indexer panel, the badge popover's
indexer-frontier + RPC-tail-frontier rows became a tiny mirror of the
drawer — three rows where one would do. Trimmed: the popover now shows
just **state · chain · page-data-block · chain-safe-head · gap ·
fetch-in-progress**, the user-level "is what I'm seeing current?"
summary. The operator-level "*which* lane is behind" detail stays in
the drawer's per-source breakdown (`offerStats` / `activeOffers` /
`activeLoans` / `logIndex` / `userLoans` / `roleLoans`).

The freshest-block label is also renamed: **"Freshest data block" →
"Page data up to block"** in both the popover and the drawer.
"Freshest" was jargon; "Page data up to block X" reads as plain English
and pairs cleanly with the "Chain safe head: Y" row below it
(`X ≤ Y` by construction, so the gap is obvious at a glance).
Translated to all 10 locales (hi + es had been missing the key
entirely; both now have the new value). The i18n key
(`indexerBadge.statusFreshestBlock`) is kept as the internal id so the
rename is a value-only change — no consumer needs updating.

The badge file also lost the now-unused `RPC_TAIL_FRONTIER_SOURCES`
constant, the `indexerFrontier` / `rpcTailFrontier` derivations, and
the `bySource` destructuring from `useDataFreshness`. The diagnostics
panel still computes its own `rpcTailFrontier` from the same shared
helpers — single owner of that computation now, not duplicated.

## Indexer-fallback trigger — tail-scan re-fires when the indexer goes stale

The watermark `version` counter (what makes the per-page RPC tail-scans
refetch) only bumps on **creates** — `nextOfferId++` / `nextLoanId++`.
State-change events on existing rows (`OfferAccepted`,
`OfferCancelled`, `LoanRepaid`, `PartialRepaid`, `CollateralAdded`,
`LoanRefinanced`, `LoanPreclosed*`, `OffsetCompleted`,
`LoanDefaulted`) and NFT position `Transfer`s don't bump it. In the
steady state that's fine — the central indexer cron catches those
every ~minute and the `offerStats` lane polls it every 30 s. The gap
is the indexer-unreachable case: the tail-scan would stay frozen until
someone happens to create a new offer/loan, so a repayment / cancel /
secondary-market transfer could go invisible on the client
indefinitely.

`DataFreshnessContext` now carries a `fallbackVersion` counter that
bumps when **both** (a) the indexer's reported `lastBlock` hasn't
advanced in > 120 s, and (b) chain safe-head has run > 200 blocks past
the freshest RPC tail-scan frontier. A 30 s wall-clock tick evaluates
those conditions against state we already track — **no extra RPC**. The
three tail-scan hooks (`useIndexedActiveOffers`, `useIndexedActiveLoans`,
`useLogIndex`) add `fallbackVersion` to their effect dep array, so a
bump re-fires the tail-scan. A safe-block gate (`lastFallbackSafeBlock`)
requires another full 200-block advance before firing again, so the
trigger can't degrade into "tail-scan every 30 s" while the indexer is
down — worst case is one re-fire per ~200-block window per hook (on
Base ~2 s/block, ≈ 6.6 min).

To make condition (a) honest, `SourceSlice` gained `frontierAt`
(unix-seconds, stamped only when `frontier` actually advances — not on
a re-report of the same value), so "indexer is alive and steady" is
distinguishable from "indexer is dead but its last value is still
cached". `DataFreshnessProvider` now consumes `useWatermarkContext`
(it already sits under `WatermarkProvider` in `main.tsx`).

Net: steady state is unchanged and spends zero extra RPC; the
indexer-down edge case now self-heals instead of needing the manual
Rescan button. Hooks that have no RPC tail-scan (`useIndexedLoansForWallet`,
`useUserLoans`, `useOfferStats`) are deliberately *not* wired to
`fallbackVersion` — re-firing an indexer-only fetch while the indexer
is unreachable just retries a failing request.

## Mobile wallet-connect bundle — featured-MetaMask deep-link, WC `redirect`, persistent "connecting…" banner

Three coupled fixes for the mobile connect flow.

**1. Featured "MetaMask" tile now deep-links into the app on mobile.**
ConnectKit's `getDefaultConfig` backs that featured tile with
`injected({ target: 'metaMask' })`. On a phone *browser* (Safari /
Chrome, not MetaMask's in-app browser) there's no injected MetaMask
provider, so tapping it rendered ConnectKit's QR-scan screen instead
of firing `metamask://wc?uri=…` — while the *same wallet* picked from
the "All Wallets" list opened the app fine (that path has no dedicated
connector, so it falls through to the WalletConnect connector + the
registry deep-link). Fix: `wagmiConfig.ts` now builds the connector
list itself — `coinbaseWallet` + `walletConnect` + `safe`, **no
MetaMask-specific injected connector** — so the featured MetaMask tile
takes the same working WalletConnect path on mobile. Desktop is
unchanged: the MetaMask *extension* announces via EIP-6963,
`multiInjectedProviderDiscovery` (wagmi default) picks it up, and the
featured tile connects through the extension directly as before;
no-extension desktop still shows the QR (unchanged, and fine). Chains,
transports and app metadata still come from ConnectKit's
`getDefaultConfig` — only the connectors are ours now.

**2. WalletConnect `metadata.redirect`.** The `walletConnect` connector
is built explicitly (it had to be, for #1) so it now carries
`redirect: { native: '', universal: <origin> }`. WC-v2 wallets honour
it and send the user back to the dApp automatically after they approve,
instead of leaving them to remember to app-switch back. `getDefaultConfig`'s
metadata omitted it.

**3. Persistent "Connecting to your wallet…" banner.** New
`WalletConnectingOverlay` component, mounted just inside
`ConnectKitProvider`. It renders a bottom-anchored banner (z-index one
above ConnectKit's modal) whenever `useAccount().status === 'connecting'`,
with copy that softens after 25 s ("still connecting… reopen your
wallet or try again"). This fixes the mobile dead-air problem: tapping
a wallet deep-links into the wallet app → backgrounds the browser tab →
mobile browsers suspend the tab and drop the WalletConnect relay
WebSocket → on return after approving, the relay has to reconnect +
replay the queued approval (several seconds on a mobile network) → and
ConnectKit's own modal often shows no visible pending state after the
app-switch, so the page looks frozen and users assume it failed,
refresh (nuking the pairing), and start over. The banner is plain React
state, so it's still mounted when the suspended tab resumes — the user
sees "still working, hang on" the whole time. Only `'connecting'`, not
`'reconnecting'` (the silent page-load session restore). New i18n
namespace `walletConnecting.{active,slow}`, translated to all 10
locales.

The three reinforce each other on mobile: #1 gets you *into* the
wallet, #2 brings you *back*, #3 makes the wait *visible*.

## Mobile wallet-connect, round 2 — MetaMask back in the featured list, Coinbase EOA-only

Follow-up to the mobile bundle above, addressing what the first pass
left rough.

**MetaMask is featured again — and still deep-links on mobile.** The
first pass dropped `injected({ target: 'metaMask' })` to stop the
featured tile rendering a QR on a phone browser, but that also dropped
MetaMask off the featured list (it stayed reachable only via "All
Wallets"). Now `wagmiConfig.ts` wires the official `metaMask()`
connector (wagmi's wrapper around `@metamask/sdk`, already present as a
transitive dep — no new package). ConnectKit features it; on a phone
browser the SDK handles the deep-link itself → opens the app, no QR.
Desktop is unchanged: when the MetaMask *extension* is installed it
announces via EIP-6963 (`multiInjectedProviderDiscovery`), ConnectKit's
wallet-list dedup keeps that `io.metamask` connector over `metaMaskSDK`,
and the featured tile connects through the extension directly as
before; no-extension desktop falls to the SDK's own QR/install prompt
(cosmetic). Side benefit for the "slow Confirm screen in MetaMask"
complaint: the SDK path uses MetaMask's own comms channel rather than
the WalletConnect relay, which tends to surface the approval prompt in
the app a bit quicker — the residual delay (MetaMask app cold-start +
the proposal hop) is inherent and not something the dApp can remove.

**Coinbase Wallet — `preference: 'eoaOnly'`.** Connecting via the
Coinbase Wallet tile opened the app but never showed an approve button.
Cause: the connector's default `preference: 'all'` routes through
Coinbase's Smart Wallet flow (a passkey popup), which on a mobile
browser tab is exactly that symptom. `'eoaOnly'` forces the classic
Coinbase Wallet extension / mobile-app flow, which deep-links and
approves normally. Trade-off: the new Coinbase Smart Wallet isn't
selectable here — acceptable for a DeFi app where users already run the
Coinbase Wallet app.

`@metamask/sdk` does add weight to the bundle (it was deliberately
avoided by ConnectKit's `getDefaultConfig`, which is why the
`injected`-only path existed) — the cost of having MetaMask both
featured and working on mobile.

## Coinbase Wallet — drop the SDK connector, route via WalletConnect

`preference: 'eoaOnly'` (round 2) didn't fix the Coinbase Wallet
mobile flow: tapping the tile opened a web handshake page
(`keys.coinbase.com` / `go.cb-w.com`) in a new browser tab with a
link to tap, which universal-linked to the Base app — but the
connection-approval screen never appeared. That's the Coinbase Wallet
SDK v4 behaviour: v4 replaced the old direct `cbwallet://` deep-link
with a web-relay handshake, and on mobile it's flaky regardless of
`preference` (the web handshake is v4's design either way).

Fix — same shape as the MetaMask one: **don't wire the `coinbaseWallet()`
SDK connector at all.** Coinbase Wallet / the Base app supports
WalletConnect v2; without a dedicated connector ConnectKit routes its
tile through the WalletConnect connector + the registry's
`cbwallet://wc?uri=…` deep-link, which opens straight into the app's
pairing screen and shows a real approve prompt — exactly the path
MetaMask's mobile tile uses. Desktop is unaffected: the Coinbase
Wallet *extension* announces via EIP-6963 (`com.coinbase.wallet`) and
`multiInjectedProviderDiscovery` still surfaces it for a direct
connect. Trade-offs: on mobile Coinbase Wallet may sit in "All Wallets"
rather than the featured row, and the Coinbase Smart Wallet (passkey)
isn't selectable from the modal — but `preference: 'eoaOnly'` had
already excluded Smart Wallet, and "in the list and working" beats
"featured and broken".

## Wallet-connecting banner — state machine + dismiss-on-close + touch-only

The banner from the mobile bundle was bound straight to
`useAccount().status === 'connecting'`, which goes true the moment
ConnectKit opens the modal (it pre-generates the WalletConnect
session) — so it showed "Connecting to your wallet… approve in your
wallet app" before the user had picked anything, and it lingered after
the X was clicked (closing the modal doesn't abort that pre-generated
session instantly).

Rewritten as a small state machine:

- **pick** — modal open, no deep-link seen yet → "Select your wallet
  app above to connect."
- **connecting** — a deep-link happened (detected by the tab going
  `hidden` while connecting — tapping a deep-link backgrounds the tab;
  clicking X / clicking away doesn't) → "Still connecting… approve in
  your wallet app, then switch back here."
- **slow** — same, but > 25 s → adds a recovery hint ("reopen your
  wallet app, or close the wallet picker and try again").
- **hidden** — not connecting / connected, OR the modal was closed via
  X / click-away without ever deep-linking → the user backed out, no
  banner.

So: opening the modal shows the "pick a wallet" prompt (not the
premature "approve" copy); the X (or clicking away, which dismisses the
list) hides the banner; tapping a wallet does *not* hide it — it
transitions to "Still connecting…" and survives the app-switch as
before.

Also gated to coarse-pointer (touch) devices — the dead-air problem is
mobile-only, and on desktop ConnectKit's modal stays on screen during
connect, so a banner there would just contradict it ("pick a wallet"
vs the modal's "confirm in MetaMask"). New i18n key
`walletConnecting.pick`; `active` / `slow` copy updated; all 10
locales. (`useModal()` from ConnectKit is read for the modal-open
state — the component is already mounted inside `<ConnectKitProvider>`.)

## Coinbase Wallet — reverted to the standard SDK connector

Reverted the two Coinbase-specific tweaks (`preference: 'eoaOnly'`, and
then routing it through WalletConnect instead of the SDK connector).
Coinbase Wallet is back to ConnectKit's default wiring — `coinbaseWallet()`,
no `preference`. Rationale: the "new tab on `keys.coinbase.com` →
universal-link → Base app → no approval screen" symptom was observed
only on the testnet rehearsals, and the Base app may simply not have
those testnet networks enabled — i.e. it could be an app-config issue,
not the SDK flow. Re-evaluate on mainnet (where the app *is*
configured); if the no-approval-screen behaviour persists there, the
WalletConnect-route version (commit history) is the fallback. The
MetaMask SDK connector, the WalletConnect `metadata.redirect`, and the
connecting-banner state machine all stay.

## Background RPC trim (no-wallet) + mainnet-first default chain

**Audit of "is it fetching with no wallet connected?"** Yes, but the
wallet-scoped hooks are already gated — `useUserLoans` and
`useIndexedClaimables` early-return on `!address`, so "your loans / your
claims" fetch nothing when disconnected. What *does* run regardless of
wallet: (a) indexer HTTP polls (`/offers/stats` etc. — Cloudflare D1
reads, **not chain RPC**); (b) the watermark probe (`getGlobalCounts` +
`getBlock('safe')`) via the top-bar `IndexerStatusBadge`, which is in
`AppLayout` on every connected-app page; (c) the log scans
(`loadLoanIndex` + the catch-up `getLogs` in `useIndexedActiveOffers/Loans`)
on data pages. (b) and (c) are chain RPC.

Trim: the badge subscribed to the watermark at the `warm` tier (30 s
probe on every page). It's a glance indicator — switched to the `cool`
tier (180 s). On data pages the OfferBook (hot, 5 s) / Dashboard (warm,
30 s) subscribers still pull the *shared* probe up to their cadence, so
the badge stays just as fresh there; on the quiet pages (`/keepers`,
`/alerts`, `/allowances`, `/buy-vpfi`, `/data-rights`, `/claims` with no
wallet) where the badge is the only subscriber, the background probe
drops from 30 s to 180 s — 6× less RPC for no UX cost. The data-page
log scans stay (they're load-bearing for the public on-chain data those
pages render — disconnected stranger-visitors are exactly that
audience) and already re-fire only on watermark `version` bumps + the
`fallbackVersion` trigger.

**`DEFAULT_CHAIN` — mainnet always outranks testnet.** New resolution:
(1) `VITE_DEFAULT_CHAIN_ID` if it's a deployed *mainnet*; (2) else first
deployed mainnet by priority Ethereum → Base → other mainnets; (3) else
`VITE_DEFAULT_CHAIN_ID` if it's a deployed *testnet*; (4) else first
deployed testnet by priority Base Sepolia → other testnets → Anvil; (5)
else any deployed chain. So today (no mainnet deployed, env points at a
testnet) it stays Base Sepolia; after the mainnet cutover it becomes
Ethereum even if `.env.local` still points at a testnet — a stale env
var can't strand the production build on a testnet. A loud `console.warn`
fires if the env override is a testnet while mainnet is live. Unset /
blank / non-numeric `VITE_DEFAULT_CHAIN_ID` now resolves to `NaN` (no
fake "Sepolia default") and falls straight through to the priority
order.

## Wallet-connecting banner — un-gate it (show on all devices, "pick" reachable)

The previous pass gated the whole banner to coarse-pointer (touch)
devices, and made the "Select your wallet app above to connect" state
additionally depend on `status === 'connecting'` — which on the
wallet-list screen isn't reliably true, so that state was effectively
unreachable. Net effect: on desktop the banner never appeared, and on
mobile the "pick a wallet" prompt often didn't either.

Both restrictions removed. The banner now shows on all devices, and the
"pick" state shows whenever the connect modal is open and nothing's
been picked / connected (no `connecting` precondition). The other
states are unchanged: a deep-link (tab goes `hidden` while connecting)
→ "Still connecting…", → recovery hint after 25 s; modal closed via X /
click-away with no deep-link → hidden. (The MetaMask SDK connector in
`wagmiConfig.ts` and the WalletConnect `metadata.redirect` were never
touched here — only the earlier Coinbase tweaks were reverted.)

## MetaMask — revert to ConnectKit's default connector (the `metaMask()` SDK broke desktop)

`wagmiConfig.ts` had been wiring wagmi's `metaMask()` connector (the
`@metamask/sdk` wrapper) so the *featured* MetaMask tile would
deep-link into the app on a mobile browser. It did — but the bundled
`@metamask/sdk` (0.33.1, a transitive dep of `@wagmi/connectors`)
failed to detect the installed MetaMask *extension* on desktop and fell
back to its own QR modal there. A desktop user with the extension
installed getting a QR is a worse regression than the
mobile-featured-tile QR (it hits the majority), so reverted: MetaMask
is back to ConnectKit's default `injected({ target: 'metaMask' })` —
direct extension connect on desktop, no QR. On a mobile browser the
featured tile still shows ConnectKit's QR-scan screen (the original
ConnectKit limitation); the workaround there is the "All Wallets" →
MetaMask entry, which has no dedicated connector and so falls through
to the WalletConnect connector + MetaMask's registry deep-link
(`metamask://wc?uri=…`) and opens the app. The extension is also picked
up via EIP-6963 (`multiInjectedProviderDiscovery`, kept on), giving
desktop a second redundant path to the extension. Don't re-add
`metaMask()` until the SDK's extension detection is reliable. (The
WalletConnect `metadata.redirect` and the `coinbaseWallet()` default
stay; the wallet-connecting banner is unaffected.)

## wagmiConfig — full revert to ConnectKit's stock connector set

The hand-rolled connector list (introduced for the mobile bundle) had,
even after the MetaMask and Coinbase reverts, kept one custom bit on
the WalletConnect connector: `metadata.redirect: { native: "", universal: … }`.
An empty `native` in WC v2's redirect metadata makes the
`EthereumProvider` fail to produce a pairing URI — so on mobile the QR
screen opened but never rendered the QR ("stuck loading"), and the
"All Wallets" list (which also leans on the WC connector) hung the same
way. Desktop was unaffected because it uses the injected / EIP-6963 path,
not the WC QR flow.

So `wagmiConfig.ts` is now fully back to ConnectKit's `getDefaultConfig`
connector set (`injected({ target: 'metaMask' })` + `coinbaseWallet()` +
`walletConnect({ showQrModal: false, metadata: {name,desc,url,icons} })`)
plus the `safe()` connector — i.e. the exact pre-mobile-bundle config,
which is known-good. The `WalletConnectingOverlay` banner is untouched.

Net state: desktop MetaMask = direct extension connect (no QR); mobile
MetaMask featured tile = ConnectKit's QR-scan screen (the workaround is
"All Wallets" → MetaMask, which falls through to WalletConnect +
`metamask://wc?uri=…` and opens the app); Coinbase = stock SDK
connector. The deep-link-the-featured-MetaMask-tile-on-mobile goal is
parked until the bundled `@metamask/sdk` has reliable extension
detection — re-test on a real device before re-attempting either the
`metaMask()` SDK connector or the WC `redirect` metadata.

## Wallet-connecting banner — "Still connecting…" now persists until connected

The banner had a `useEffect(() => { if (modalOpen) setDeepLinked(false) })`
to clear the deep-link marker when the modal re-opened for a fresh
attempt — but it fired on *every* render where the modal was open, not
just on the open-edge. On mobile, after the user approves the
connection in the wallet app and returns, ConnectKit's modal often
re-opens / stays open while the WalletConnect relay reconnects and
replays the approval — so that effect kept resetting `deepLinked`,
flipping the banner from "Still connecting…" back to "Select your
wallet app above to connect" during exactly the window where the user
needs the "hang on, still working" reassurance.

Removed that reset. `deepLinked` (→ "Still connecting…", → recovery
hint after 25 s) now clears only when the attempt actually finishes —
`isConnected` (banner hidden) or `status === 'disconnected'` (failed /
cancelled-via-X, banner hidden). So after you confirm in the wallet,
the banner stays "Still connecting…" through the relay-reconnect lull
and disappears the instant the wallet is connected. The "Select your
wallet app above to connect" state is unchanged.

(Note: whether the wallet app *itself* returns you to the browser after
you approve is the wallet's behaviour — MetaMask backgrounds itself —
not something the dApp controls; the WC `metadata.redirect` hint that
would have nudged it was removed because its empty-`native` value broke
the WalletConnect pairing-URI generation.)

## Wallet-connect — clean slate: banner removed, config at ConnectKit stock

Per the iteration above, the MetaMask / Coinbase connector experiments
(the `metaMask()` SDK connector, `coinbaseWallet` `preference`,
routing-Coinbase-via-WalletConnect, the WC `metadata.redirect`) had
already been fully reverted — `wagmiConfig.ts` is back to ConnectKit's
stock connector set (`getDefaultConfig`'s `injected({ target: 'metaMask' })`
+ `coinbaseWallet()` + `walletConnect({ showQrModal: false, metadata:
{name,desc,url,icons} })` plus `safe()`), i.e. the pre-mobile-bundle
config. The file header carries a short history note of the dead-ends
(SDK extension-detection on desktop, empty-`native` breaking the WC
pairing URI) so they aren't re-tread.

This change removes the remaining piece — the `WalletConnectingOverlay`
banner ("Select your wallet app above to connect" / "Still connecting…"):
component + CSS deleted, the mount and import pulled from `main.tsx`,
and the `walletConnecting.*` i18n keys removed from all 10 locales. The
banner concept was useful and will be rebuilt deliberately later
(alongside re-introducing `metadata.redirect: { universal: <origin> }`
— the empty-`native`-free variant — which is what auto-returned the
wallet app to the browser after confirmation), with a real-device test
each step.

## Wallet-connect banner v2 + WalletConnect `redirect: { universal }`

Rebuilt the connect-status banner (clean slate from the earlier
removal) and re-introduced the auto-return-to-dApp hint.

**Banner** (`WalletConnectingOverlay`, shown on desktop and mobile,
bottom-anchored above ConnectKit's modal):

- **pick** — connect modal open, no deep-link yet → "Select your wallet
  app above to connect." Disappears when the modal closes (X /
  click-away). On desktop with an extension, ConnectKit's "Connecting
  to <wallet>" screen keeps the modal open without a deep-link, so this
  state also briefly covers the few seconds before you click Approve in
  the extension popup — a minor wart; the modal's own "confirm in the
  extension" text is the real instruction there and it self-corrects on
  connect. (Making it precise would mean reading ConnectKit's internal
  modal-route — a private API; not worth the coupling.)
- **connecting** — a wallet was picked and the user got deep-linked into
  a wallet app (detected by the tab going `hidden` while a connect
  attempt is live) → "Still connecting… confirm the request in your
  wallet." **Persists until `isConnected`** — survives the wallet app
  returning the user to the browser, ConnectKit's modal re-opening, and
  the silent WalletConnect-relay reconnect + approval replay on return.
- **slow** — same, but > 25 s → "…if nothing happened, reopen your
  wallet, or close the wallet picker and try again."
- **hidden** — connected, or modal closed with no deep-link in flight.

New i18n namespace `walletConnecting.{pick,active,slow}`, all 10
locales.

**`metadata.redirect`** — the WalletConnect connector now carries
`redirect: { universal: <origin> }` (just `universal`, no `native` — an
empty `native` was what broke pairing-URI generation last time). WC-v2
wallets honour it and navigate back to the dApp after the user
approves, so the wallet app returns the user to the browser instead of
leaving them to app-switch back. This is the one reason `wagmiConfig.ts`
now hand-rolls the connector list (otherwise ConnectKit's stock set:
`injected({ target: 'metaMask' })` + `coinbaseWallet()` +
`walletConnect({ showQrModal: false })` + `safe()`).

Still parked (needs a fixed `@metamask/sdk` + a real-device test):
deep-linking the *featured* MetaMask tile on a mobile browser — that
tile still shows ConnectKit's QR-scan screen; the deep-link path on
mobile is "All Wallets" → MetaMask.

## "New version available — Reload" banner (stale-bundle protection)

A SPA tab left open across a deploy keeps running the old JS, and even
a plain reload can serve a cached `index.html` referencing the old
content-hashed chunks (browser HTTP cache + the service-worker Cache
Storage, which "unregister" does NOT delete). The downstream symptom
seen in the wild: `loadLoanIndex`'s "chain config not resolved
(deployBlock=0)" guard firing because the stale bundle predates a
`deployments.json` update.

New `AppUpdateBanner` (mounted in `AppLayout`, every connected-app
page): on load, every 5 min, and on tab-focus it does ONE
`fetch('/index.html', { cache: 'no-store' })` (no chain RPC), pulls the
deployed entry-chunk name (`/assets/index-<hash>.js`) and compares it
with the chunk this page actually loaded (read off the module
`<script>` tag). Vite content-hashes that filename, so a different hash
⇒ a newer build is live → a small bottom-left pill appears: "A new
version of Vaipakam is available." + a **Reload** button (which nudges
any controlling service worker to `update()` first, then
`location.reload()` — the deployed `index.html` is
`Cache-Control: max-age=0, must-revalidate` per `public/_headers`, so
the reload then picks up the fresh chunks). If the loaded chunk can't
be determined the feature disables itself (no false positives). New
i18n `appUpdate.{message,reload,reloading}`, all 10 locales.

(This can't rescue a session that's *already* on a stale bundle — that
bundle predates the banner — so a one-time "clear site data + reload"
is still needed to escape; after that, future deploys self-flag.)

## Read-only-mode chain resolution — fix `loadLoanIndex` "deployBlock=0" bail

Root cause of the recurring `log-index/loadLoanIndex` failure ("chain
config not resolved (deployBlock=0, diamond=0x725C…)"), reproducible in
a fresh/incognito browser with no wallet ever connected:

- `WalletContext` derived `chainId` straight from wagmi's `useChainId()`.
  With no connected wallet that returns the wagmi config's *first* chain
  — Ethereum (chainId 1), since `CHAIN_REGISTRY` is Ethereum-first —
  whose registry entry has `diamondAddress: null` and `deployBlock: 0`
  (no Phase-1 deploy on Ethereum).
- `activeChain = getChainByChainId(1)` was therefore that Ethereum
  placeholder config. `resolveReadChain` returns `activeChain` whenever
  it's truthy (its `DEFAULT_CHAIN` branch only fires when `activeChain`
  is `null`), so `useReadChain()` handed `useLogIndex` the Ethereum
  placeholder.
- `useLogIndex` then did per-field `??` fallbacks: `diamondAddress =
  chain.diamondAddress ?? DEFAULT_CHAIN.diamondAddress` → `null` is
  nullish → fell through to base-sepolia's `0x725C…`; `deployBlock =
  chain.deployBlock ?? DEFAULT_CHAIN.deployBlock` → `0` is NOT nullish
  under `??` → stayed `0`. Frankenstein chain → `loadLoanIndex` got
  base-sepolia's diamond + `deployBlock = 0` → the genesis-scan guard
  fired.

Two fixes:

1. **`WalletContext`** — when no wallet is connected (`status` not
   `'connected'`/`'reconnecting'`), `chainId` reflects
   `DEFAULT_CHAIN.chainId` instead of wagmi's Ethereum default. So
   `activeChain` becomes the *complete* `DEFAULT_CHAIN` config (base-
   sepolia, with its real diamond + deploy block) in read-only mode,
   and every read hook downstream sees a deployed chain.
2. **`useLogIndex`** — defense-in-depth: pick `DEFAULT_CHAIN`
   *wholesale* (chainId + diamond + rpcUrl + deployBlock together) when
   the active chain has no diamond, rather than a per-field `??` mix —
   so it can never assemble a half-DEFAULT_CHAIN / half-other-chain
   pair again (also covers "wallet connected to a chain with no
   deployment"). This also fixes the cached-loan-index `peekLoanIndex`
   key being a mismatched `(chainId=1, diamond=base-sepolia)` in
   read-only mode, so the localStorage snapshot now renders on a
   wallet-less load instead of coming up empty.

## OfferBook fallback — use the on-chain `getActiveOffersPaginated` getter, not the log scan

When the central indexer (D1) is unreachable the OfferBook's open view
fell through to `useLogIndex`'s `openOfferIds` — i.e. an in-browser
`eth_getLogs` scan of `OfferCreated/Accepted/Canceled` events, which on
public RPCs is slow and a genesis-scan footgun. New `useOnchainActiveOfferIds`
hook reads `MetricsFacet.getActiveOffersCount` + pages
`getActiveOffersPaginated(offset, 200)` to get the *authoritative*
active-offer-id list straight from the Diamond's `s.activeOfferIdsList`
— one `eth_call` for the count + ⌈count/200⌉ for the slices, no log
scan. The OfferBook now sources the open view's id list from
`onchainActiveOfferIds ?? openOfferIds` (`legacyOpenIds`): the on-chain
getter when it's resolved, the log scan otherwise. The hook is gated to
fire only once the indexer has *confirmed* failed
(`indexedSource === 'fallback'`), so a healthy-indexer page spends no
extra RPC and `legacyOpenIds === openOfferIds` (no behaviour change). It
re-reads on the shared `warm` watermark bump + tab-focus.

Net: with no D1 (e.g. a static / IPFS deploy) the OfferBook's open view
runs purely on contract getters — `getActiveOffersPaginated` for the
ids → `getOffer` per id (the existing `fetchBatch` pipeline) — instead
of the `eth_getLogs` scan. (The CLOSED view still uses `useLogIndex` —
there's no clean on-chain "all closed offers" getter and it's a minor
surface. The `useIndexedActiveLoans` half of "wire the getters" was
skipped — no page currently consumes it; there's no protocol-wide
active-loans list view.)

## OfferBook duration filter — single bucket picker (matches CreateOffer)

Replaced the OfferBook's two free-text "Min duration" / "Max duration"
numeric inputs with one single-select duration-bucket `Picker`, mirroring
the CreateOffer duration picker — same `OFFER_DURATION_BUCKETS_DAYS`
([7, 14, 30, 60, 90, 180, 365]). The picker has an "Any duration"
default (no filter); selecting a bucket is an *exact match* on
`offer.durationDays` (not a min/max range — every UI-created offer
carries a bucketed duration, so a range was overkill). Offers with a
non-bucketed `durationDays` (legacy / direct-contract) only match the
"Any" option.

Mechanics: `OfferFilters.{minDuration,maxDuration}` (two strings) →
`duration` (one string — `''` = any, else a bucket day-count); the
`matchesFilter` predicate's min/max comparison → `f.duration &&
BigInt(f.duration) !== o.durationDays → reject`. OfferBook state
`minDuration`/`maxDuration` → `durationFilter`. New i18n
`offerBookPage.{durationLabel, durationAny, durationFilterAria}`,
all 10 locales; the bucket labels reuse `createOffer.durationBucket`;
the now-unused `offerBookPage.{minDuration, maxDuration, *Placeholder}`
keys were removed. `offerBookRanking.test.ts` updated for the new shape.

## OfferBook — removed the sort dropdown + the "Hide my offers" toggle

Both were low-value controls on a page that already has sensible
defaults, so they're gone:

- **Sort dropdown** (`SortChoice` / `SORT_OPTIONS`, shown on the
  lender / borrower tabs) — removed. The open view already orders by a
  meaningful default (closest-to-market-rate anchor ranking on `both`;
  recency-DESC elsewhere) and the closed view's natural order is
  recency, so a user-selectable sort across rate / principal / duration
  / recency was a redundant power feature. The pair-filtered lender /
  borrower views now use recency-DESC (newest first) — the same default
  the rest of the page already used. `buildPairSortComparator(choice)`
  collapsed to a fixed `compareOfferRankingByRecencyDesc`.
- **"Hide my offers" toggle** — removed (along with its
  `vaipakam:offerBook:hideMyOffers` localStorage persistence). The
  connected wallet's own offers now stay in the market list; "My
  Offers" (wallet menu) is where you see your own listings. The
  per-side count / pagination logic that worked around hidden rows is
  simplified accordingly.

Net: the OfferBook's filter row is now Lending asset · Collateral asset
· Duration · Liquidity, with no sort/hide controls. Removed the
`offerBookPage.hideMine*` i18n keys (all 10 locales); `OfferBook.test.tsx`
needed no change (it never exercised either control).

## AppUpdateBanner — reposition (clear of the sidebar) + wrap the message

The "A new version of Vaipakam is available — Reload" banner was
anchored bottom-LEFT (`position: fixed; left: 1rem`), which is the
viewport's left edge — exactly where the AppLayout left sidebar sits,
so the banner was partially covered by it. Moved to bottom-RIGHT,
stacked above the diagnostics FAB (`right: 1rem; bottom: 4rem`) — clear
of both the sidebar and the WalletConnectingOverlay (bottom-centre).

Also restyled from a pill to a small card so the message can wrap
(longer locale strings, narrow viewports): `border-radius: 12px`,
`max-width: min(92vw, 380px)`, `flex-wrap: wrap`; the message `<span>`
is `flex: 1 1 auto; min-width: 0` so it wraps at word boundaries, the
icon and the Reload button are `flex-shrink: 0` (button also
`white-space: nowrap`) so the button stays intact and only drops below
the message when the row is genuinely too tight. Below 640 px (sidebar
collapsed) the card stretches edge-to-edge, still above the FAB.
CSS-only.

## Refresh buttons unified + "Synced / N blocks behind" replaces "Last refreshed N ago"

The "Refresh / Rescan" affordance was a hand-rolled, slightly-drifting
copy on Dashboard, EscrowAssets ("Your Vaipakam Vault"), OfferBook and
Activity (different `btn-ghost` vs `btn-secondary`, different idle
labels, different i18n keys), and Claims had none. Consolidated:

- **New `<RescanButton>`** — one component, wraps a `useRescanCooldown`
  result: clicking calls `cooldown.trigger()` then the page-supplied
  `onRescan` (the only thing that legitimately differs — *which* data
  the page re-fetches). States: `<RefreshCw/> Refresh` →
  `<RefreshCw spin/> Refreshing… {N}s` → `<Check/> {N}s` (cooldown
  ticking) → back. Always `btn btn-secondary btn-sm rescan-btn` with the
  `--rescan-progress` bar. Generic `common.refresh/refreshing/secondsSuffix`
  i18n. `disabled` prop = an extra condition ANDed with the cooldown's.
  - Wired on **Dashboard, EscrowAssets, OfferBook, Activity, and newly
    on ClaimCenter** (the Claims page now has a refresh — wired to
    `useClaimables.reload`). Activity's button changes `btn-ghost` →
    `btn-secondary` for consistency. *(The OfferBook "Rescan" was never
    functionally a different button — same `useRescanCooldown` state
    machine, just re-fetching the OfferBook's data; only the chrome had
    drifted.)*

- **New `<DataSyncStatus>`** — compact freshness chip next to the
  Refresh button, replacing "Last refreshed N ago" (which told you
  *when you pulled*, not whether the data is *current*). Reads the
  freshest block any data source on the page has reached
  (`DataFreshnessContext.maxFrontier`) vs the chain's safe head
  (`WatermarkContext`): gap ≤ 100 blocks → "✓ Synced" (green); larger
  → "~N blocks behind" (amber); nothing on local dev or before either
  number is known. Same threshold the top-bar `IndexerStatusBadge` uses
  (the badge stays the detailed/popover version; this is the
  at-a-glance one). Tooltips explain the auto-catch-up. New i18n
  `common.synced/syncedTooltip/blocksBehind/blocksBehindTooltip`,
  10 locales.

Net: every page's refresh control is now literally the same component,
paired with a freshness signal that actually answers "is this fresh?".
Removed the now-dead `lastRefreshedAt`/`now` timer state + the
`formatRelativeTime` import + the per-page `*.lastRefreshed`/`*.refresh`
i18n uses from Dashboard / EscrowAssets / OfferBook / Activity (the
locale keys themselves are left in place, unused). The
`/analytics` (PublicDashboard) page has its own plain "Refresh" button
that isn't part of the `.rescan-btn` family — left as-is; could be
brought in later.

## OfferBook — drop the tab row-counts, align the filter pickers; ClaimCenter refresh moves to a footer

- **OfferBook tab labels** — dropped the `(N)` after "Open" / "Closed":
  the "Closed" bucket count needed an on-chain validation pass over
  *every* offer (a multicall of `getOffer(id)` for the full id list) to
  bucket open vs closed correctly, which doesn't scale on mainnet; the
  "Open" count was only ever approximate too. Removed that whole
  `countByStatus` / `fetchValidCount` machinery — the "Scanned X of Y"
  line below now takes the *cheap* totals (the indexer's page count, or
  the active-offer-id list length, or the closed-id list length), and
  the `(N hidden)` suffix still explains any gap to what renders.
- **Filter row alignment** — the discrete `<Picker>` pills (Duration,
  Liquidity) now match the free-form inputs (Lending asset / Collateral
  asset) on the *vertical* axis too (same `padding` / `font-weight`),
  not just width — they were a couple of px shorter and read as if on a
  different "level".
- **ClaimCenter refresh** — moved the (newly-added) `<RescanButton>` +
  `<DataSyncStatus>` from under the page header to a footer row, to
  match Dashboard / EscrowAssets where the refresh control sits at the
  bottom.

(Still to do: OfferBook & Activity have their refresh control near the
top of the page, and the `/analytics` page's refresh is still a
hand-rolled button rather than the shared `<RescanButton>` — those
relocations / the conversion are a follow-up.)

## Analytics page — drop the manual Refresh button, keep just the sync-status chip

The `/analytics` (PublicDashboard) page is a public, wallet-less
surface, so an abused (spam-clicked) Refresh would burn RPC quota with
no connected wallet to attribute it to. Removed the manual `<button>`
Refresh entirely; in its place sits the `<DataSyncStatus>` chip
("✓ Synced" / "~N blocks behind"). The page still auto-refreshes on the
shared watermark bump (which detects on-chain change), so the data
stays current without a user-pressable button. Dropped the now-unused
`useRescanCooldown` / `RefreshCw` / `Check` / `CSSProperties` imports
and the `analyticsRescanCooldown` state; the `publicDashboard.refresh*`
i18n keys are left in place (unused). The other pages' Refresh buttons
are unchanged for now.

## Release-notes mid-stream date roll

The conversation that produced this release-notes file started on
2026-05-10 and rolled over to 2026-05-11 mid-session. The work
documented here lands on the 2026-05-11 file by date-of-completion
convention; the predecessor file `ReleaseNotes-2026-05-10.md` covers
the deploy rehearsals + Phase 2 hardening that closed out the prior
day.
