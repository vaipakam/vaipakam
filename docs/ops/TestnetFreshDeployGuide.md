# Vaipakam — Full Fresh Testnet Deployment: Operator Guide

Researched 2026-11-16 against `main` at `866110925` ("indexer: drop the
shared copy of the keeper runner lease (#3550)"). It describes the code as it
stood then: before acting on a step, check the cited script or runbook section
still says the same, and fix this guide in the same change when it does not.
Every step cites the file and section it comes from. Anything not confirmed
by reading code is marked **UNVERIFIED**.

**Where a doc and the code disagree** (§11 lists every case found), the two
kinds are handled differently, per AGENTS.md and
`docs/FunctionalSpecs/_CodeVsDocsAudit.md`:
- **Stale description** (a doc naming a script, key or count the code no
  longer has): the step uses what the code does today.
- **An intended requirement the code does not meet** (for example §11 item 6,
  `cf-www` bypassing the package-script deploy that CLAUDE.md requires): do
  not follow the code by default. Get an explicit owner decision, recorded in
  the deploy's notes, or fix the code first. Each such item in §11 is marked
  **NEEDS DECISION**.

All paths are repo-root relative unless they start with `/`. All
`bash contracts/script/...` commands are run from the repo root; all
`forge ...` commands from `contracts/` (CLAUDE.md, "Build & Test Commands").
Secrets are named by environment-variable NAME only. Never paste a value.

**Why a fresh deploy (not a refresh).** The live testnet Diamonds predate the
VaultBeacon / PositionNFT / ProtocolRegistry / PriceGuard build and the
vault-held protection of #3489 (commit `8ec306b61`); main cannot refresh them in
place. Several contract changes in `docs/ReleaseNotes/ReleaseNotes-2026-11-15.md`
explicitly "take effect at the next fresh testnet deploy". So every active
testnet gets `--fresh`.

**The precedent to follow.** The last full fresh deploy (3–4 Nov 2026) is
written up in `docs/ReleaseNotes/ReleaseNotes-2026-11-04.md`, threads "Fresh
all-waves deploy of Base Sepolia and Arbitrum Sepolia" and "Fresh all-waves
deploy of BNB testnet", and its lessons in
`docs/DesignsAndPlans/FreshDeployHardeningPlan.md` (status: proposal, **none of
its fixes is built** — confirmed: no `testnet-topology.json`, no `settings` /
`custody` / `recover` phase in `deploy-testnet.sh`). Its phase order was:
`contracts → ccip-wire → (BNB: swap-adapters) → testnet-mocks → configure →
reward-custody activation → launch → verify`, **no governance handover**, then
manual restoration of the operating settings. This guide follows that order and
adds what has changed since (#3360 reward-cap launch check, #3253 reward-pool
funding, #3379/#3431/#3569 vault code).

---

## 0. Scope and chain set

### 0.1 Active testnet set (from `contracts/deployments/.active-chains`)

| Slug | Chain id | Role | RPC env var (`contracts/.env`) | CCIP slug suffix | Worker RPC secret (Secrets Store) |
|---|---|---|---|---|---|
| `base-sepolia` | 84532 | **Canonical** VPFI + reward chain (hub) | `BASE_SEPOLIA_RPC_URL` | `BASE_SEPOLIA` | `RPC_BASE_SEPOLIA` |
| `arb-sepolia` | 421614 | Mirror | `ARB_SEPOLIA_RPC_URL` | `ARB_SEPOLIA` | `RPC_ARB_SEPOLIA` |
| `bnb-testnet` | 97 | Mirror (no 0x backend; PancakeSwap V3 adapter) | `BNB_TESTNET_RPC_URL` | `BNB_TESTNET` | `RPC_BNB_TESTNET` |

Source of the registry columns: `contracts/script/deploy-testnet.sh` (the
`case "$CHAIN_SLUG"` registry block) and DeploymentRunbook "Prerequisites:
one-time Worker RPC-secret setup".

Not in the set (do NOT deploy): `op-sepolia` (11155420) and `sepolia`
(11155111) are commented out as retired in `.active-chains`; `polygon-amoy`
(80002) is accepted by the script but not active. `anvil` is refused by
`deploy-testnet.sh`.

`contracts/deployments/` also holds mainnet slugs (`ethereum`, `base`,
`arbitrum`, `optimism`, `polygon`) — untouched by this procedure — and
`archive-manifest.json` (see §2.4) and `CCIP-INFRA-ADDRESSES.md` (reference for
the `CCIP_*` addresses).

### 0.2 Which script

Use the tiered **`contracts/script/deploy-testnet.sh <slug> --phase <phase>`**
(DeploymentRunbook "TL;DR — pick the right script": "Use this for the actual
testnet rehearsal cycle, NOT deploy-chain.sh"). `deploy-chain.sh` is the dev
one-shot: it does NOT run configure, the sanctions oracle, testnet-mocks or
launch (it only prints them as follow-ups; `deploy-chain.sh` closing block
"Follow-up steps NOT in this script").

Phases available (dispatch block at the end of `deploy-testnet.sh`):
`preflight, contracts, ccip-wire, swap-adapters, testnet-mocks, configure,
handover, handover-gate, launch, abi-sync, cf-app, cf-www, cf-keeper,
cf-indexer, cf-agent, verify, pause-rehearsal`. There is **no `--resume`** in
`deploy-testnet.sh` (only `deploy-chain.sh` has one).

### 0.3 Mainnet-only — skip on testnet

- `deploy-mainnet.sh` and every flag specific to it
  (`--confirm-purging-prior-mainnet-deploy`; hardware-signer and 48h
  handover deadline are HARD-FAIL there, WARN-only in `deploy-testnet.sh`).
- The DeploymentRunbook "6. Mainnet readiness checklist" items (Workers Paid
  plan, `MainnetOpsBaseline.md`, explorer verification on a mirror, the
  rehearsal-report archive) — read only for awareness.
- `ConfigureSanctionsOracle.s.sol` refuses every mainnet; on testnets it
  installs the admin's `TestnetSanctionsOverlay` (CLAUDE.md "Retail-deploy
  policy").
- Governance handover + `handover-gate` + Timelock-proposed `launch`: mainnet
  requires them; on testnets the precedent is **no handover** (see §6 for the
  decision and the conflicting docs).
- `PRIVATE_TX_RPCS` / private submission and the keeper signing-ceiling
  choices for mainnet chains (KeeperMachine.md §4).
- KYC / country-pair: stay OFF everywhere (CLAUDE.md "Retail-deploy policy";
  never call `setKYCEnforcement(true)`).

---

## 1. One-time prerequisites

### 1.1 Tools

| Tool | Requirement | Source |
|---|---|---|
| Node | **22+** (root `package.json` `engines.node >=22.0.0`; the scripts' own preflight only demands 20+ and auto-switches via nvm) | `package.json`; `deploy-testnet.sh` "Node version preflight" |
| pnpm | 10.4.1 (`packageManager`) — run `pnpm install` at the repo root first; every `cf-*` phase refuses without `apps/<x>/node_modules`, and the abi-sync/typechecks need it (FreshDeployHardeningPlan lesson 10) | `package.json`; `deploy-testnet.sh` `phase_cf_*` |
| Foundry | forge/cast/anvil. CI's release gate pins **v1.8.6** (`.github/workflows/mainnet-gate.yml`); use the same locally. No `nice`/`ionice` prefix (CLAUDE.md "Executing forge") | CLAUDE.md "Three foundry.toml profiles" |
| jq, curl, git | used by every phase | `deploy-testnet.sh` |
| wrangler | via each app's devDependencies; Cloudflare auth for the account (`wrangler whoami` can false-negative on token scope — a deploy is the real test) | DeploymentRunbook "Prerequisites"; user memory |
| Sibling repo `vaipakam-keeper-bot` | optional; `abi-sync` exports to `<repo-root>/../vaipakam-keeper-bot` only if present. check that it is cloned beside the repo — without it the keeper-bot sync is skipped | `deploy-testnet.sh` `phase_abi_sync`; `exportAbis.sh` |

Work from a **clean checkout/worktree of `main`** at a known commit:
`deployment_source.json` stamps `(dirty)` when tracked source differs from
HEAD (`deploy-testnet.sh`, "Provenance snapshot").

### 1.2 `contracts/.env` — variable NAMES and purpose

Template: `contracts/.env.example`. The wrappers read `.env` as data
(`contracts/script/lib/load-env.sh`); **a value in `.env` replaces one exported
in the shell** (BNBTestnetDeploy.md §2; FreshDeployHardeningPlan lesson 4), so
put per-run topology in `.env`, not on the command line.

Keys and accounts:
- `DEPLOYER_PRIVATE_KEY` — broadcasts the deploy scripts. `DeployDiamond` hands
  every role to the admin and the deployer renounces all (DeployDiamond.s.sol
  "Step 6").
- `ADMIN_PRIVATE_KEY`, `ADMIN_ADDRESS` — the deploy-time admin (must match;
  DeploymentRunbook "0. Pre-flight", #947). Signs every configure/ccip-wire/
  launch call. Holds all roles on a testnet with no handover.
- `TREASURY_ADDRESS` — **fixed for the life of the deploy**: built into the
  vault code as an immutable `TREASURY` (#3569; DeployDiamond.s.sol step 5d;
  UpgradeSafety.md "Moving the treasury"). No setter exists. Also receives the
  23M canonical VPFI mint (DeployVPFIToken.s.sol header).
- `VPFI_OWNER`, `VPFI_TREASURY`, `VPFI_INITIAL_MINTER` — required by
  `phase_preflight` (the token script itself reads `ADMIN_ADDRESS`,
  `TREASURY_ADDRESS`; see §11).
- `PAUSER_ADDRESS`, `TIMELOCK_PROPOSER`, `EMERGENCY_REVOKER_ADDRESS` — the
  Pauser Safe, the Governance Safe (proposer) and the emergency revoker (must
  equal the proposer). Required by `phase_preflight` and `DeployTimelock`
  (GovernanceRunbook "1. Deploy the Timelock"). `PAUSER_ADDRESS` is also the
  feed-registry guardian at deploy (DeployDiamond.s.sol `setPriceGuardInputs`).
- `TIMELOCK_MIN_DELAY` (optional; testnet floor 1h, default 48h),
  `TIMELOCK_EXECUTOR` (leave unset = open execution).
- `KEEPER_ADDRESS`, `WATCHER_ADDRESS`, `NOTIF_BILLER_ADDRESS` — bot EOAs;
  required only by the `handover` phase. `KEEPER_BOT_OWNER` (same EOA as the
  keeper).
- `CCIP_ROUTER_<SLUG>`, `CCIP_RMN_PROXY_<SLUG>` (contracts phase),
  `CCIP_TOKEN_ADMIN_REGISTRY_<SLUG>`, `CCIP_REGISTRY_MODULE_OWNER_CUSTOM_<SLUG>`
  (ccip-wire, launch, handover) for each of `BASE_SEPOLIA`, `ARB_SEPOLIA`,
  `BNB_TESTNET`. A bare `CCIP_*` without the slug form is a hard error
  (`deploy-testnet.sh` "Per-chain CCIP infrastructure dispatch").
- `CCIP_LANE_CHAIN_IDS_<SLUG>` — remote chains per pool. Precedent topology
  (ReleaseNotes-2026-11-04): `..._BASE_SEPOLIA=421614,97`,
  `..._ARB_SEPOLIA=84532`, `..._BNB_TESTNET=84532`. Resolved by
  `contracts/script/lib/ccip-lanes.sh`; `launch` requires the pool's lanes to
  equal this set EXACTLY.
- `CCIP_GUARDIAN` — **required** by `ccip-wire` (refuses if unset/zero); the
  incident guardian, normally the Pauser Safe address.
- Optional: `CCIP_DEST_GAS_LIMIT` (default 400000), `CCIP_RATE_CAPACITY`
  (default 50,000 VPFI), `CCIP_RATE_REFILL` (default 5.8 VPFI/s).
- `BASE_CHAIN_ID` — required on mirrors by preflight (=84532); the configure
  phase derives it itself.
- `BASE_REWARD_DEPLOYMENT` — mirrors: the NEW Base Diamond (known only after
  Base's contracts phase). `MIRROR_REWARD_DEPLOYMENTS` — Base:
  `421614:<new arb diamond>,97:<new bnb diamond>`.
  `REWARD_EXPECTED_SOURCE_CHAIN_IDS` — Base: `84532,421614,97` (**must include
  Base itself**; FreshDeployHardeningPlan lesson 4). Optional
  `REWARD_GRACE_SECONDS` (default 14400; precedent restored 43200 on Base),
  `REWARD_LAPSE_WINDOW_SECONDS`, `REWARD_DISPATCH_CUTOFF_GAP_SECONDS`
  (DeploymentRunbook "3b. Reward config wiring").
- Oracle/rig: `<PREFIX>_WETH_ADDRESS`, `<PREFIX>_ETH_USD_FEED`,
  `<PREFIX>_SEQUENCER_UPTIME_FEED`, `VPFI_STABLE_FEED_SYMBOLS` +
  `<PREFIX>_<SYM>_FEED`, `<PREFIX>_PAA_QUOTE_ASSETS`,
  `<PREFIX>_UNISWAP_V3_FACTORY`; the mock rig reads the same
  `<PREFIX>_WETH_ADDRESS` (one name everywhere since the hardening fix of
  lesson 8; BNB: **must be the mock WETH stand-in, never WBNB**, and has no
  default; BNBTestnetDeploy.md "Chain-specific quirks"). Optional `FAUCET_*` reuse vars
  (DeployTestnetMocks.s.sol).
- BNB only: `BNB_TESTNET_UNISWAP_V3_ROUTER` (**required** by `swap-adapters` on
  97). `INITIAL_SETTLERS` is ignored on 97 and unused on Base/Arb Sepolia (no 0x
  backend there).
- Optional gas: `<SLUG>_GAS_PRICE_WEI` (BNB defaults to 1 gwei) and
  `<SLUG>_PRIORITY_GAS_PRICE_WEI` (defaults to the pinned price whenever a
  price is pinned, so BNB's 0.1 gwei minimum tip is met; hardening lesson 8),
  `FORGE_GAS_MULTIPLIER` (default 130).
- Vault endpoints (optional, defaults baked in): `VAULT_SEAPORT`,
  `VAULT_ORDER_PROTOCOL`, `VAULT_LISTING_CONDUIT_KEY` — also immutables in the
  vault code (DeployDiamond.s.sol `_vaultEndpoints`).
- `PRICE_GUARD_DELAY_SECONDS` (optional; testnet default 0).
- `INTERACTION_LAUNCH_TIMESTAMP` (+ optional `INTERACTION_CAP_VPFI_PER_ETH`) for
  `SetInteractionLaunch.s.sol` — the SAME value on every chain.
- `REWARD_CUSTODY_PAUSE_EPOCH` (+ the `REWARD_CUSTODY_*` answers, all zero on a
  fresh Diamond) for `ActivateRewardCustody.s.sol`. A mirror needs no token
  variable: `Deployments.readVpfiToken()` reads `.vpfiToken`, else the
  mirror's `.vpfiMirror` (hardening lesson 5, fixed), and only then the
  prefixed `<PREFIX>_VPFI_TOKEN_ADDRESS`.
- `REHEARSAL_ALLOW_CHAIN_ID` — ONLY for rehearsal flow scripts against a
  rehearsal Diamond (never the live one; §8).
- `ETHERSCAN_API_KEY` — only if verifying sources.
- Must NOT be set: `DEPLOY_SKIP_ARTIFACTS` (refused on a live broadcast),
  `SKIP_VPFI`/`CONFIGURE_VPFI_PEG` (forced off by configure; VPFI stays
  unpriced at launch, #884).

### 1.3 Funded accounts per chain

- Deployer EOA: gas for DeployDiamond (~110M gas on Base Sepolia per the
  2026-05 rehearsal notes; DeploymentRunbook "Rehearsal lessons learned") plus
  timelock, feed registry, launch gate, VPFI token, crosschain stack. BNB:
  ≥0.3 tBNB (BNBTestnetDeploy.md "Funding floor"). Exact amounts for the
  current build: **UNVERIFIED** — fund generously.
- Admin EOA: gas for ccip-wire, mocks, configure, sanctions overlay, custody
  activation, settings restoration, launch (BNB ≥0.05 tBNB per the same table;
  probably low).
- Admin on Base also needs **VPFI** to `fundRewardPool` (§5.5). The 23M mint
  lands on `TREASURY_ADDRESS`; moving some to the admin, or minting via
  `TreasuryFacet.mintVPFI`, is an operator decision (**UNVERIFIED** route).
- Keeper EOA (`KEEPER_PRIVATE_KEY` on the keeper machine): gas on every chain;
  it pays CCIP fees for day-close/broadcasts if `REWARD_DAY_CLOSE_ENABLED`
  (KeeperMachine.md §5 step 3).
- Optional: ETH for `ProtocolBroadcastFacet.topUpBroadcastBudget()` on Base
  (§5.7).

### 1.4 Cloudflare

- Secrets Store `1e66429d0fa24aa38a27bc05b7bcf63e` must already hold
  `RPC_BASE_SEPOLIA`, `RPC_ARB_SEPOLIA`, `RPC_BNB_TESTNET` with `--scopes
  workers`. Verify (lists names only):
  `npx wrangler secrets-store secret list 1e66429d0fa24aa38a27bc05b7bcf63e --remote --per-page 100`
  (DeploymentRunbook "Prerequisites: one-time Worker RPC-secret setup"). The
  `cf-*` phases hard-fail if missing (`lib/worker-secrets.sh`).
- Alchemy webhook keys `ALCHEMY_WEBHOOK_SIGNING_KEY_<chainId>` already bound
  for 84532/421614/97 (DeploymentRunbook "#757"); no change needed for the
  same chains.
- D1: shared `vaipakam-warm` (owned by `apps/indexer`), keeper-private
  `vaipakam-keeper-db` (CLAUDE.md "Cloudflare D1 schema discipline").

### 1.5 Safes / multisig on testnet

Needed only if you run the `handover` phase (§6): the Governance Safe
(`TIMELOCK_PROPOSER` = `EMERGENCY_REVOKER_ADDRESS`) and Pauser Safe
(`PAUSER_ADDRESS`) must have **bytecode on every chain** (the handover refuses
otherwise; `deploy-testnet.sh` `phase_handover` "Multisig-bytecode preflight").
`DeployTimelock` needs the addresses even without a handover. The precedent
deploy did no handover.

---

## 2. Pre-deploy gate

### 2.1 Full regression — in chunks (only now, before the fresh deploy)

CLAUDE.md "Per-PR verification is TARGETED — full regression is a pre-deploy
gate only" and "Local full regression — run it via run-regression.sh":

```bash
cd contracts
bash script/build-and-regress.sh          # forge build --skip test, then run-regression.sh
# or, equivalently, the two stages:
FOUNDRY_PROFILE=default forge build --skip test
bash script/run-regression.sh             # chunked; add --invariants for the invariant suites
```

- Never run bare `forge test` / bare `forge build` (viaIR stack ceiling,
  #601). If a chunk trips the ceiling: `CHUNK_SIZE=N` / `SUBDIR_CHUNK_SIZE=N`
  (defaults 25 / 3; `run-regression.sh`).
- Fork suites self-gate on `FORK_URL_*`; leave them unset unless you want them.
- The run aborts if a test file is uncovered (exhaustiveness guard; add a new
  subdir to `SUBDIRS` in `run-regression.sh`).
- Transient-storage note: forge ≥1.8 splits test-body calls into separate
  transient contexts (CLAUDE.md "Test Structure") — use the pinned version.

### 2.2 predeploy-check (deploy-sanity, storage layout, ABI parity)

```bash
cd contracts
FOUNDRY_PROFILE=default bash script/predeploy-check.sh
```

Steps (`predeploy-check.sh`): `[1/4]` `forge build --skip test`; `[1b]`
storage-layout guard (refuses a stale `contracts/storage-layout/layout.golden.json`
or incomplete roots); `[1c]` measured-delivery guard; `[1d]` loan-terms writer
guard; `[1e]` permissionless-steps ledger; `[2/4]` deploy-sanity suite
(`test/deploy/*`: EIP-170 sizes, selector coverage); `[2b]`/`[2c]` guardrails;
`[3/4]` deploy shell-script lint; `[4/4]`/`[4b]` committed ABIs and TS
`Deployment` keys match.

The `contracts` phase re-runs this same check per chain (`[1b]`), ~30 min each
(FreshDeployHardeningPlan lesson 10; not yet cached).

### 2.3 Storage-layout records

Nothing to do by hand for a fresh deploy: `--fresh` archives
`storage-layout.json` / `storage-layout.anchor.json` and `DeployDiamond` writes
fresh ones; `DeployVPFIToken` and `DeployCrosschain` check and rewrite them
(they run with `--ffi`) (CLAUDE.md "Storage-layout guard", "Each chain carries
its own record"). Commit both files with the deploy.

### 2.4 Before `--fresh` on chains that already carry state

1. **Drain Base's reward remittances** (DeploymentRunbook "Before a `--fresh`
   redeploy of a chain that already carries reward state: drain the
   remittances"):
   - On the keeper machine set `REWARD_REMIT_ENABLED=false` in
     `/etc/vaipakam/keeper.env` and apply it (KeeperMachine.md §6); leave
     `REWARD_REMIT_ACK_ENABLED` armed (needs owner OK for any flag change).
   - On the CURRENT Base Diamond read
     `cast call <old base diamond> 'getRemitReservationNonce()(uint256)' --rpc-url "$BASE_SEPOLIA_RPC_URL"`
     and every reservation from 1 up to AND INCLUDING that nonce
     (`getRemitReservation(...)`, `RewardRemittanceLensFacet`): the nonce is
     the highest id issued (dispatch takes `++remitReservationNonce`), so the
     latest reservation has exactly that id. Wait until each is status 2
     (acked) or 3 (released, stranded share resolved). Nonce 0 = nothing to
     drain.
   - Then disarm `REWARD_REMIT_ACK_ENABLED`. Record any reservation that will
     not settle, by id, in the deploy's release-note fragment.
2. **Orphan check.** `phase_contracts` reads `getActiveOffersCount()` /
   `getActiveLoansCount()` on the prior Diamond and refuses `--fresh` unless
   `--confirm-orphans-prior-onchain-state` is passed. The prior Diamond keeps
   its storage and stays settleable directly. Orphaning is an **owner
   decision** — get it explicitly.
3. **Archive manifest.** `--fresh` records the prior Diamond in the committed
   `contracts/deployments/archive-manifest.json` BEFORE moving the artifact to
   the gitignored `contracts/deployments/<slug>/.archive/<ISO>/`
   (`deploy-testnet.sh` `archive_chain_state`, via
   `packages/contracts/scripts/archive-manifest.mjs`). The indexer seeds retired
   Diamonds from this committed file (CLAUDE.md "A fresh Diamond ... is a new
   indexer EPOCH"). It must be committed with the deploy.
4. **What `--fresh` keeps and archives** (FreshDeployHardeningPlan lesson 3,
   fixed). The contracts phase carries the records that are not the Diamond's
   into the new artifact by itself: `keeperAddress`, `sanctionsList`,
   `sanctionsDelistingTimelock`, `sanctionsOracleStandIn` and
   `sanctionsClearanceAttestor` (`CARRY_FORWARD_KEYS` in `deploy-testnet.sh`;
   the run prints what it saved and what it carried). It archives
   `reward-custody-activated.json` with the rest of the old chain state, so
   the new Diamond is never described as already activated. A
   `.carry-forward.json` left in a chain directory means the merge did not
   run; the deploy names it. Lesson 6's operating settings are still manual
   (item 5).
5. **Record the old operating settings** to restore later (§5.6): read them
   from the archived Diamonds (precedent ReleaseNotes-2026-11-04).

---

## 3. Per-chain deploy

Run each phase per chain and eyeball its output before the next. Do Base first.

### 3.1 preflight (read-only)

```bash
bash contracts/script/deploy-testnet.sh base-sepolia --phase preflight
bash contracts/script/deploy-testnet.sh arb-sepolia  --phase preflight
bash contracts/script/deploy-testnet.sh bnb-testnet  --phase preflight
```

Checks RPC chain id, required vars, deployer balance (`phase_preflight`).
Mirror WARN for `BASE_REWARD_DEPLOYMENT` unset is expected at this point.

### 3.2 contracts (all three chains)

```bash
bash contracts/script/deploy-testnet.sh base-sepolia --phase contracts \
  --confirm-i-have-multisig-ready --fresh [--confirm-orphans-prior-onchain-state]
# then arb-sepolia, then bnb-testnet, same flags
```

What it does (`phase_contracts`): `[1c]` VPFI token preflight (canonical);
orphan guard; `[0a]` archive + manifest; `[0b]` retired-Diamond seed attempt;
`[1]` `forge build --skip test`; `[1b]` predeploy-check; `[2·arb]`
`ARB_L2_DEPLOY_BLOCK` on Arbitrum; manifest `live-begin`;
`[2]` `DeployDiamond.s.sol` (`--ffi`); `[3]` `DeployTimelock.s.sol`; `[3a]`
`DeployLaunchGate.s.sol`; `[3a']` `DeployFeedRegistry.s.sol`; `[3b]`
`DeployVPFIToken.s.sol` (Base only, 23M to `TREASURY_ADDRESS`); `[4]`
`DeployCrosschain.s.sol`; `[5b]` `setPartialFillEnabled(true)`; manifest
`live-end`; writes `deployment_source.json`; marker `phase-contracts.done`.

Inside `DeployDiamond` (DeployDiamond.s.sol steps 5c–6z) — **all automatic,
no manual step**: PositionNFT (5c, `initializeNFT`), feed registry + PriceGuard
+ ProtocolRegistry (5c-ii; registry seeded with `PRICE_GUARD`, 3-day delay),
`initializeProtocolRegistry` (5c-iii, fixes the USD numeraire), backstop vault
(5c-iv), VaultProtection + vault implementation + VaultBeacon (5d,
`initializeVaultBeacon`; checks `getTreasury()==TREASURY_ADDRESS`), reward
custody holder bound (5d-ii), Diamond **left paused** (5e), matcher on (5f),
roles moved deployer→admin (6), vault address derivation check (6z), artifact
+ Step 7b facet-key read-back.

Expected: `paused()==true`; `addresses.json` gains `diamond`, `facetCount`,
`vaultBeacon`, `positionNFT`, `protocolRegistry`, `priceGuard`, `feedRegistry`,
`timelock`, the CCIP stack (`ccipMessenger`, `vpfiTokenPool`,
`vpfiPoolRateGovernor`, `rewardMessenger`, plus Base `vpfiToken`,
`buybackRemittanceReceiver`, `vpfiReturnReceiver`; mirrors `vpfiMirror`,
`rewardRemittanceReceiver`, `vpfiReturnSender`). (Key names for the new
contracts: **UNVERIFIED** beyond `HandoverPlan.sol`, which reads
`feedRegistry`, `vaultBeacon`, `positionNFT`, `protocolRegistry`, `priceGuard`.)

Verify after each chain:

```bash
D=$(jq -r .diamond contracts/deployments/<slug>/addresses.json)
cast call $D 'paused()(bool)' --rpc-url "$<RPC_VAR>"            # true
cast call $D 'getTreasury()(address)' --rpc-url "$<RPC_VAR>"    # TREASURY_ADDRESS
jq -r .monorepoCommit contracts/deployments/<slug>/deployment_source.json  # no " (dirty)"
```

Then put the new Diamond addresses in `.env`: `BASE_REWARD_DEPLOYMENT`
(mirrors) and `MIRROR_REWARD_DEPLOYMENTS` (Base).

Known traps: an Arbitrum diamond cut sent with a too-low gas estimate left a
half-built Diamond in the precedent (hardening lesson 1) — raise
`FORGE_GAS_MULTIPLIER` if a cut fails, and see §9. dRPC throttling / stale
estimates: use a different `<CHAIN>_RPC_URL` for the run (DeploymentRunbook
"Rehearsal lessons learned").

### 3.3 ccip-wire (after `contracts` landed on ALL chains; any order)

```bash
bash contracts/script/deploy-testnet.sh base-sepolia --phase ccip-wire
bash contracts/script/deploy-testnet.sh arb-sepolia  --phase ccip-wire
bash contracts/script/deploy-testnet.sh bnb-testnet  --phase ccip-wire
```

See §4.

### 3.4 BNB only: swap-adapters (before testnet-mocks)

```bash
bash contracts/script/deploy-testnet.sh bnb-testnet --phase swap-adapters
```

Deploys `DeployUniV3Adapter.s.sol` (PancakeSwap V3) at adapter index 0; skips
0x/1inch on 97 (`phase_swap_adapters`). Base/Arb Sepolia: skip this phase (no
0x backend, no v1 SwapRouter; their route is the rig's MockSwapAdapter —
`phase_testnet_mocks` comment).

### 3.5 testnet-mocks (every chain, BEFORE configure)

```bash
bash contracts/script/deploy-testnet.sh <slug> --phase testnet-mocks
```

`DeployTestnetMocks.s.sol`: faucet tokens/NFTs, their feeds, a registered
MockSwapAdapter, recorded under `.testnetMocks`. Never re-run without intent
(a second run deploys a second rig and orphans faucet balances); marker
`phase-testnet-mocks.done`. Check: `checkLiquidity(address)(uint8)` → 0 for
`.testnetMocks.liquidToken` / `.liquidToken2` (BNBTestnetDeploy.md §2).

### 3.6 configure (every chain, after testnet-mocks and after all Diamonds exist)

```bash
bash contracts/script/deploy-testnet.sh <slug> --phase configure
```

Runs `DiamondConfigSpell.s.sol` (`ConfigureVPFIToken` — `setVPFIToken`, Base
`setCanonicalVPFIChain(true)`; `ConfigureOracle` — adopts the rig's wiring,
completes the PriceGuard entries under the testnet's zero delay, writes the PAA
quote list; `ConfigureRewardReporter`; `ConfigureNFTImageURIs`) then
`ConfigureSanctionsOracle.s.sol` (testnet overlay) (`phase_configure`).

Read back (DeploymentRunbook "3b", "Post-step verification"):
`getRewardReporterConfig()` on every chain; on Base
`getExpectedSourceChainIds()`, `getMirrorRewardDeployment(421614|97)`,
`getCurrentLapseScheduleVersion()`; on mirrors `getBaseRewardDeployment()` ==
new Base Diamond; `getRewardRole()` (0 Base, 1 mirrors);
`getSanctionsOracle()` non-zero. An unset reward var only WARNs and skips on
testnet — check the readbacks.

### 3.7 Reward-custody activation (every chain) — MANUAL, see §5.4

### 3.8 Settings restore, sanctions records, keeper role — MANUAL, see §5

### 3.9 launch — see §5.5 for the reward-cap ordering

```bash
bash contracts/script/deploy-testnet.sh <slug> --phase launch
```

`Launch.s.sol` prints each readiness check as `met / NOT MET / NOT CHECKED`;
on testnet refuses on any `NOT MET`, then the admin key unpauses (no handover)
(`phase_launch`; DeploymentRunbook `launch` row). Never unpause with `cast`.
Re-run the phase after any external unpause only to record.

### 3.10 verify

```bash
bash contracts/script/deploy-testnet.sh <slug> --phase verify
```

`[1]` sentinel reads, `[2]` exact facet count vs `.facetCount`, `[3]`
partial-fill flag, `[4]` pool `rateLimitAdmin`==governor and ≥1 lane, `[5]`
pause state + `Launch.s.sol report()`, `[6]` reward-pool funding (Base fails
if launched and unfunded) (`phase_verify`). Then the **manual per-lane limiter
read** in §4.3.

---

## 4. Cross-chain configuration (CCIP)

Source: DeploymentRunbook "2. Cross-chain CCIP wiring"; CcipCutoverRunbook.md
§3, §9; `ConfigureCcip.s.sol` header.

### 4.1 Order

1. `contracts` on every chain (deploys the CCIP stack via `DeployCrosschain`).
2. `ccip-wire` on every chain, any order (§3.3). Idempotent; re-run on partial
   failure. Requires `CCIP_LANE_CHAIN_IDS_<SLUG>`, `CCIP_GUARDIAN`,
   `CCIP_TOKEN_ADMIN_REGISTRY_<SLUG>`, `CCIP_REGISTRY_MODULE_OWNER_CUSTOM_<SLUG>`.

### 4.2 What `ConfigureCcip` wires (no separate manual step)

Every chain: `CcipMessenger` chain selectors, remote messengers, channels
`vpfi-reward`, `vpfi-buyback`, `vpfi-reward-budget`, `vpfi-return`
(hub-and-spoke with Base), guardian (`CCIP_GUARDIAN`) on every
`GuardianPausable`; TokenPool accepts ownership, governor as `rateLimitAdmin`,
one lane per remote with limits on (#3539/#3559), re-asserted via
`VpfiPoolRateGovernor`; `TokenAdminRegistry` CCT registration; Diamond
`setRepatriationTokenAdminRegistry` + `setRepatriationEndpoints` (Base
`(0, vpfiReturnReceiver)`, mirror `(vpfiReturnSender, 0)`); `TreasuryFacet`
messenger/buyback receiver; mirror `setRewardRemittanceReceiver`. Base:
`VaipakamRewardMessenger.setBroadcastDestinations`. Mirror:
`VPFIMirrorToken.setTokenPool`.

BNB: the node refuses a priority tip under 0.1 gwei. The precedent's first BNB
ccip-wire sent nothing because only the gas price was pinned. Since the
hardening fix of lesson 8, a pinned gas price pins the tip too
(`ETH_PRIORITY_GAS_PRICE`, which forge and cast read; `<SLUG>_PRIORITY_GAS_PRICE_WEI`
overrides it), and the run prints both. Every broadcast is followed by a
receipt check that stops at the first failed transaction (lesson 1).

### 4.3 Verification (CcipCutoverRunbook §9 + DeploymentRunbook `verify` row)

For every lane on every pool (the `verify` phase does not read limiter
config):

```bash
POOL=$(jq -r .vpfiTokenPool contracts/deployments/<slug>/addresses.json)
cast call $POOL 'getCurrentOutboundRateLimiterState(uint64)((uint128,uint32,bool,uint128,uint128))' <remoteSelector> --rpc-url "$<RPC_VAR>"
cast call $POOL 'getCurrentInboundRateLimiterState(uint64)((uint128,uint32,bool,uint128,uint128))'  <remoteSelector> --rpc-url "$<RPC_VAR>"
```

Expect `isEnabled==true`, capacity 50,000e18, rate ≈5.8e18/s; since #3559 the
bucket starts full. Also: `getSupportedChains()` = the lane set;
`getRepatriationTokenAdminRegistry()` non-zero on every Diamond; mirror
`VPFIMirrorToken.tokenPool()` == pool; Base
`getBroadcastDestinations()` lists 421614 and 97; VPFI registered in each
`TokenAdminRegistry`. Remote chain selectors: from `CCIP-INFRA-ADDRESSES.md`
or the messenger's `chainSelectorOf` (**UNVERIFIED** exact getter name;
CcipCutoverRunbook §9 names `chainSelectorOf` / `remoteMessengerOf`).

---

## 5. Post-deploy configuration the scripts do NOT do

All signed by `ADMIN_PRIVATE_KEY` while it still holds every role (no
handover). Order matters: §5.1–§5.4 before launch; §5.5 governs launch timing.

### 5.1 Sanctions — done by `configure`; carry forward the standalone records

- `ConfigureSanctionsOracle` sets the admin's `TestnetSanctionsOverlay` as the
  oracle (no manual call). Check `getSanctionsOracle()` and that the `launch`
  report's "sanctions oracle set" is met.
- **Manual:** re-add to each new `addresses.json` the standalone sanctions
  records saved in §2.4 (`sanctionsList`, `sanctionsDelistingTimelock`,
  `sanctionsClearanceAttestor`, `sanctionsOracleStandIn`) so the
  `ops/sanctions` services (they read the deployments bundle) keep working
  (hardening lesson 3). If the delisting/clearance route must be rewired to
  the new messengers, see `ConfigureSanctionsClearance.s.sol`,
  `DeploySanctionsDelisting.s.sol` (precedent ReleaseNotes-2026-11-04 BNB
  thread). The stand-in must be marked updated at least every 7 days or the
  automated delisting route closes (same thread). Exact commands:
  **UNVERIFIED** — read those scripts' headers before running.

### 5.2 Keeper and bot roles (no handover path)

- Grant `KEEPER_ROLE` to the keeper EOA on every chain (precedent: "The keeper
  wallet holds the keeper role"):
  `cast send $D 'grantRole(bytes32,address)' $(cast keccak KEEPER_ROLE) <keeper EOA> --private-key "$ADMIN_PRIVATE_KEY" --rpc-url "$<RPC_VAR>"`
  (`LibAccessControl.KEEPER_ROLE = keccak256("KEEPER_ROLE")`). Gates the mirror
  commitment report, the asset-tier relay and a `ClaimFacet` keeper path.
- `WATCHER_ROLE` (gates `AdminFacet.autoPause`) and `NOTIF_BILLER_ROLE`
  (`markNotifBilled`) to their bot keys — **granted on this deploy** (owner
  decision, §12 item 6), the same `grantRole` call with
  `$(cast keccak WATCHER_ROLE)` / `$(cast keccak NOTIF_BILLER_ROLE)`.
- Base: the remittance keeper = keeper wallet (precedent; setter name
  **UNVERIFIED** — see AdminConfigurableKnobsAndSwitches.md reward sections).
- **`keeperAddress`** in each `contracts/deployments/<slug>/addresses.json`
  (the only manual artifact key; read by the app's Auto-lend card). Derive with
  `cast wallet address --private-key "$KEEPER_PRIVATE_KEY"` on the keeper
  machine, add the key, then re-export (§7) (DeploymentRunbook "Auto-lend keeper
  address (#625 WI-1)").

### 5.3 Terms of Service (`LegalFacet.setCurrentTos`)

A fresh Diamond has `currentTosVersion==0`, which **disables the ToS gate**
(LegalFacet.sol `isTermsAccepted` notes). Not required for launch. To enable
it, publish version N in `apps/www/src/pages/terms/versions.ts` (latest entry
today: version 3), deploy `apps/www` first, then
`setCurrentTos(N, <keccak hash from versions.ts>)` (ADMIN_ROLE; version must
strictly increase; hash non-zero) (GovernanceRunbook "Bumping the Terms of
Service"). **On this deploy: arm it with version 2 on all three chains**
(owner decision, §12 item 5).

### 5.4 Reward-custody activation (every chain, after configure, before launch)

`rewardCustodyActivated()` reads false on a fresh Diamond; until activation
`fundRewardPool` reverts `RewardCustodyNotActivated` (GovernanceRunbook "VPFI
recycling — activation ceremony", Gate A). Requires role Canonical/Mirror (so
after configure) and the MANUAL pause (the born-paused state counts as paused;
`ActivateRewardCustody.run()` additionally calls `pause()` itself and activates
at epoch+1).

```bash
cd contracts
# 1. read the live pause epoch (pauseTransitions from LibPausable's slot);
#    the script's preflight refuses a mismatch and names it. Read method:
#    UNVERIFIED — the refusal message is the practical check.
# On a mirror the script reads the artifact's .vpfiMirror itself (lesson 5).
REWARD_CUSTODY_PAUSE_EPOCH=<live epoch> \
  forge script script/ActivateRewardCustody.s.sol --rpc-url "$<RPC_VAR>" --broadcast --slow
# 2. after the transactions confirm:
forge script script/ActivateRewardCustody.s.sol --sig "record()" --rpc-url "$<RPC_VAR>"
```

All `REWARD_CUSTODY_*` answers stay zero on a fresh Diamond (precedent: "every
ledger row at zero ... no VPFI was moved"). Read back
`rewardCustodyActivated()==true`, `rewardCustodyHolder()` non-zero with code.
Commit `reward-custody-activated.json`. Extra `pause()` calls before launch
are harmless to the launch check (it reads the first-unpause record) —
**UNVERIFIED**, but the precedent launched after activation.

### 5.5 Rewards launch anchor, pool funding, reward-cap arming — gates `launch`

New since the last deploy (#3253, #3360 A+B; ReleaseNotes-2026-11-10 and -11;
`LibLaunchReadiness._rewardCapArmed`). `launch` now refuses on Base unless the
cap's first armed day D* is set, the reward clock runs, and today ≥ D*; on a
mirror unless Base's broadcast carrying D* has landed and today ≥ D*.

Order:
1. **Base: fund the pool** — `RewardCustodyFacet.fundRewardPool(amount)`
   (ADMIN; after activation; works while paused; pulls VPFI from the caller, so
   `approve(diamond, amount)` on the VPFI token first). Amount is the
   operator's decision (DeploymentRunbook "3b", "Fund Base's reward pool before
   Base's anchor"); **on this deploy: 100,000 VPFI, sourced from the treasury
   wallet through the admin** (§12 item 3). `SetInteractionLaunch` refuses Base's anchor while
   `getDeliveredFreshBound()` shows no headroom.
2. **Anchor, Base first, then mirrors, SAME value** (one-shot; a mirror on a
   different value has every day zeroed on Base):
   `INTERACTION_LAUNCH_TIMESTAMP=<unix ts, 00:00 UTC> forge script script/SetInteractionLaunch.s.sol --rpc-url "$<RPC_VAR>" --broadcast`
   (reads the Diamond from the artifact; `ADMIN_PRIVATE_KEY`). Precedent: the
   midnight UTC of the relaunch day.
3. **Base: arm D*** — no script exists:
   `cast send $BASE_D 'setGovernorCommitArmedFromDay(uint256)' <dayId> --private-key "$ADMIN_PRIVATE_KEY" --rpc-url "$BASE_SEPOLIA_RPC_URL"`
   One-shot; `dayId` must be > today's reward day (`getInteractionCurrentDay()`).
   Mirrors learn D* only from Base's broadcasts — no mirror-side arming
   (AdminConfigurableKnobsAndSwitches.md "Governor commitment arming").
4. **Wait until reward day D*** begins, then `--phase launch` on Base.
5. **Mirrors** launch only after Base (now unpaused) has finalized and
   broadcast a day after arming (keeper `REWARD_DAY_CLOSE_ENABLED`, or manual
   `closeDay` / `finalizeDay` / `broadcastGlobal`, which are `whenNotPaused`),
   that broadcast has landed (mirror ingress `onRewardBroadcastV3Received` is
   not pause-gated), and today ≥ D*. Base's `finalizeDay` while the mirrors are
   still paused (so not reporting) presumably waits out the reward grace —
   **UNVERIFIED**; read the mirror's `launch` report line "the fee-linked
   reward cap is armed before any loan", which names what is missing.

Consequence: a full mesh launch takes at least one to two UTC days.

### 5.6 Restore testnet operating settings (precedent, manual)

Read each from the archived Diamond and write onto the new one, then read
back (ReleaseNotes-2026-11-04; hardening lesson 6): service capacity on with
its deposit escrow bound (`serviceCapacityEscrow`), the 2% arming fee, solver
and keeper capacity curves, auto-extend, lender intents
(`LenderIntentFacet.setLenderIntentEnabled(true)`), the priority-routing perk
at 2 VPFI a credit; Base: fee entitlement, reward grace 43,200 s, remittance
keeper. Setter names: AdminConfigurableKnobsAndSwitches.md (sections "Full
VPFI tariff kill switch", "Standing-intent fill switch", "T-092 auto-lifecycle
kill switches", "Spend-gated perk configuration", "Reward grace seconds").
Exact calls: **UNVERIFIED**. Leave every other dark knob dark (that doc's "Dark
and dormant knobs are not 'unconfigured'").

**Then reconcile the artifact by hand before exporting** (hardening lesson 9).
`abi-sync` does NOT do this: `exportFrontendDeployments.sh` only copies each
existing `addresses.json` into the bundle and never reads the chain. For each
setting the artifact records, read it back from the new Diamond and write it
into that chain's `contracts/deployments/<slug>/addresses.json`, for example
the reward grace on Base:

```bash
g=$(cast call "$DIAMOND" 'getRewardGraceSeconds()(uint64)' --rpc-url "$BASE_SEPOLIA_RPC_URL")
jq --argjson g "$g" '.rewardGraceSeconds = $g' deployments/base-sepolia/addresses.json > /tmp/a.json \
  && mv /tmp/a.json deployments/base-sepolia/addresses.json
```

Only then run `abi-sync`, and check `git diff packages/contracts/src/deployments.json`
shows the restored values.

### 5.7 Optional

- `ProtocolBroadcastFacet.topUpBroadcastBudget()` (payable) on Base so tier
  pushes reach mirrors (code defers, not reverts, when empty — §11).
- `ConfigFacet.setMirrorTierMaxAgeSec` on mirrors (default 60 days).
- Periodic interest, auto-lend/refinance flags: ship off; owner decision.
- Nothing to do for: PriceGuard (built in DeployDiamond, completed by
  ConfigureOracle), ProtocolRegistry (seeded at construction), VaultBeacon,
  PositionNFT, backstop vault, LaunchGate (deployed in `contracts`), feed
  registry testnet delay (DeployFeedRegistry), treasury (immutable), matcher
  flag (on). The DeployDiamond comment saying swap adapters etc. "join through
  the registry's delayed add" and a "vault registry seeded" launch check is
  stale (§11).

---

## 6. Role handover on testnet

**Decision required.** The precedent deploys (Oct and 3–4 Nov 2026) did **no
handover** on any testnet ("Both remain owned by the admin key; there was no
governance handover, as on every testnet"), and CcipCutoverRunbook §4 says
"Testnet rehearsals stay deployer/admin-owned — no governance handover".
`deploy-testnet.sh` nevertheless carries `handover` / `handover-gate`, and
GovernanceRunbook "Testnet rehearsal" walks it with `TIMELOCK_MIN_DELAY=3600`.
**Recommendation: skip it** on the live testnets (after it, every setting —
including §5 — needs a Timelock proposal; the keeper/bot roles must then be
granted by the handover itself).

If the owner chooses to rehearse it (only after §5 is complete):

```bash
bash contracts/script/deploy-testnet.sh <slug> --phase handover --confirm-i-have-multisig-ready
```

`Handover.s.sol` (header and `HandoverPlan.sol`): DEFAULT_ADMIN_ROLE →
Timelock; EMERGENCY_REVOKER_ROLE → governance Safe; ADMIN/KYC/ORACLE/RISK/
VAULT/UNPAUSER → Timelock; PAUSER → Pauser Safe; ERC-173 → Timelock;
KEEPER/WATCHER/NOTIF_BILLER → `KEEPER_ADDRESS`/`WATCHER_ADDRESS`/
`NOTIF_BILLER_ADDRESS` (zero = unheld); first leg of every owned contract's
transfer (CCIP stack, VPFI token, feedRegistry, vaultBeacon, positionNFT,
protocolRegistry, priceGuard, swap adapters, satellites, sanctions contracts)
→ Timelock; guardians → Pauser Safe (`_rotateGuardians`); CCT admin
`transferAdminRole` → Timelock; admin renounces every role last.

Then, through the Governance Safe: `TimelockController.schedule(target, 0,
acceptOwnership(), 0, salt, delay)` → wait → `execute(...)` for every target
that is actually pending (`pendingOwner()==timelock`, pool by event log), and
`acceptAdminRole(<vpfiToken>)` on the `TokenAdminRegistry` if pending
(GovernanceRunbook "5. Safe-schedule acceptOwnership()"). Then:

```bash
bash contracts/script/deploy-testnet.sh <slug> --phase handover-gate
```

Read-only; rebuilds every role holder from events, checks owners, pending
owners, guardians, CCT admin, Timelock delay/proposer/canceller
(`HandoverGate.s.sol`; GovernanceRunbook "6. Readback verification"). After a
handover, `--phase launch` prints a Timelock `scheduleBatch`/`executeBatch` for
`AdminFacet.launch(...)` instead of unpausing, and the launch must be the
Timelock's next call.

---

## 7. Off-chain

### 7.1 Export deployments + ABIs (after all on-chain steps, incl. §5.2 keeperAddress)

```bash
bash contracts/script/deploy-testnet.sh base-sepolia --phase abi-sync
# = exportFrontendAbis.sh + exportFrontendDeployments.sh
#   + exportAbis.sh (only if ../vaipakam-keeper-bot exists) + exportTenderlyAlerts.sh <slug>
pnpm --filter @vaipakam/app exec tsc -b --noEmit
pnpm --filter @vaipakam/keeper exec tsc -p . --noEmit
pnpm --filter @vaipakam/indexer exec tsc -p . --noEmit
pnpm --filter @vaipakam/agent exec tsc -p . --noEmit
```

(CLAUDE.md "Deployments sync", "Frontend ABI sync"). `exportFrontendDeployments.sh`
folds only chains listed in `.active-chains` (no change needed).

### 7.2 Keeper-bot ABI sync (CLAUDE.md "Keeper-bot ABI sync")

From a clean checkout: `cd contracts && forge build --skip test && cd ..`
then `KEEPER_BOT_DIR=../vaipakam-keeper-bot bash contracts/script/exportAbis.sh`;
in the bot repo review `git diff src/abis/`, `npm run typecheck`, commit
"Sync ABIs with vaipakam@<commit>". (The precedent left this uncommitted.)

### 7.3 Commit and merge

Commit on a branch, PR to `main` (CLAUDE.md "Codex PR-review policy", release
note fragment under `docs/ReleaseNotes/unreleased/`, e.g. the precedent's
`deploy-allwaves-base-arb-testnets.md`):
`contracts/deployments/archive-manifest.json`,
`contracts/deployments/<slug>/{addresses.json, deployment_source.json,
storage-layout.json, storage-layout.anchor.json, reward-custody-activated.json}`,
`packages/contracts/src/{deployments.json, _deployments_source.json, abis/}`,
`ops/tenderly/generated/`. (`.markers/`, `.history/`, `.archive/` are
gitignored.)

Merging matters operationally: **the keeper machine deploys `main`** (its
update timer pulls CI's build every 5 min; KeeperMachine.md §1), and Workers
Builds auto-deploys Workers on merge (CLAUDE.md "Migrations apply BEFORE code
ships").

### 7.4 Workers — indexer FIRST

```bash
bash contracts/script/deploy-testnet.sh base-sepolia --phase cf-indexer --fresh
bash contracts/script/deploy-testnet.sh base-sepolia --phase cf-keeper
bash contracts/script/deploy-testnet.sh base-sepolia --phase cf-agent
bash contracts/script/deploy-testnet.sh base-sepolia --phase cf-app
bash contracts/script/deploy-testnet.sh base-sepolia --phase cf-www   # NEEDS DECISION first: §11 item 6
```

(Each `cf-*` deploys the whole Worker once; the slug only selects which RPC
secret is checked — run `cf-indexer`/`cf-agent`/`cf-keeper` with each slug, or
check the other secrets by hand.)
- `cf-indexer`: `apps/indexer` `pnpm run deploy` = `deploy-shared-d1.mjs
  apply`: applies `vaipakam-warm` migrations, verifies, seeds retired Diamonds
  from the committed manifest, publishes. The indexer's first pass under the
  new bundle resets the chain's rows and restarts from the new `deployBlock`
  (epoch). Never seed or edit `indexer_cursor` by hand.
- `cf-keeper`: applies `vaipakam-keeper-db` migrations and publishes the
  Worker, which only serves as the migration applier; the keeper itself runs
  on the always-on machine and declines until the indexer adopts the same
  Diamond (KeeperMachine.md §2, §4a).
- `cf-agent`: verify-mode; publishes even with a pending migration (#3115).
- `cf-app`: `pnpm run deploy` (sets `REQUIRE_INDEXER_ORIGIN=1`). Read the
  printed #1854 advisory.
- Also deploy, outside the wrapper: `apps/alpha05` (`pnpm --filter <alpha05
  package> run deploy`), `ops/mesh-watcher` (reads the deployments bundle) —
  through their package scripts, never bare `wrangler deploy` (CLAUDE.md "Live
  testnet review"). Package names: **UNVERIFIED**.
- `ops/sanctions` services on their machine pick up the new bundle per their
  own README — **UNVERIFIED** procedure.

### 7.5 Keeper machine arming

(KeeperMachine.md §4–§5.) Flags live in `/etc/vaipakam/keeper.env` on the
machine (not Cloudflare). Each arming is an **owner decision**; arm one at a
time and watch `journalctl -u vaipakam-keeper -f` for `chains resolved: …`,
no `tick declined`, and the pass's `done in` line. Re-arm what the precedent
ran and what the new Diamonds need, notably: `KEEPER_ENABLED`,
`REWARD_DAY_CLOSE_ENABLED` (needed for §5.5 step 5 unless done by hand),
`REWARD_REMIT_ENABLED` + `REWARD_REMIT_ACK_ENABLED` (re-arm after §2.4 drain),
`REWARD_COMMIT_ENABLED`, `PRICE_CHECKPOINT_ENABLED` (without it every forced
sale uses the full slippage cap and guarded offers cannot fill),
`PERIODIC_SETTLE_ENABLED`, `GRACE_DEFAULT_ENABLED`, `PROTECTED_ACCOUNT_ENABLED`
(+ `PROTECTED_LOCK_ENABLED`, `PROTECTED_ALERTS_ENABLED`),
`VAULT_BEACON_UPKEEP_ENABLED`, and the rest listed in KeeperMachine.md §5
step 3. Note: `docs/ops/KeeperMachine.md` currently contains unresolved merge
markers (lines 333–416) — read both halves.

---

## 8. Verification and smoke tests

1. `--phase verify` green on every chain (§3.10) + per-lane limiter reads
   (§4.3).
2. Launch report all `met` (`forge script script/Launch.s.sol --sig "report()" --rpc-url ...`
   with `CHAIN_SLUG` set, as `phase_verify` runs it).
3. Reward reads (DeploymentRunbook "3b" post-step verification): identical
   `getInteractionLaunchTimestamp()` on all chains; Base
   `getDeliveredFreshBound()` remaining > 0.
4. ChainByChainChecks.md §1–§5b (structure only — its expected counts are
   stale, §11; access-control expectations in §2 assume a handover).
5. Indexer: `GET <indexer origin>/health/ingest` names the NEW Diamond per
   chain; cursor advancing:
   `cd apps/indexer && npx wrangler d1 execute vaipakam-warm --remote --json --command "SELECT chain_id, last_block, datetime(updated_at,'unixepoch') FROM indexer_cursor WHERE kind='diamond' ORDER BY chain_id;"`
   (DeploymentRunbook "Post-deploy verification").
6. Keeper journal: `Diamond changed … reset private …` once per chain, then
   normal ticks.
7. Live-fork check of the deployed bytecode (does not touch the live chain):
   `anvil --fork-url "$BASE_SEPOLIA_RPC_URL" --chain-id 84532`, then
   `cd contracts/script/fork-scenarios && npm ci && node run-all.mjs`
   (its README).
8. Do **NOT** run `PositiveFlows*`/`PartialFlows`/`NegativeFlows`/`Sepolia*`
   against the live Diamonds — they re-point the oracle/sanctions to mocks;
   they refuse unless `REHEARSAL_ALLOW_CHAIN_ID` is set (DeploymentRunbook
   "3. Smoke tests").
9. App live review (CLAUDE.md "Live testnet review is part of
   definition-of-done"): confirm `app.vaipakam.com` and the `workers.dev` URL
   serve the same `/assets/index-*.js`; drive the features end to end with the
   dev test wallets (Playwright driver; `apps/app/e2e/live/`,
   `run-live-batch.mjs`); never review `alpha02`.

---

## 9. Recovery from a mid-flight failure

- **Never `forge script --resume`** the storage-layout-checked scripts
  (`DeployVPFIToken`, `DeployCrosschain`, every in-place refresh script) —
  resume sends the saved plan without running the checks (CLAUDE.md
  "Storage-layout guard"; `deploy-testnet.sh` comment above `[2]`).
  `deploy-testnet.sh` itself has no `--resume`.
- **`contracts` failed mid-DeployDiamond** (e.g. out-of-gas cut): the phase
  marker is not written, a half-built Diamond is on chain, and the manifest's
  live-publication marker may still be held. Recover (hardening lesson 2):
  confirm no forge child is running; end the marker with the run's token
  `node packages/contracts/scripts/archive-manifest.mjs live-end contracts/deployments/archive-manifest.json <slug> <token> [<addresses.json>] [--force]`;
  record any on-chain half-built Diamond in the manifest (precedent recorded
  `0xA610…21E6`); restore/aside artifacts as needed; re-run `contracts` with
  `--fresh` (raise `FORGE_GAS_MULTIPLIER`). The script's `live-begin` refusal
  message names the condition.
- **`contracts` failed after DeployDiamond** (Timelock/VPFI/Crosschain):
  simplest testnet recovery is a full `--fresh` re-run (only gas is lost).
  Piecewise re-running individual scripts needs the live-publication token
  env (`VAIPAKAM_LIVE_PUBLICATION_TOKEN`) — **UNVERIFIED**, avoid.
- **ccip-wire**: idempotent, re-run. **configure / handover / testnet-mocks /
  contracts**: markers refuse re-runs; remove the marker only after reading
  the on-chain state and receipts (a second `testnet-mocks` deploys a second
  rig).
- **Hung tx (BNB)**: gas price pinned to 1 gwei; tip trap §4.2; check
  receipts before re-running.
- **Stale RPC estimate reverts** (dRPC): switch RPC and re-run the phase.
- `deploy-chain.sh --resume` exists for the one-shot script only (DeploymentRunbook
  "4. Recovery from a mid-flight failure"); not used here.

---

## 10. Checklist

- [ ] Clean `main` worktree, `pnpm install`, Node 22, forge v1.8.6.
- [ ] `.env` complete (§1.2); Secrets Store RPCs present; accounts funded.
- [ ] `bash script/build-and-regress.sh` green (chunks); `predeploy-check.sh` green.
- [ ] Owner OK: orphan prior Diamonds; drain Base remittances (nonce/reservations settled); keeper remit flags disarmed.
- [ ] Recorded the old operating settings (§2.4 item 5); `--fresh` carries `keeperAddress` and the sanctions records and archives `reward-custody-activated.json` itself.
- [ ] `preflight` ×3.
- [ ] `contracts --fresh` Base, Arb, BNB; paused; treasury; clean stamp.
- [ ] `.env`: `BASE_REWARD_DEPLOYMENT`, `MIRROR_REWARD_DEPLOYMENTS`, `REWARD_EXPECTED_SOURCE_CHAIN_IDS`, lane lists.
- [ ] `ccip-wire` ×3; limiter reads per lane.
- [ ] BNB `swap-adapters`.
- [ ] `testnet-mocks` ×3; mocks Liquid.
- [ ] `configure` ×3; reward/sanctions readbacks.
- [ ] `ActivateRewardCustody` run + record ×3.
- [ ] KEEPER_ROLE (+ others as decided); `keeperAddress`; sanctions records; settings restored.
- [ ] (Optional) ToS; broadcast budget.
- [ ] Base: fund pool → anchor (Base, then mirrors, same ts) → arm D* → wait → `launch` Base.
- [ ] Day close/broadcast reaches mirrors → `launch` Arb, BNB.
- [ ] `verify` ×3.
- [ ] (Only if decided) handover → acceptOwnership via Timelock → handover-gate.
- [ ] `abi-sync`; typechecks; keeper-bot sync; commit; PR; merge.
- [ ] `cf-indexer` → `cf-keeper` → `cf-agent` → `cf-app` → `cf-www`; alpha05; mesh-watcher.
- [ ] Indexer `/health/ingest` new Diamonds; keeper ticks clean; arm keeper flags one by one (owner OK).
- [ ] Fork-scenarios run; live app review on the deployed build.

---

## 11. Doc-vs-code disagreements and stale material found

1. **Active chain set.** DeploymentRunbook "Mainnet rehearsal" / "1. Per-chain
   deploy" use Base ↔ Arb + **OP Sepolia** via `deploy-chain.sh`; the code's
   `.active-chains` is Base, Arb, **BNB**, and the tiered `deploy-testnet.sh`
   is the rehearsal script. `deploy-chain.sh` skips configure / mocks /
   sanctions / launch.
2. **NEEDS DECISION.** **Handover on testnet.** CcipCutoverRunbook §4 ("no governance handover")
   vs GovernanceRunbook "Testnet rehearsal" and the `handover` phase. Precedent:
   none. `deploy-testnet.sh`'s own header ("What this script does NOT do: Role
   rotation") contradicts its `handover` phase.
3. **`CCIP_GUARDIAN`**: optional in CcipCutoverRunbook §2.2; required by
   `phase_ccip_wire` and `ConfigureCcip`.
4. **Node version**: runbook says 20+; root `package.json` requires ≥22.
5. **Keeper/agent with pending migrations**: `deploy-testnet.sh` comments
   (header for cf-indexer, `phase_cf_indexer`) say they "refuse to publish";
   CLAUDE.md and the runbook phase table say they publish anyway (#3115).
6. **NEEDS DECISION.** **`cf-www`** runs `pnpm run build && pnpm exec wrangler deploy` — bypasses
   the package script (no prerender, no commit stamp), against CLAUDE.md
   "Deploy through the package script, never a bare wrangler deploy".
7. **`cf-keeper` comment** calls the Worker the "autonomous HF-liquidation
   Worker"; the keeper runs on the machine and the Worker's `scheduled`
   declines (KeeperMachine.md §2). CLAUDE.md lists keeper arming flags as
   Cloudflare secrets; KeeperMachine.md puts them in `/etc/vaipakam/keeper.env`.
8. **DeployDiamond.s.sol comment** (step 5c-ii) says swap adapters etc. join
   the ProtocolRegistry by delayed add and that launch checks "vault registry
   seeded"; no such check exists in `LibLaunchReadiness` (it checks "vault
   endpoints match"), and `RegistryKeys.SWAP_ADAPTERS` is referenced nowhere
   else in `src/`.
9. **T-087 broadcast budget**: DeploymentRunbook says budget exhaustion
   reverts the deposit/withdrawal; `ProtocolBroadcastFacet` emits
   `TierPushDeferred(…Budget)` and returns.
10. **DeploymentRunbook "4. VPFI token wiring"** names
    `DeployVPFICanonical.s.sol`, `DeployVPFIMirror.s.sol`,
    `WireVPFIPeers.s.sol` — none exists. BaseSepoliaDeploy.md §3–§11 and
    BNBTestnetDeploy.md §3–§10 are LayerZero-era (bannered).
11. **"How addresses get persisted"** table lists `DeployTestnetLiquidityMocks`
    keys; the current rig is `DeployTestnetMocks` (`.testnetMocks`), and the
    table omits `vaultBeacon`, `positionNFT`, `protocolRegistry`, `priceGuard`,
    `feedRegistry`, `rewardCustodyHolder`, sanctions keys.
12. **ChainByChainChecks.md §1** expects 29 facets; the precedent Diamonds had
    109 + diamond-cut (the `verify` phase uses `.facetCount`).
13. **DeploymentRunbook "0. Pre-flight"** says `forge build` / `forge test`
    bare — contradicts CLAUDE.md (viaIR ceiling; use `--skip test` and
    `run-regression.sh`).
14. **Fixed:** `--fresh` now archives `reward-custody-activated.json` and
    carries `keeperAddress` and the standalone sanctions keys (hardening
    lesson 3).
15. **Fixed:** mirror custody activation reads the mirror's `.vpfiMirror`
    through `Deployments.readVpfiToken` (hardening lesson 5).
16. **Fixed:** a pinned gas price pins the priority tip too, and the mock
    rig reads the same `<PREFIX>_WETH_ADDRESS` as the oracle (hardening
    lesson 8).
17. **`SetInteractionLaunch.s.sol` header** says `<CHAIN>_DIAMOND_ADDRESS` is
    required; the code reads the artifact (`Deployments.readDiamond()`).
18. **`docs/ops/KeeperMachine.md`** carried unresolved git conflict markers
    at `866110925`; #3695 removed them.
19. **`phase_contracts` "Next:"** list omits testnet-mocks, configure, custody,
    launch; `phase_verify` ends "Continue with the role-rotation ceremony"
    though testnets skip it.
20. **`preflight` requires `VPFI_OWNER`/`VPFI_TREASURY`/`VPFI_INITIAL_MINTER`**,
    which `DeployVPFIToken` does not read (it reads `ADMIN_ADDRESS`,
    `TREASURY_ADDRESS`).

## 12. Owner decisions for this deploy (2026-11-16)

The owner answered the open questions on 2026-11-16, for testnet and testing
purposes. They are the inputs for the next fresh testnet deploy; the deploy
itself had not been started when they were recorded.

**When the deploy may start (owner, 2026-11-16):** only after ALL contract
engineering work in every thread is finished and merged. Before starting,
confirm with the owner that no contract change is still open in any thread;
then take `main` at that point as the deploy's commit (§1.1).

1. **Abandon the live offers and loans on the current Diamonds: yes.** They
   exist only for testing. Pass `--confirm-orphans-prior-onchain-state` to the
   `contracts --fresh` phase on each chain (§2.4 item 2). The remittance drain
   (§2.4 item 1) still runs first.
2. **Role handover: skip it.** The testnets stay admin-owned; do not run the
   `handover` or `handover-gate` phases (§6). §11 item 2 is settled by this.
3. **Base reward pool: 100,000 VPFI, from the treasury wallet**
   (`TREASURY_ADDRESS` in `contracts/.env`). `fundRewardPool` is ADMIN-only
   and pulls from its caller, and the treasury wallet is not the admin, so:
   first check the treasury holds at least 100,000 VPFI on Base Sepolia
   (`balanceOf`), then transfer 100,000 VPFI from the treasury wallet to the
   admin wallet (signed with the treasury wallet's own key; it is not in
   `contracts/.env`), then, as admin, `approve(diamond, 100000e18)` and
   `fundRewardPool(100000e18)` (§5.5 step 1). Read `getDeliveredFreshBound()`
   afterwards. The pool's funding then records the admin as payer; the
   treasury-to-admin transfer is the visible first leg.
4. **Rewards start: as soon as all three chains are deployed; Arbitrum
   Sepolia and BNB testnet may launch after Base Sepolia.** Concretely:
   once `contracts`, `ccip-wire`, `testnet-mocks`, `configure` and custody
   activation have landed on all three chains, set the anchor to 00:00 UTC
   of that day (the same value on all three, Base first, §5.5 step 2), and
   arm D\* to the EARLIEST day the contract accepts, which is the next reward
   day (`dayId` must be greater than today's, §5.5 step 3). So rewards start
   at the next 00:00 UTC: Base launches then, and the mirrors follow once
   Base's day broadcast reaches them (§5.5 steps 4–5).
5. **Terms of Service gate: on, version 2, on all three chains.** After the
   contracts exist, set `setCurrentTos(2, <hash>)` on each Diamond (§5.3).
   The hash is the keccak256 of `docs/Terms/TermsOfService.md`; on
   2026-11-15 it was
   `0xecbdf420b0b626087e8549f00c68c663ebac79c220eb1f65c55f11b4b3c2605e`.
   Recompute it at deploy time; if the file changed, stop and ask. Read
   `getCurrentTos()` before (expect 0) and after (expect 2 and the hash).
   Version 3 was published on 2026-11-18 (it rewords one risk line; hash
   `0xcb4518feedc5580707caccaf5c42024ff8cc4f111d60ef10135094e67b7f8245`).
   A deploy after that date arms the latest published version instead, and
   an existing chain moves to it only by the owner's own `setCurrentTos`.
6. **Keeper: arm the same passes as are armed now, plus the hourly price
   checkpoint (`PRICE_CHECKPOINT_ENABLED`); grant `WATCHER_ROLE` and
   `NOTIF_BILLER_ROLE`.** Before the deploy, record the flags currently set
   in the keeper machine's `/etc/vaipakam/keeper.env` (KeeperMachine.md), so
   the same set is re-armed one at a time afterwards (§7.5). Grant the two
   roles on every chain to the bot keys that run those services (§5.2); if
   either service has no key of its own yet, ask which wallet before
   granting.
7. **Sanctions delisting route: rewire it after all three chains exist, as
   last time** (§5.1), and re-record the standalone sanctions contracts in
   each `addresses.json`.
