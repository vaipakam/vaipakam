# Deployment Runbook

Step-by-step procedure for a fresh deployment of the Vaipakam Diamond on a target chain, including cross-chain reward plumbing.

Audience: release engineer + signing multisig.

> **T-068 status banner (added 2026-05-23).** This runbook predates
> T-068's migration of the cross-chain layer from LayerZero to
> Chainlink CCIP (PR #46, merged 2026-05-18). The Diamond-side
> deployment, ABI sync, JSON wiring, multisig handover, and
> per-phase orchestration logic in §1-§8 are all still current.
>
> The **cross-chain sections** below (§9 LayerZero security watcher;
> any §3-§5 step that references `ConfigureLZConfig.s.sol`,
> `DeployVPFIMirror.s.sol`, `DeployVPFIBuyAdapter.s.sol`,
> `DeployRewardOAppCreate2.s.sol`, `WireVPFIPeers.s.sol`, `lzEid`,
> `lzEndpoint`, or any DVN env var) describe the **pre-T-068
> LayerZero architecture** and are deprecated. The current cross-
> chain deploy + wiring is two scripts:
>
> 1. **`DeployCrosschain.s.sol`** — per-chain, deploys `CcipMessenger`,
>    `VaipakamRewardMessenger`, `VpfiPoolRateGovernor`, `VpfiBuyAdapter`
>    (mirror) / `VpfiBuyReceiver` (Base), `VPFIMirrorToken` (mirrors), and
>    the stock CCIP `LockReleaseTokenPool` / `BurnMintTokenPool`.
> 2. **`ConfigureCcip.s.sol`** — channel peers, lane rate limits,
>    `TokenAdminRegistry` registration, guardian wiring. Idempotent.
>
> See [`docs/adr/0004-ccip-over-layerzero.md`](../adr/0004-ccip-over-layerzero.md)
> for the migration rationale and
> [`contracts/RUNBOOK.md`](../../contracts/RUNBOOK.md) for the CCIP
> deploy sequence. The LayerZero-era subsections below stay in place
> as a historical reference; a structured rewrite of this runbook to
> CCIP-only is tracked under a follow-up card.

---

## TL;DR — pick the right script

Three deploy scripts after the 2026-05-10 modernization sweep
(see ReleaseNotes-2026-05-10.md for the full story):

| Target | Script | Notes |
|---|---|---|
| Local dev (anvil) | `bash contracts/script/anvil-bootstrap.sh` | Full local playground — diamond + mocks + Multicall3 etch + Range Orders flags ON + seed offers + ABI/JSON sync (one command). |
| Testnet one-shot (anvil + dev quick-loop) | `bash contracts/script/deploy-chain.sh <chain-slug> [flags]` | Auto-chains every step. Stage 3/4-aware: deploys two SPAs (`apps/defi`, `apps/www`) + three Workers (`apps/keeper`, `apps/indexer`, `apps/agent`). Refuses mainnet slugs. |
| Testnet rehearsal-grade (mirrors mainnet ceremony) | `bash contracts/script/deploy-testnet.sh <chain-slug> --phase <phase>` | Same tiered phase model as mainnet; lifted dirty-tree refusal; adds `--phase pause-rehearsal` (sub-5-min N-chain simultaneous-pause drill). Use this for the actual testnet rehearsal cycle, NOT deploy-chain.sh. |
| Cross-chain peer wiring | `bash contracts/script/deploy-peers.sh [--dry-run] [--only-chains slug1,slug2]` | Run ONCE after every chain's contracts have landed. Walks `deployments/*/addresses.json`, auto-detects canonical, wires `setPeer` for the VPFI lane + Buy lane + Reward OApp full mesh. Idempotent. |
| Mainnet | `bash contracts/script/deploy-mainnet.sh <chain-slug> --phase <phase>` | Tiered. Each phase is a deliberate operator action. Refuses `--phase pause-rehearsal` (testnet-only drill). Refuses testnet slugs. |
| Production incident lever | `bash contracts/script/pause-all-chains.sh [--check\|--unpause-calldata]` | Standalone (not a deploy phase). Walks every chain's `deployments/<slug>/addresses.json`, prints `pause()` calldata for the operator to fan out across N Pauser-Safe UIs in parallel. 5-minute budget tracked via the run sentinel; `--check` reads `paused()` post-fact and reports elapsed vs budget. |

### Mainnet / testnet phases (deploy-{mainnet,testnet}.sh)

| Phase | Confirm flag | Description |
|---|---|---|
| `preflight` | — | Read-only. RPC chainId, deployer balance, env-var presence, WETH-pull validation on bnb/polygon. Always run first. |
| `contracts` | `--confirm-i-have-multisig-ready` | Deploys Diamond + Timelock + VPFI lane + Reward OApp. Step `[1b]` runs `predeploy-check.sh` right after the `forge build` — the deploy-sanity forge suite (`test/deploy/*`: facet EIP-170 sizes + selector coverage + selector-collision check), deploy shell-script lint, and committed-ABI sync — and aborts before any broadcast if it fails (the mainnet script runs the full regression too, via `--full`). Auto-steps: master-flag flip (testnet only), `setRateLimits` on mirror's `vpfiBuyAdapter`. Refuses to re-run if `addresses.json` already has a `diamond` key — pass `--fresh` (testnet) or `--fresh --confirm-purging-prior-mainnet-deploy` (mainnet) to archive prior state under `.archive/<ISO-8601>/` and redeploy. **Bump `REWARD_VERSION` in `.env` before `--fresh` re-runs** — the Reward OApp proxy is CREATE2-addressed off `REWARD_VERSION`. |
| `lz-config` | `--confirm-dvn-policy-reviewed` | Runs `ConfigureLZConfig.s.sol`. Requires DVN policy env vars (DVN_REQUIRED_1/2/3 + DVN_OPTIONAL_1/2 + CONFIRMATIONS + REMOTE_EIDS + OAPP + SEND_LIB + RECV_LIB). |
| `swap-adapters` | — | Phase 7a aggregator adapters via `DeploySwapAdapters.s.sol`. Requires `INITIAL_SETTLERS` env var (current 0x Settler set). |
| `configure` | — | `DiamondConfigSpell.s.sol` — composes ConfigureOracle + ConfigureRewardReporter + ConfigureVPFIBuy + ConfigureNFTImageURIs into one operator-action. Requires per-chain Chainlink feed addresses + WETH. |
| `handover` | `--confirm-i-have-multisig-ready` | `Handover.s.sol` — rotates DEFAULT_ADMIN_ROLE → governance Safe (direct), ADMIN/KYC/ORACLE/RISK/VAULT/UNPAUSER → Timelock, PAUSER → Pauser Safe (direct), ERC-173 → Timelock, OApp ownership → governance Safe (Ownable2Step first leg). ADMIN renounces every role. **Multisig-bytecode preflight runs first**: refuses if any of the three Safe addresses has zero bytecode on the target chain. Operator must drive `acceptOwnership()` on each OApp via the Safe UI to complete the second leg. |
| `abi-sync` | — | Runs the export scripts: `exportFrontendAbis.sh` + `exportFrontendDeployments.sh` + `exportSubgraphAbis.sh` + `exportTenderlyAlerts.sh` + `exportLzWatcherVars.sh` + (sibling repo present) `exportAbis.sh` for the keeper-bot. |
| `cf-defi` / `cf-www` | — | Build + `wrangler deploy` apps/defi (the dApp) / apps/www (marketing). |
| `cf-keeper` / `cf-indexer` / `cf-agent` | — | wrangler deploy of each Worker. The indexer phase also runs D1 migrations against `vaipakam-archive`. Each verifies the chain-specific `RPC_<CHAIN>` secret is set on the Worker (hard-fail if missing). |
| `verify` | — | Read-only smoke checks: `paused()`, `getTreasury()`, facet count (exact-matches the live `DiamondLoupe.facetAddresses().length` against `addresses.json` `.facetCount` recorded at deploy — fails on any mismatch, not just a low count), master flag state, BuyAdapter rate-limit caps (refuses to mark verify-done if either cap is `type(uint256).max`). |
| `pause-rehearsal` (testnet only) | `--mode {calldata\|check\|unpause-calldata}` | Sub-5-min N-chain simultaneous-pause drill. `--mode calldata` (default) prints `pause()` calldata for the operator to sign through the Pauser Safe UI; `--mode check` reads `paused()` on every contract and reports elapsed wall-clock vs the 300s budget; `--mode unpause-calldata` prints the inverse for cleanup. Refused on mainnet. |

### Flags

`deploy-chain.sh` (testnet one-shot, all flags optional):
- `--skip-defi / --skip-www / --skip-keeper / --skip-indexer / --skip-agent / --skip-cf` — per-app gating for the Cloudflare deploys. `--skip-cf` is the alias for "skip all five".
- `--skip-vpfi` — skip the VPFI lane + Reward OApp.
- `--skip-lz-config` — auto-skipped when `DVN_REQUIRED_1` isn't set.
- `--fresh` — wipe `addresses.json` + step markers (testnet only; auto-archives prior state).
- `--resume` — re-run after partial-fail; skips marker-completed steps.
- `--verify-contracts` — `forge verify-contract --watch` on every deployed contract. Needs `ETHERSCAN_API_KEY`.

`deploy-{testnet,mainnet}.sh`:
- `--phase <phase>` (required) — see the phases table above.
- `--confirm-i-have-multisig-ready` — gates `--phase contracts` and `--phase handover`.
- `--confirm-dvn-policy-reviewed` — gates `--phase lz-config`.
- `--fresh` — opt-in archive + wipe (testnet) or archive + wipe (mainnet — also requires `--confirm-purging-prior-mainnet-deploy`).
- `--mode <mode>` — only for `--phase pause-rehearsal`.

**Artifacts every deploy now writes** (under
`contracts/deployments/<slug>/`):

- `addresses.json` — the canonical "where everything lives" file
  every other tool reads.
- `deployment_source.json` — fresh on every successful deploy:
  ```json
  {
    "chainSlug": "base-sepolia",
    "chainId": 84532,
    "deployedAt": "2026-05-06T10:30:00+0530",
    "monorepoCommit": "<git HEAD sha>[ (dirty)]",
    "deployer": "0x...",
    "diamond": "0x..."
  }
  ```
  Solves "which version is actually live?" — the prior `deployedAt`
  field inside `addresses.json` was stale because the deploy script
  never updated it on redeploy.
- `.markers/<step>.done` — per-step sentinel (testnet) /
  `.markers/phase-<phase>.done` per-phase sentinel (mainnet).
- `.history/post-<step>-<unix-ts>.json` — snapshot of
  `addresses.json` after each major step, for forensic reconstruction
  of mid-flight failures.
- `.history/health-<unix-ts>.log` — sentinel reads (`paused()`,
  `getTreasury()`, `nextOfferId()`, `nextLoanId()`, facet count,
  `getMasterFlags()`, BuyAdapter rate limits) captured by the
  post-deploy health check on every chain.

**What the scripts deliberately do NOT do** (every chain — these stay
manual for safety):

- **Role rotation** to governance multisig + timelock — multi-party
  ceremony, see §6 below.
- **Wrangler secrets** — operator-specific (TG_BOT_TOKEN, RPC API
  keys, push-channel PK, aggregator keys, keeper PK). `wrangler secret
  put <KEY>` per the watcher's docs; never in any repo.
- **Mainnet phases auto-chained** — each `--phase` invocation lands
  one stage so the operator eyeballs the diff before the next.

LayerZero peer wiring is now scripted via `deploy-peers.sh` (above) —
no longer a manual step. Per-chain LZ DVN policy is also inline in
`deploy-chain.sh` step `[5c]` (gated on `DVN_REQUIRED_1` presence).

The sections below remain the canonical step-by-step. The new scripts
just bundle the routine forge-script + export-script + wrangler steps
into reproducible flows; the ceremonies (§6 role rotation, LZ peer
wiring) stay one-by-one.

---

## Mainnet rehearsal — full end-to-end flow

Before mainnet, run the full deployment sequence on testnets that
mirror the mainnet topology. Today's rehearsal target:
**Base Sepolia (canonical) ↔ Arb Sepolia + OP Sepolia (mirrors)**.

### Rehearsal lessons learned (2026-05-06)

These bit us during the multi-chain redeploy and would bite again on
mainnet without preflight discipline:

- **Node version: 20+ required.** The deploy script's step `[7]`
  Frontend build invokes `vite build`; Vite 5.x requires Node 20+. The
  `[8]` watcher deploy invokes `wrangler`; Wrangler 4.x requires Node
  20+. Both fail with cryptic errors under the system's Node 18
  default (`ReferenceError: CustomEvent is not defined` for Vite,
  hard exit for wrangler). The wrapper script propagates exit-0
  even when these inner steps fail — flagged for a follow-up
  patch. Until that lands: source `nvm` and `nvm use 20` (or 25)
  BEFORE running `deploy-chain.sh`. Confirm with `which node && node
  --version` ≥ 20.0.0.
- **`REWARD_VERSION` collision recovery.** Step `[5]` deploys the
  Reward OApp via CREATE2 with a salt derived from `REWARD_VERSION`.
  If the same `(deployer, salt, init code)` tuple ever landed code
  on this chain (a prior rehearsal that completed step `[5]` with the
  same version), the second attempt reverts `Create2DeployFailed
  (CreateCollision)`. Recovery: bump the `REWARD_VERSION` env var
  (e.g. `v1-rehearsal-2026-05-06` → `v2-rehearsal-2026-05-06`), then
  `deploy-chain.sh <slug> --resume` to skip the already-completed
  steps and re-run from `[5]`. The new salt yields a fresh CREATE2
  address.
- **drpc.live throttling on Base Sepolia.** Sustained high-frequency
  reads during forge's broadcast prep phase silently throttle on
  `lb.drpc.live/base-sepolia/...`, causing the deploy to hang for
  30+ minutes at `Estimated total gas used`. Workaround: set
  `BASE_SEPOLIA_RPC_URL=https://base-sepolia-rpc.publicnode.com` for
  the deploy run (export inline before invoking `deploy-chain.sh`).
  publicnode handled the full ~110M gas budget cleanly.
- **`.active-chains` is the inclusion gate.** The export script
  reads `contracts/deployments/.active-chains` to filter which
  per-chain folders fold into the consolidated `deployments.json`.
  Folders for retired chains stay on disk for forensic value but
  stop being crawled by the watcher and stop appearing in the
  frontend's chain picker. NOT auto-updated by deploy scripts —
  adding/removing a chain is a one-line operator edit.
- **CREATE2 OApp address is the same across chains for the same
  `REWARD_VERSION`.** A bumped version on Base only matters for
  Base; the same bumped version on Arb and OP yields a different
  CREATE2 address on each chain only because each chain has its
  own state. If a prior rehearsal landed a Reward OApp at the v1
  salt on multiple chains, ALL of them need the same version bump
  in lockstep — otherwise the cross-chain peer wiring (Reward
  mesh) won't match the deployed addresses.
- **Rate-limit verification gate (Item 1, 2026-05-06).**
  `VPFIBuyAdapter.getRateLimits()` is now a public view. Step `[5d]`
  health check on mirror chains hard-fails the deploy when either
  cap is at `type(uint256).max` — replaces the prior soft-warn that
  let unverified rate limits through.
- **dRPC `eth_estimateGas` stale-view reverts during high-rate
  broadcasts.** `forge script --broadcast --skip-simulation` leans on
  the RPC's `eth_estimateGas` to size each tx's gas before submission.
  dRPC's load-balancer occasionally answers with a slightly-stale
  state snapshot (a few blocks behind the canonical tip), so a tx
  whose pre-conditions JUST landed in the prior tx can revert in the
  estimator with a custom error like `InvalidLoanStatus()` (selector
  `0x8e0f1450`), `ERC20InsufficientAllowance(...)` (`0xfb8f41b2`), or
  `NFTMintFailed()` (`0xb70f4664`) — even though `cast estimate` and
  `cast call` against the same calldata succeed seconds later when
  the RPC catches up. The 2026-05-06 rehearsal hit this three times
  (PositiveFlows OP @ tx 152 `claimAsLender`; PartialFlows OP @ tx 57
  `acceptOffer`; PartialFlows Base @ tx 53 `createOffer`). Mitigation:
  drop `--skip-simulation` from testnet smoke runs — forge then runs
  its own on-chain simulation locally against the live state at
  submission time, bypasses the RPC's stale view, and broadcast
  proceeds clean. Tradeoff is slower per-tx submission (full local
  sim each tx) but reliability wins for smoke-test sweeps. Keep
  `--skip-simulation` only for re-runs where you've confirmed the
  prior sim already passed and you just want to broadcast faster.
  **Anti-pattern — do NOT combine `--no-skip-simulation` with
  `--gas-estimate-multiplier 100`.** The latter removes forge's
  default 30 % safety buffer above its gas estimate. With local
  simulation enabled, the estimate is tight (it doesn't predict
  Base's L1-fee accounting or warm/cold storage transitions on
  chain), so the buffer is what saves the broadcast from
  out-of-gas reverts on edge-case admin setup txs. Today's Base
  PartialFlows v3 hit exactly this: 33,268 gas used against a
  33,350 limit on `setUsdChainlinkDenominator`, only 82 gas of
  slack. Use `--gas-estimate-multiplier 100` only when forge's
  pad is itself the problem (`intrinsic gas too high` rejects at
  submit time on certain RPCs, fixed in v1 → v2 of today's run);
  otherwise leave the multiplier at its 130 % default.
- **Silent watcher chain-skip on missing per-chain RPC secret.**
  `getChainConfigs(env)` (`ops/hf-watcher/src/env.ts:151`) drops any
  chain whose `RPC_<CHAIN>` Cloudflare secret is unset — the
  watcher's round-robin cron then never visits that chain, D1 stays
  empty for its `chain_id`, and the OfferBook / loan tables show
  zero rows for it. The `[8c]` / cf-watcher `[c]` RPC-secret check
  is now hard-fail (was warn-only pre-2026-05-06): the deploy stops
  with a clear setup command if the expected `RPC_<CHAIN>` secret is
  missing on the watcher Worker. **Prerequisite — set ALL per-chain
  RPC secrets before the first deploy targeting that chain** (see
  next section).

### Prerequisites: one-time watcher RPC-secret setup

Per `CLAUDE.md`, RPC URLs carry operator-curated paid-tier API keys
and live ONLY as Cloudflare Worker secrets — never in the repo. Set
once per chain, BEFORE the first `deploy-chain.sh <slug>` (or
`deploy-mainnet.sh --phase cf-watcher`) targeting that chain. The
deploy script's hard-fail check refuses to proceed without them:

```bash
cd ops/hf-watcher

# Testnet trio
echo -n "$BASE_SEPOLIA_RPC_URL" | npx wrangler secret put RPC_BASE_SEPOLIA
echo -n "$ARB_SEPOLIA_RPC_URL"  | npx wrangler secret put RPC_ARB_SEPOLIA
echo -n "$OP_SEPOLIA_RPC_URL"   | npx wrangler secret put RPC_OP_SEPOLIA

# Mainnet (when those phases land)
echo -n "$RPC_ETH"    | npx wrangler secret put RPC_ETH
echo -n "$RPC_BASE"   | npx wrangler secret put RPC_BASE
echo -n "$RPC_ARB"    | npx wrangler secret put RPC_ARB
echo -n "$RPC_OP"     | npx wrangler secret put RPC_OP
echo -n "$RPC_ZKEVM"  | npx wrangler secret put RPC_ZKEVM
echo -n "$RPC_BNB"    | npx wrangler secret put RPC_BNB
```

Verify with `npx wrangler secret list` from inside `ops/hf-watcher` —
each chain you plan to index must show its `RPC_<CHAIN>` entry.
Cloudflare auto-redeploys the Worker on every `secret put` so the
new value takes effect on the next cron tick.

### Auto post-deploy steps performed by the script

`deploy-chain.sh` and `deploy-mainnet.sh phase_cf_watcher` already
perform these AUTOMATICALLY after the contract deploy lands — no
manual follow-up required when the prerequisites are in place:

1. **ABI + deployments sync** (step `[6]` / `phase_abi_sync`) — re-
   exports per-facet ABIs to `frontend/src/contracts/abis/`,
   `ops/hf-watcher/src/abis/`, and (if sibling repo present)
   `vaipakam-keeper-bot/src/abis/`. Regenerates the consolidated
   `deployments.json` for both consumer surfaces with the new
   diamond + facet addresses.
2. **Frontend build + Cloudflare deploy** (step `[7]` /
   `phase_cf_frontend`) — runs `npm run build` then
   `npx wrangler deploy` from `frontend/`. Skip with
   `--skip-frontend` if the build is intentionally lagging.
3. **Watcher Cloudflare deploy** (step `[8a]` / cf-watcher `[a]`) —
   `npx wrangler deploy` from `ops/hf-watcher/`. Pushes the new
   bundle (which now embeds the new diamond addresses) so the cron
   reads from the right contract on the next tick.
4. **D1 migrations** (step `[8b]` / cf-watcher `[b]`) — applies any
   pending schema migrations to the remote `vaipakam-alerts-db`.
   Idempotent — wrangler skips already-applied entries.
5. **RPC-secret presence check** (step `[8c]` / cf-watcher `[c]`) —
   verifies the per-chain `RPC_<CHAIN>` secret exists on the Worker.
   **Hard-fails the deploy if missing** — see prerequisite above.
6. **Indexer-cursor seed** (step `[8d]` / cf-watcher `[d]` —
   `--fresh` only) — INSERTs/UPDATEs the cursor for the deployed
   chain at current safe head so the first cron tick starts indexing
   AT head instead of backfilling an empty pre-deploy block range.

### Post-deploy verification (do this before announcing)

Within ~5 minutes of `deploy-chain.sh <slug>` returning success,
confirm the watcher is actually indexing the new chain:

```bash
# 1. Confirm the cursor is advancing (not just seeded)
cd ops/hf-watcher
npx wrangler d1 execute vaipakam-alerts-db --remote --json --command \
  "SELECT chain_id, last_block, datetime(updated_at,'unixepoch') as updated
     FROM indexer_cursor WHERE kind='diamond' ORDER BY chain_id;" \
  | jq '.[0].results'
# Each chain's `updated` should be within the last ~3 minutes.

# 2. Confirm offers / loans rows materialise for the new chain
#    once smoke-test events have landed on chain.
npx wrangler d1 execute vaipakam-alerts-db --remote --json --command \
  "SELECT chain_id, COUNT(*) FROM offers GROUP BY chain_id;
   SELECT chain_id, COUNT(*) FROM loans  GROUP BY chain_id;" \
  | jq '.[0].results, .[1].results'

# 3. Direct on-chain truth — count events emitted by the diamond
#    in the last ~10k blocks; should match the D1 row counts.
DIAMOND=$(jq -r '.diamond' deployments/<slug>/addresses.json)
OFFER_TOPIC=$(cast keccak "OfferCreated(uint256,address,uint8)")
LOAN_TOPIC=$(cast keccak \
  "LoanInitiated(uint256,uint256,address,address,uint256,uint256)")
cast logs --rpc-url "$RPC" --from-block latest-10000 \
  --address "$DIAMOND" "$OFFER_TOPIC" --json | jq 'length'
cast logs --rpc-url "$RPC" --from-block latest-10000 \
  --address "$DIAMOND" "$LOAN_TOPIC"  --json | jq 'length'
```

Mismatches mean the watcher pass is silently throwing for that
chain. Tail the live Worker logs to inspect:

```bash
cd ops/hf-watcher && npx wrangler tail --format=pretty
```

#### Quick sanity check from the frontend (added 2026-05-07)

The frontend's diagnostics surface now exposes the same signals
without the operator having to drop to a shell. After connecting
the wallet to the deployed chain:

- **Top-bar status pill** — hover the small ⓘ next to the indexer
  status badge. The popover shows `Last safe block (indexed)`,
  `Last safe block (available)`, and `Blocks to catch up` in
  block-space. Green pill + small gap = healthy. Amber/red pill =
  the same condition the cursor query above would show.
- **Diagnostics drawer (LifeBuoy FAB → expand "Chain & Indexer"
  panel)** — same numbers plus `Live-tail status` (In sync /
  Catching up · ~N blocks remaining / Deep backlog), the indexer
  cursor's `updated_at` timestamp, the indexer endpoint URL, and
  a `Next index fetch in: Ns` countdown to the next D1 read. The
  countdown ticking from 30 → 0 confirms the polling loop is
  alive without needing a `wrangler tail`.

These read directly from the same D1 table + chain RPC the shell
queries hit, so they're not a separate source of truth — they're
the same data, surfaced in the UI for operators who'd rather not
context-switch to a terminal during a deploy verification.

### 1. Per-chain deploy (run 3 times)

Each invocation deploys contracts, runs the post-cut facet-count
assertion, applies BuyAdapter rate limits (mirror chains only),
exports ABIs + `deployments.json` to **both** frontend and watcher,
and ships frontend + watcher Cloudflare deploys. The `--fresh`
flag wipes prior state so each rehearsal starts from zero.

```bash
bash contracts/script/deploy-chain.sh base-sepolia --fresh
bash contracts/script/deploy-chain.sh arb-sepolia  --fresh
bash contracts/script/deploy-chain.sh op-sepolia   --fresh
```

The post-deploy health check (step `[5d]`) runs on every chain and
its log is persisted to
`deployments/<slug>/.history/health-<unix-ts>.log` for audit.

### 2. Cross-chain peer wiring (run ONCE after step 1 on all chains)

```bash
bash contracts/script/deploy-peers.sh --dry-run    # eyeball plan
bash contracts/script/deploy-peers.sh              # broadcast
```

Verifies each peer with `cast call <oapp> 'peers(uint32)(bytes32)' <eid>`
afterwards. `setPeer` is idempotent — safe to re-run on partial fail
or to add a new chain to an existing topology.

#### Mixed-authority case: when handover already happened on some chains

`deploy-peers.sh` overrides `PRIVATE_KEY → ADMIN_PRIVATE_KEY` because
`DeployVPFI*` / `DeployRewardOAppCreate2` transfer OApp ownership to
`ADMIN_ADDRESS` at end-of-script. After the multi-party Safe acceptance
ceremony, OApps on chains where the ceremony completed are owned by
the **Safe**, and ADMIN-signed `setPeer` from those chains reverts
`OwnableUnauthorizedAccount`.

When the OApp ownership state differs across chains (typical during a
phased handover), the peer-wiring matrix splits across two authority
contexts:

- **ADMIN-signable legs** (source chain still ADMIN-EOA-owned): broadcast
  via `cast send` with `ADMIN_PRIVATE_KEY`, OR via
  `deploy-peers.sh --only-chains <slug>` if the script can complete its
  ≥2-chains preflight.
- **Safe-signable legs** (source chain owned by the multisig): emit a
  Safe Transaction-Builder JSON listing every `setPeer` with decoded
  `_eid` + `_peer` arguments, then execute via `app.safe.global → Apps
  → Transaction Builder`.

Reference batch files for the 2026-05 testnet rehearsal:
[`docs/ops/safe-batches/peer-wiring-base-sepolia.json`](safe-batches/peer-wiring-base-sepolia.json)
(6 tx) and [`peer-wiring-sepolia.json`](safe-batches/peer-wiring-sepolia.json)
(4 tx). The README in [`docs/ops/safe-batches/`](safe-batches/) covers
the per-batch eyeball-check, Safe UI workflow, and the `cast call`
verify-after-execute step.

**Mainnet shape** assumes full Safe handover happened first, so the
entire 14-leg matrix is Safe-signable — emit one batch JSON per chain
and execute. The auth-mismatch case above only occurs during phased
handovers (e.g. when one chain's Safe SDK lands earlier than another's).

### 3. Smoke tests (positive + partial flow sweeps)

After peers are wired, sanity-check every chain via the
chain-agnostic flow scripts:

```bash
forge script script/PositiveFlows.s.sol --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast --slow
forge script script/PartialFlows.s.sol  --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast --slow
# Repeat for ARB_SEPOLIA_RPC_URL and OP_SEPOLIA_RPC_URL.
```

`PositiveFlows.s.sol` chains together SepoliaPositiveFlows (15
legacy lifecycle scenarios) + AnvilNewPositiveFlows (18
new-features scenarios) for a 33-scenario full-positive sweep.
`PartialFlows.s.sol` does the same shape for 13 partial midpoints.

### 4. Recovery from a mid-flight failure

If a chain's `deploy-chain.sh` died at any step, re-run with
`--resume`:

```bash
bash contracts/script/deploy-chain.sh arb-sepolia --resume
```

`--resume` reads `.markers/<step>.done` files and skips every step
that already landed, restarting at the step that failed. The
diamond + timelock won't be redeployed; the script picks up at
the actual failure point. Use `--fresh` instead if you want to
discard the partial deploy entirely.

### 5. Mid-rehearsal `forge verify-contract`

Add `--verify-contracts` to any rehearsal run to dry-run the
explorer-verification step that mainnet needs:

```bash
bash contracts/script/deploy-chain.sh base-sepolia --fresh --verify-contracts
```

Requires `ETHERSCAN_API_KEY` (or chain-specific equivalent in
`foundry.toml`'s `[etherscan]` block). Failures don't abort the
deploy — they're logged + summarised so the operator can re-verify
manually for any contract that didn't take.

### 6. Mainnet readiness checklist

Once the testnet rehearsal is green, declare readiness only after
each item is checked:

- [ ] All 3 chains' `deploy-chain.sh` finished with `[5d] health
      check` reporting non-default rate limits on mirror BuyAdapters
      (`uint256.max` value = FAIL — the script's mainnet `--phase
      verify` will refuse to ship in this state).
- [ ] `deploy-peers.sh` ran clean (every `setPeer` line shipped, no
      `⚠` lines).
- [ ] `PositiveFlows.s.sol` + `PartialFlows.s.sol` green on every
      chain — capture the broadcast logs in
      `docs/internal/RehearsalReports/<date>/`.
- [ ] `deployment_source.json` on every chain points at the same
      monorepo commit + clean working tree (`monorepoCommit` ends
      WITHOUT ` (dirty)`).
- [ ] Block-explorer source verification ran clean on at least one
      mirror chain (catches any bytecode-vs-source drift before
      mainnet).
- [ ] Frontend visibly hydrates analytics + offer book correctly on
      every chain after the rehearsal.

---

## Adding support for a new chain

Before you can run a single deploy step on a chain, the codebase must
*know* that chain — the per-chain Diamond address, env-var prefix, LZ
endpoint id, and frontend wagmi record. Adding a new chain is **exactly
four code edits**:

1. **`contracts/script/lib/Deployments.sol#chainSlug()`** — add
   `if (cid == X) return "<slug>";`. The slug becomes the
   `deployments/<slug>/addresses.json` directory name.
2. **`contracts/script/lib/Deployments.sol#envPrefix()`** — add
   `if (cid == X) return "<PREFIX>_";`. This is the binding that turns
   `block.chainid == 97` into `vm.envAddress("BNB_TESTNET_DIAMOND_ADDRESS")`
   when the artifact file is missing.
3. **`contracts/script/lib/Deployments.sol#lzEidForChain()`** — add the
   LayerZero V2 endpoint id row (e.g. `if (cid == 97) return 40102;`).
   Every Deploy*OApp* / RewardOApp script stamps this into
   `addresses.json#lzEid` automatically.
4. **`frontend/src/contracts/config.ts`** — add the per-chain record,
   literally spelling out the `VITE_<PREFIX>_*` keys it consumes
   (`rpcUrl`, `diamondAddress`, `deployBlock`,
   `metricsFacetAddress`, `vpfiBuyAdapter`, `vpfiBuyPaymentToken`).
   Each chain's env-var name is hardcoded in its record — there is no
   general "for chainId N read `VITE_<PREFIX>_*`" rule, only the
   per-chain literal.

The `.env`, `.env.local`, `.env.example` files are **just storage** for
the values those four code rows look up. **Without the four code edits,
the env vars are dead text**: setting `BNB_TESTNET_DIAMOND_ADDRESS` in
`.env` does nothing if `Deployments.sol#envPrefix()` doesn't return
`"BNB_TESTNET_"` for chainid 97.

Quick sanity check after the four edits:

```bash
# Solidity side — should not revert and should produce the expected slug
forge script -vv --rpc-url $NEW_CHAIN_RPC_URL \
  --sig 'run()' contracts/script/PrintChainSlug.s.sol  # if you have it,
                                                       # else just attempt
                                                       # any Deploy* in dry-run
                                                       # — chainSlug()/envPrefix()
                                                       # are called in writeChainHeader.

# Frontend side — should compile and the new chainId should appear in the picker
cd frontend && npm run typecheck && npm run dev
```

After those pass, the per-chain runbook (e.g.
[`BaseSepoliaDeploy.md`](./BaseSepoliaDeploy.md),
[`BNBTestnetDeploy.md`](./BNBTestnetDeploy.md)) is the cookbook for the
actual broadcasts.

---

## How addresses get persisted

Every deploy script writes its outputs to a single per-chain artifact at:

```
contracts/deployments/<chain-slug>/addresses.json
```

`<chain-slug>` is fixed per chainId (`base-sepolia` for 84532, `sepolia` for
11155111, `bnb-testnet` for 97, etc. — see `Deployments.sol#chainSlug`).
Every Configure / Wire / Upgrade / Seed / smoke-test script reads from
this file via `Deployments.readDiamond()` etc.; operators no longer need
chain-prefixed env vars to follow each fresh deploy. The file is
committed and is the canonical post-deploy source of truth for both the
contract layer and the frontend env builder.

The schema each script populates (no manual editing needed since the
26 April 2026 enrichment):

| Key | Written by |
|---|---|
| `chainId`, `chainSlug`, `deployedAt`, `deployBlock` | `DeployDiamond` |
| `lzEid`, `lzEndpoint` | `DeployDiamond` (eid) + each OApp deploy script (endpoint) |
| `diamond`, `vaultImpl`, `treasury`, `admin` | `DeployDiamond` |
| `facets.<name>` (×30) | `DeployDiamond` |
| `vpfiToken`, `vpfiTokenImpl`, `vpfiOftAdapter`, `vpfiOftAdapterImpl`, `isCanonicalVPFI=true` | `DeployVPFICanonical` |
| `vpfiMirror`, `vpfiMirrorImpl`, `isCanonicalVPFI=false` | `DeployVPFIMirror` |
| `vpfiBuyReceiver`, `vpfiBuyReceiverImpl` | `DeployVPFIBuyReceiver` |
| `vpfiBuyAdapter`, `vpfiBuyAdapterImpl`, `vpfiBuyReceiverEid`, `vpfiBuyPaymentToken` | `DeployVPFIBuyAdapter` |
| `rewardOApp`, `rewardOAppBootstrapImpl`, `rewardOAppRealImpl`, `rewardLocalEid`, `rewardBaseEid`, `isCanonicalReward` | `DeployRewardOAppCreate2` |
| `rewardOApp` / `rewardLocalEid` / `rewardBaseEid` / `rewardGraceSeconds` / `isCanonicalReward` | `ConfigureRewardReporter` (idempotent overwrite) |
| `vpfiDiscountEthPriceAsset` / `vpfiBuyWeiPerVpfi` / `vpfiBuyGlobalCap` / `vpfiBuyPerWalletCap` / `vpfiBuyEnabled` | `ConfigureVPFIBuy` |
| `interactionLaunchTimestamp`, `interactionCapVpfiPerEth` | `SetInteractionLaunch` |
| `weth`, `mockChainlinkAggregator`, `mockUniswapV3Factory`, `mockERC20A/B`, `mockUSDC/WBTC/WETHFeed` | `DeployTestnetLiquidityMocks` |

Both the frontend and the hf-watcher Worker consume these via a
single consolidated `deployments.json` keyed by `chainId`:

- `frontend/src/contracts/deployments.json` — read by
  [`frontend/src/contracts/deployments.ts`](../../frontend/src/contracts/deployments.ts)
  (`getDeployment(chainId)`) and folded into the
  `CHAIN_REGISTRY` by `frontend/src/contracts/config.ts`.
- `ops/hf-watcher/src/deployments.json` — read by
  [`ops/hf-watcher/src/deployments.ts`](../../ops/hf-watcher/src/deployments.ts)
  and consumed by `getChainConfigs(env)` in `env.ts`.

Both files are byte-identical merges of every per-chain
`addresses.json`. Don't hand-edit either; both are emitted by:

```bash
bash contracts/script/exportFrontendDeployments.sh
```

The script auto-detects both consumers via the sibling layout
(`vaipakam/frontend` and `vaipakam/ops/hf-watcher`), merges every
`deployments/<chain>/addresses.json`, and writes the merged JSON
+ a `_deployments_source.json` provenance stamp into each
target's `src/contracts/` (frontend) / `src/` (watcher). Pass
`WATCHER_DIR=` (empty) to skip the watcher target. Idempotent:
re-running with no upstream changes leaves both outputs
byte-identical.

Run it after every contract redeploy *before*:
- `cd frontend && npm run deploy` (so new addresses inline into
  the JS bundle), AND
- `cd ops/hf-watcher && wrangler deploy` (so the watcher reads
  the new addresses on its next cron tick).

**T-041 — chain-indexer D1 migrations.** Whenever a new migration
file lands under `ops/hf-watcher/migrations/` (e.g. `0006_*.sql`),
apply it to the live D1 database before redeploying the Worker:

```bash
cd ops/hf-watcher
npm run db:migrate     # idempotent — wrangler tracks the high-water mark
npm run deploy
```

The migration step is independent of contract redeploys; you only
need it when the watcher's schema changes. Skipping it leaves the
Worker referencing columns that don't exist and cron ticks fail
with cryptic "no such column" errors in the logs. See
[`ops/hf-watcher/README.md`](../../ops/hf-watcher/README.md)
"Redeploy / migration upgrade path" for the full sequence and
T-041-specific notes on the bootstrap-time backfill behavior.

**T-046 — chain redeploy / mainnet cutover purge.** When you
redeploy the diamond on a chain (testnet iteration) or graduate
from testnet to mainnet, the Worker's cached offer / loan /
activity rows reference the OLD diamond's offer IDs / loan IDs.
Cache and chain disagree until you clear the cache.

Per-chain redeploy (testnet diamond bumped on chain X):

```bash
cd ops/hf-watcher
npm run db:purge-chain -- <chainId>     # interactive y/N preview
# … then redeploy contracts on that chain, then:
npm run deploy
```

Pre-mainnet full nuke (after extensive testnet iteration —
optional but recommended for a clean slate):

```bash
cd ops/hf-watcher
npm run db:purge-all                    # double-confirmation prompt
# … then deploy mainnet contracts, run db:migrate if needed,
#     finally redeploy the Worker:
npm run deploy
```

Both scripts preserve `user_locales` (wallet-scoped language
preference, not chain-scoped). They DELETE rows; they do NOT
DROP TABLE — schema survives intact, no need to re-run
migrations after a purge. See
[`ops/hf-watcher/README.md`](../../ops/hf-watcher/README.md)
"Purge / reset" for the full table list and `FORCE=1` / `LOCAL=1`
env-knob behaviour.

**When NOT to purge:** routine Worker code-only redeploys (no
diamond / contract changes) should NOT trigger a purge — the
cache is still correct against the existing on-chain state.
Purge only when the on-chain state model itself has changed.

What stays operator-side after this consolidation:

- Frontend `.env.local`: per-chain RPC URLs (with API key),
  WalletConnect project ID, default chain ID, log-chunk tuning,
  feature flags, push channel address.
- Watcher `wrangler.jsonc:vars`: `FRONTEND_ORIGIN`,
  `TG_BOT_USERNAME`, `DIAG_*` knobs.
- Watcher Cloudflare secrets (`wrangler secret put …`):
  `RPC_*` URLs (carry API keys), `TG_BOT_TOKEN`,
  `PUSH_CHANNEL_PK`, aggregator API keys, keeper private key.

Caveat for CI: `frontend/.env.local` is gitignored. The
addresses themselves are NOT in `.env.local` anymore, so a CI
build that doesn't have the operator's local file will still get
correct Diamond / facet addresses from the committed
`frontend/src/contracts/deployments.json`. The CI environment
only needs the operator-side values listed above (RPC URLs,
WalletConnect ID, etc.) — set those in the Cloudflare Workers
Builds → Build environment variables panel one-time, then every
push picks them up.

---

## 0. Pre-flight (before broadcasting any tx)

| Check | Command / Source |
|---|---|
| `forge build` passes | `cd contracts && forge build` |
| `forge test` — 100% pass | `cd contracts && forge test` |
| Gas snapshot reviewed (`.gas-snapshot` diff, operator-local) | `forge snapshot --diff` |
| `CLAUDE.md`, `remappings.txt` unchanged since audit | `git status` |
| Release commit tagged | `git tag -s vX.Y.Z && git push --tags` |
| `ADMIN_ADDRESS` env = timelock contract (**not** an EOA on mainnet) | see `AdminKeysAndPause.md` |
| `TREASURY_ADDRESS` env = multisig safe | review on Safe UI |
| `PRIVATE_KEY` deployer is a hot key, revoked post-deploy | see step 6 |
| Target chain RPC matches intended network id | `cast chain-id --rpc-url $RPC` |
| Chainlink feeds for every supported asset are live on target chain | `cast call <feed> "latestRoundData()"` |
| v3-style concentrated-liquidity AMM factory and USDT/USD denominator configured for the chain | see `OracleAdminFacet` setters |

If any check fails → **do not broadcast**.

---

## 1. Diamond deployment

`DeployDiamond.s.sol` uses simple CREATE — the Diamond address is nonce-dependent, so every chain produces a different address. Cross-chain address parity (if ever required) would need a Singleton-Factory CREATE2 variant, which is not shipped in Phase 1.

1. Set envs:
   ```bash
   export ADMIN_ADDRESS=0x...        # timelock for mainnet, EOA only for testnets
   export TREASURY_ADDRESS=0x...     # multisig
   export PRIVATE_KEY=0x...          # hot deployer key (DEPLOYER_ADDRESS)
   export RPC_URL=https://...
   ```
   Phase-1 2-EOA topology: the deployer EOA owns the Diamond during the cut, then the script hands over ERC-173 ownership + all 7 access-control roles to `ADMIN_ADDRESS` and renounces the deployer's roles. Verify post-deploy that the deployer holds zero roles.
2. Dry-run:
   ```bash
   forge script script/DeployDiamond.s.sol:DeployDiamond \
     --rpc-url $RPC_URL --sender $(cast wallet address $PRIVATE_KEY)
   ```
3. Broadcast:
   ```bash
   forge script script/DeployDiamond.s.sol:DeployDiamond \
     --rpc-url $RPC_URL --broadcast --verify
   ```
4. Record the logged addresses in `deployments/<chain>/addresses.json` and populate `<CHAIN>_DIAMOND_ADDRESS` in `contracts/.env`. The frontend + watcher consumer side is one command — `bash contracts/script/exportFrontendDeployments.sh` merges every chain artifact into `frontend/src/contracts/deployments.json` AND `ops/hf-watcher/src/deployments.json`, plus provenance stamps for both. The frontend's `getDeployment(chainId)` and the watcher's `getChainConfigs(env)` both read from the merged JSON. Idempotent.

**Post-step verification:**
- `diamondLoupe.facetAddresses()` returns 30 non-zero facets (DiamondCutFacet + 29 cut in).
- `OwnershipFacet.owner()` == `ADMIN_ADDRESS` (handover complete).
- `AccessControlFacet.hasRole(DEFAULT_ADMIN_ROLE, ADMIN_ADDRESS)` == `true` and the deployer holds zero roles.
- `AdminFacet.getTreasury()` == `TREASURY_ADDRESS`.
- `VaultFactoryFacet.getVaipakamVaultImplementationAddress()` != `0x0`.
- `RewardReporterFacet.getRewardReporterConfig()` returns zeros for `rewardOApp`/`localEid`/`baseEid` — wiring happens in §3.

**Authority-state matrix after the deploy + handover sequence.** Different
chains can land in different ownership states depending on whether the
post-deploy multi-party Safe acceptance ceremony has fully completed.
Verify at the start of any post-deploy admin work:

```bash
# Per-chain Diamond owner + ADMIN_ROLE holder
for slug in base-sepolia arb-sepolia sepolia; do
  diamond=$(jq -r .diamond contracts/deployments/$slug/addresses.json)
  rpc_var=$(echo "$slug" | tr a-z- A-Z_)_RPC_URL
  rpc=${!rpc_var}
  cast call $diamond 'owner()(address)' --rpc-url "$rpc"
  cast call $diamond 'hasRole(bytes32,address)(bool)' \
    $(cast keccak ADMIN_ROLE) <admin-eoa-or-timelock> --rpc-url "$rpc"
done
```

Three states to expect, with a different downstream impact on §2-§5:

- **Pre-handover** (deploy just completed, no acceptOwnership yet) —
  `owner()` returns the deployer EOA. Configure scripts run directly
  via `PRIVATE_KEY` / `ADMIN_PRIVATE_KEY` (whichever the deploy script
  intended).
- **Partial handover** (OApp ownership transferred to the long-lived
  admin EOA but Diamond ownership not yet transferred) —
  `OwnershipFacet.owner()` is the deployer EOA, OApp `owner()` is the
  admin EOA. `setPeer` runs as ADMIN; ConfigureOracle runs as deployer.
- **Full handover** (Diamond + OApps transferred to the multisig +
  Timelock) — `OwnershipFacet.owner()` is the Timelock contract;
  `ADMIN_ROLE` is held only by the Timelock. Every Configure-script
  setter must go through Safe → `Timelock.schedule(...)` → wait
  `minDelay` → `Timelock.execute(...)`. Direct broadcasts revert
  `OwnableUnauthorizedAccount` (owner check) or
  `AccessControlUnauthorizedAccount` (role check).

The 2026-05 testnet rehearsal landed in a heterogeneous state: arb-sepolia
pre-handover-for-Diamond (Safe SDK isn't on Arb Sepolia testnet), while
base-sepolia + sepolia were fully handed over. ConfigureOracle ran
directly on arb-sepolia; base-sepolia + sepolia required Safe → Timelock
proposals. Plan the configure phase against the actual on-chain state,
not the intended end-state.

---

## 2. Oracle / asset wiring

Automated: `script/ConfigureOracle.s.sol` writes the per-chain oracle config from env vars. The `--phase configure` step in `deploy-{testnet,mainnet}.sh` actually invokes [`DiamondConfigSpell.s.sol`](../../contracts/script/DiamondConfigSpell.s.sol) which composes four configures into one operator-action: `ConfigureOracle` → `ConfigureRewardReporter` → `ConfigureVPFIBuy` (canonical chain only — automatically skipped on non-canonical via the spell's chain-branch) → `ConfigureNFTImageURIs`. Single broadcast window, deterministic order, halt-on-first-failure.

**Pre-handover broadcaster requirement.** ConfigureOracle's pre-flight
asserts `vm.addr(ADMIN_PRIVATE_KEY) == OwnershipFacet.owner()` AND
`hasRole(ADMIN_ROLE, broadcaster)`. The script docstring explicitly
labels itself the "pre-handover bootstrap path" — direct broadcasts
work only while the Diamond is owned by an EOA the operator controls
plus that EOA holds `ADMIN_ROLE`. Post-handover, every setter listed
below must be hand-encoded as a `Timelock.schedule(...)` call, batched
into the multisig, executed after `minDelay`. The ConfigureOracle
revert message points operators at this branch when the on-chain
owner doesn't match.

**0x infrastructure on testnets without canonical 0x deployment.** The
`setZeroExProxy` / `setallowanceTarget` setters are strict — they
revert on `address(0)`, so chains where 0x is not deployed (Base
Sepolia + Arb Sepolia at time of writing) need a stand-in. Use the
[`DeployZeroExMock.s.sol`](../../contracts/script/DeployZeroExMock.s.sol)
helper:

```bash
forge script script/DeployZeroExMock.s.sol \
  --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast --slow
# Mock proxy: 0x...                         <-- record this
# Record as BOTH <CHAIN>_ZEROX_PROXY and <CHAIN>_ZEROX_ALLOWANCE_TARGET
```

The mock implements the v1 ExchangeProxy single-contract surface
(allowanceTarget == proxy) so both env vars get the same address. The
script refuses to deploy on production chains (chainId 1/8453/137/10/42161)
via a hardcoded guard — testnet only. For tests to actually execute
swaps against the mock, fund it with output-token balances ahead of
each scenario.

For manual / multisig control, the underlying setters are:

On `OracleAdminFacet`:

1. `setChainlinkRegistry(<feed registry>)` — mainnet only; on testnets `ConfigureOracle` skips the registry and goes straight to per-symbol feeds
2. `setUsdChainlinkDenominator(<USD denominator>)`
3. `setEthChainlinkDenominator(<ETH denominator>)`
4. `setWethContract(<WETH on this chain>)`
5. `setEthUsdFeed(<ETH/USD feed>)`
6. `setStableTokenFeed("USDC" | "USDT" | ..., <feed>)` — once per stable symbol
7. `setSequencerUptimeFeed(<feed>)` — L2s only (Base / Arbitrum / Optimism / Polygon)
8. `setUniswapV3Factory(<v3 factory>)`

T-033 Pyth-as-numeraire-redundancy gate (optional but recommended for Phase 1; zero-config-friendly — gate soft-skips when unset, identical to pre-T-033 behavior). When enabling:

9. `setPythOracle(<Pyth contract address on this chain>)` — published per-chain by Pyth at https://docs.pyth.network/price-feeds/contract-addresses/evm
10. `setPythNumeraireFeedId(<bytes32 feed id>)` — ETH/USD on ETH-native chains; bridged-WETH/USD on BNB / Polygon mainnet. Pyth's price-feed catalog: https://www.pyth.network/developers/price-feed-ids
11. `setPythMaxStalenessSeconds(<seconds>)` — optional; defaults to 300s (5min). Range [60, 3600].
12. `setPythNumeraireMaxDeviationBps(<bps>)` — optional; defaults to 500 (5%). Range [100, 2000] = 1%-20%.
13. `setPythConfidenceMaxBps(<bps>)` — optional; defaults to 100 (1%). Range [50, 500] = 0.5%-5%.

On `AdminFacet`:

14. `setZeroExProxy(<0x ExchangeProxy>)` — legacy backward-compat
    slot. Preserved so any path still calling the original 0x
    `ExchangeProxy` ABI keeps working through the cutover. The
    Phase 7a swap-adapter registry below is the active liquidation
    path on every chain where it's wired.
15. `setallowanceTarget(<0x allowance-target>)` — legacy companion
    to item 14. Same backward-compat lifetime.

### Phase 7a swap-adapter registry — the modern liquidation path

`AdminFacet.addSwapAdapter(...)` registers an `ISwapAdapter` in
the diamond's priority-ordered failover chain. Liquidation
facets walk this chain via `LibSwap.swapWithFailover` and commit
on the first adapter that delivers ≥ `minOutputAmount`.

Recommended seed for every chain that has 4-DEX coverage:

| Slot | Adapter | Construction args |
|---|---|---|
| 0 | `ZeroExAggregatorAdapter` | `(allowanceHolder, settler[])` — see "Aggregator adapter construction" below |
| 1 | `OneInchAggregatorAdapter` | `(aggregationRouterV6)` |
| 2 | `UniV3Adapter` | `(uniswapV3SwapRouter02)` |
| 3 | `BalancerV2Adapter` | `(balancerV2Vault)` (skip on chains where Balancer V2 isn't deployed, e.g. BNB Chain) |

Order is ranked by expected fill quality: 0x and 1inch typically
win on liquid pairs, UniV3 on long-tail single-hop, Balancer on
weighted-pool routes. Operators can re-rank later with
`AdminFacet.reorderSwapAdapters(...)`.

### Aggregator adapter construction — allowanceTarget split

`ZeroExAggregatorAdapter` now takes TWO constructor args (per the
0x v2 / Settler / AllowanceHolder split documented in
`contracts/src/adapters/AggregatorAdapterBase.sol`):

- `allowanceHolder` — pinned per chain. The same canonical
  AllowanceHolder address on every Cancun-fork chain
  (`0x0000000000001fF3684f28c67538d4D072C22734`); a different
  address on Mantle (`0x0000000000005E88410CcDFaDe4a5EfaE4b49562`).
  Source of truth: `0x-settler` repo README.
- `settler[]` — seed allowlist of permitted Settler call
  destinations. 0x rotates Settler addresses per release and
  varies them by route type (taker-submitted, metatransaction,
  intents, bridge), so this seed is ALWAYS time-sensitive.
  Resolve the live set at deploy time by querying the 0x
  deployer at `0x00000000000004533Fe15556B1E086BB1A72cEae`'s
  `ownerOf(...)` for each Settler feature ID, OR by reading
  `transaction.to` from a fresh `/swap/allowance-holder/quote`
  call against each pair the deploy targets.

**Setting allowance on the Settler instead of the AllowanceHolder
is unsafe** — 0x docs are explicit ("potential loss of tokens or
exposure to security risks"). The split-immutable shape of
`AggregatorAdapterBase` makes it structurally impossible to
commit that mistake even if a keeper is compromised, but the
deploy operator must still pin the right allowanceHolder for the
chain — that single arg is immutable post-deploy.

`OneInchAggregatorAdapter` takes one constructor arg
(`aggregationRouterV6`) because 1inch coalesces both roles into
the same address today (`0x111111125421cA6dc452d289314280a0f8842A65`,
identical on every chain we deploy to). The constructor seeds
the singleton allowlist itself.

After construction, transfer ownership of each aggregator adapter
to the per-chain `<CHAIN>_TIMELOCK_ADDRESS` via the Ownable2Step
two-step handoff — the Timelock is what executes the rotation
calls described in the Governance Runbook §"Aggregator Settler
rotation" section.

**Do not skip the swap-adapter registry** on any chain where
HF-based liquidation is enabled — missing adapters force
liquidations to the full-collateral-transfer fallback path.

> **Tunable knobs reference.** Every governance-tunable knob in
> the protocol — including the bounded ranges that even a
> compromised governance multisig cannot push beyond — is
> documented in functional/no-code form at
> [`docs/ops/AdminConfigurableKnobsAndSwitches.md`](AdminConfigurableKnobsAndSwitches.md).
> Auditors should review that doc alongside the runbook.

---

## 3. Reward plumbing (cross-chain)

`RewardReporterFacet` and `RewardAggregatorFacet` are cut in by `DeployDiamond.s.sol` alongside the other 27 facets. The script stops short of wiring the cross-chain config — every field below must be set per chain before the mesh is live.

### 3a. RewardOApp proxy deployment

The RewardOApp proxy must live at the **same address on every chain** so LayerZero peer wiring works with a single bytes32 peer value. Because the real impl's ctor takes the chain-specific LZ endpoint, we use a **bootstrap-proxy pattern**: deploy a chain-agnostic bootstrap impl via CREATE2, deploy an `ERC1967Proxy(bootstrap, "")` via CREATE2, then atomically `upgradeToAndCall` to the real chain-specific impl inside the same broadcast.

Per chain:

```bash
export PRIVATE_KEY=0x...
export REWARD_VERSION=v1            # must match across every chain
export REWARD_OWNER=0x...           # ideally same address on every chain
export DIAMOND_ADDRESS=0x...        # local Vaipakam Diamond (§1)
export IS_CANONICAL_REWARD=true     # "true" on Base, "false" elsewhere
export BASE_EID=0                   # 0 on Base; Base's EID on mirrors
export LZ_ENDPOINT=0x...            # chain-local LZ V2 endpoint
export REPORT_OPTIONS_HEX=0x        # safe to leave empty at init
export BROADCAST_OPTIONS_HEX=0x     # safe to leave empty at init

forge script script/DeployRewardOAppCreate2.s.sol:DeployRewardOAppCreate2 \
  --rpc-url $RPC_URL --broadcast --verify
```

The script prints `RewardOAppProxy (CROSS-CHAIN IDENTICAL)` — the value MUST match byte-for-byte on every chain or `REWARD_VERSION` drifted. The bootstrap impl address also matches everywhere.

> ⚠️ **Never split the bootstrap → upgrade sequence across broadcasts.** The bootstrap's `_authorizeUpgrade` is permissionless — if a proxy is left pointing at the bootstrap impl, any caller can upgrade it to their own code. The script's `upgradeToAndCall` in the same `vm.broadcast` block closes this window atomically.

### 3b. Reward config wiring

On **every** chain:

1. `RewardReporterFacet.setLocalEid(<LZ eid of this chain>)`
2. `RewardReporterFacet.setBaseEid(<LZ eid of Base>)`
3. `RewardReporterFacet.setRewardOApp(<RewardOApp proxy from §3a>)`
4. `RewardReporterFacet.setRewardGraceSeconds(14400)` — 4h default

On **Base only** (the canonical reward chain):

5. `RewardReporterFacet.setIsCanonicalRewardChain(true)`
6. `RewardAggregatorFacet.setExpectedSourceEids([eidA, eidB, ...])` — every reporter chain's eid

On **all other chains** (reporters):

5'. `RewardReporterFacet.setIsCanonicalRewardChain(false)` — explicit, do not rely on default

Then, once per chain:

7. `InteractionRewardsFacet.setInteractionLaunchTimestamp(<unix ts of launch day 00:00 UTC>)`

**Post-step verification:**
- On Base: `getRewardReporterConfig()` returns `isCanonical == true`, `localEid == baseEid`, expected-source-eids list matches intent.
- On every reporter: `getRewardReporterConfig()` returns `isCanonical == false`, `rewardOApp != 0x0`, `baseEid != 0`.
- `getInteractionLaunchTimestamp()` is non-zero on every chain and identical across chains.

---

## 4. VPFI token wiring

1. Canonical chain only: `DeployVPFICanonical.s.sol`
2. All other chains: `DeployVPFIMirror.s.sol`
3. `WireVPFIPeers.s.sol` on every chain (idempotent — can be re-run)
4. Verify `VPFITokenFacet.isCanonicalVPFIChain()` returns the correct boolean on each chain.

---

## 5. Smoke tests (required before announcing)

### 5a. Local Anvil regression sweep (run BEFORE every deploy)

The Anvil sweep exercises every recent feature against a freshly-bootstrapped
diamond on a local Anvil instance. It catches `viaIR` codegen drift, missing
selectors in `DeployDiamond.s.sol`, cross-facet reentrancy bugs, and gate
regressions before any testnet RPC is touched. All three scripts run end-to-end
against the same anvil + bootstrap output and are independently re-runnable.

```bash
# Boot fresh anvil + run the bootstrap diamond deploy:
pkill -f '^anvil'; anvil --chain-id 31337 --host 0.0.0.0 --port 8545 &
sleep 3
ionice -c 2 -n 0 bash contracts/script/anvil-bootstrap.sh

# Common env vars (anvil default keys):
export PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
export ADMIN_PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
export ADMIN_ADDRESS=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
export LENDER_PRIVATE_KEY=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
export LENDER_ADDRESS=0x90F79bf6EB2c4f870365E785982E1f101E93b906
export BORROWER_PRIVATE_KEY=0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a
export BORROWER_ADDRESS=0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65
export NEW_LENDER_PRIVATE_KEY=0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba
export NEW_LENDER_ADDRESS=0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc
export NEW_BORROWER_PRIVATE_KEY=0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e
export NEW_BORROWER_ADDRESS=0x976EA74026E726554dB657fA54763abd0C3a0aa9

cd contracts

# Positive — 18 scenarios end-to-end (matchOffers, range orders, partial
# repay, refinance, preclose option-2/3, recovery, sanctions Tier-1/2,
# keeper auth, VPFI staking + discount + claim, unstake, pause asset/global,
# treasury surface, master-flag dormancy, sellLoanViaBuyOffer):
ionice -c 2 -n 0 forge script script/AnvilNewPositiveFlows.s.sol \
  --rpc-url http://localhost:8545 --broadcast --slow

# Partial — 7 UI-testable midpoint states (offer states, partial repay,
# collateral doubled, keeper enabled, refinance offer posted, stray token,
# dual claimable):
ionice -c 2 -n 0 forge script script/AnvilNewPartialFlows.s.sol \
  --rpc-url http://localhost:8545 --broadcast --slow

# Negative — 9 gate verifications (range bounds, fallback consent, self-
# collateralized offer, zero duration, collateral floor, claim before
# terminal, partial repay opt-out):
ionice -c 2 -n 0 forge script script/AnvilNegativeFlows.s.sol \
  --rpc-url http://localhost:8545 --broadcast --slow
```

Each script must exit `EXIT=0` and log its `*** PASSED ***` banner. Skipped
scenarios with their unit-test pointers are listed at the bottom of each
script's banner — those revert paths live in `forge test` because Anvil
`--broadcast` cannot advance chain time mid-script.

### 5b. Testnet smoke tests (after the Anvil sweep is green)

Run the `Sepolia*` family on the target testnet first, then execute on mainnet forks:

```bash
forge script script/SepoliaPositiveFlows.s.sol --rpc-url $RPC_URL --broadcast
forge script script/SepoliaActiveLoan.s.sol   --rpc-url $RPC_URL --broadcast
```

Manual checks post-smoke:
- At least one `ChainInterestReported` event on Base from the smoke-run chain.
- `RewardAggregatorFacet.isDayReadyToFinalize(day)` progresses through states 2 → 3 → 1 across the grace window.
- One user claim succeeds after `finalizeDay` + `broadcastGlobal` + `onRewardBroadcastReceived`.

### 5c. Chain-agnostic full-flow wrappers (preferred for any chain)

The Sepolia / Anvil-prefixed scripts above were authored chain-by-chain
as features landed; they're kept exactly as-is for historical traceability.
For any new test run on any chain, prefer these three chain-agnostic
entry points instead — each composes the legacy + new halves and runs
them in append order (no merge of state, just one phase after the other):

```bash
# Full positive flow — 33 scenarios (15 legacy + 18 new):
forge script script/PositiveFlows.s.sol --rpc-url $RPC_URL --broadcast --slow

# Full partial flow — 13 UI-testable midpoint states (6 legacy + 7 new):
forge script script/PartialFlows.s.sol  --rpc-url $RPC_URL --broadcast --slow

# Full negative flow — 9 gate verifications:
forge script script/NegativeFlows.s.sol --rpc-url $RPC_URL --broadcast --slow
```

Each wrapper instantiates its child scripts in the script-runner's
own simulation memory and dispatches through their `external run()`
— no extra deploy txns are emitted by the wrapper itself; the visible
on-chain effect is exactly the union of the children's broadcasts in
order. Both halves of each composition already use `Deployments.lib`
for the diamond address and the standard env-var topology
(`PRIVATE_KEY`, `ADMIN_*`, `LENDER_*`, `BORROWER_*`, `NEW_LENDER_*`,
`NEW_BORROWER_*`), so the wrappers inherit chain-agnosticism with
no further configuration.

When to use which:
- **Full sweep on a new chain** → use the `*Flows.s.sol` wrappers
  (this section). One forge invocation per flow type instead of two.
- **Re-run a specific subset** (e.g. just the new-features positive
  scenarios) → invoke the underlying script directly
  (`AnvilNewPositiveFlows.s.sol`, etc.). Useful when iterating on a
  single feature surface.
- **Anvil regression sweep** → keep using the per-script form in 5a;
  the Anvil bootstrap leaves the chain in a known state that maps
  one-to-one to each underlying script's expectations.

---

## 6. Key rotation (within 24h of deploy)

1. From timelock: `AccessControlFacet.grantRole(DEFAULT_ADMIN_ROLE, <production multisig>)`
2. `AccessControlFacet.grantRole(ADMIN_ROLE, <timelock>)`
3. `AccessControlFacet.grantRole(PAUSER_ROLE, <pauser multisig — separate from admin multisig>)`
4. From the deployer hot key: `AccessControlFacet.renounceRole(DEFAULT_ADMIN_ROLE, <deployer>)` then every other role the deployer was granted in `initializeAccessControl`.
5. Verify via `hasRole` that the deployer holds **no roles** on the Diamond.

See `AdminKeysAndPause.md` for the full role map and the Timelock + Multisig topology.

---

## 7. Publish

- Tag `vX.Y.Z-deployed-<chain>` on the commit actually deployed.
- Commit `deployments/<chain>/addresses.json`.
- Post the diamond address + facet addresses to the public status page.
- File an entry in `docs/ops/IncidentRunbook.md#deployment-log`.

---

## 7.5. Sync ABIs to dependent repos / bundles

Any contract change in this deploy that touches a public selector or
struct shape needs the dependent ABI bundles regenerated, otherwise
they encode calldata against stale shapes. **Three** consumers,
all sourced via `forge inspect` from the compiled bytecode (single
source of truth — no hand-typed ABI tuples anywhere):

```bash
forge build   # if not already built since the last edit

# (a) Frontend — full Diamond surface (~27 facets). Run on every
#     facet-touching deploy.
bash contracts/script/exportFrontendAbis.sh
cd frontend && node_modules/.bin/tsc -b --noEmit && cd ..
git diff frontend/src/contracts/abis/
git commit -am 'Sync frontend ABIs with contracts@<hash>'

# (b) hf-watcher Cloudflare Worker — narrow surface
#     (OfferCancelFacet, LoanFacet) for `getOfferDetails` /
#     `getLoanDetails` decoding. Was previously a hand-typed `as
#     const` tuple in `ops/hf-watcher/src/diamondAbi.ts` — drifted
#     when `LibVaipakam.Offer` gained `periodicInterestCadence`,
#     produced the OfferBook display bug captured in
#     ReleaseNotes-2026-05-05.md "Watcher offer-decode drift".
#     Auto-export landed alongside the fix; run on every facet
#     edit that touches OfferCancelFacet / LoanFacet structs.
bash contracts/script/exportWatcherAbis.sh
cd ops/hf-watcher && npx tsc -p . --noEmit && cd ../..
git diff ops/hf-watcher/src/abis/
git commit -am 'Sync watcher ABIs with contracts@<hash>'

# (c) Public keeper-bot — narrow surface (Metrics / Risk / Loan).
#     Skip if the deploy didn't touch those selectors.
KEEPER_BOT_DIR=../../vaipakam-keeper-bot \
  bash contracts/script/exportAbis.sh
cd ../../vaipakam-keeper-bot
git diff src/abis/ && npm run typecheck
git commit -am 'Sync ABIs with vaipakam@<hash>' && git push
```

Why all three:

- **Missed frontend sync** surfaces as a generic
  `"exceeds max transaction gas limit"` revert during
  `eth_estimateGas` on Base public RPCs (the calldata is one word
  too long; the RPC strips the real revert reason).
- **Missed watcher sync** silently misaligns the worker's
  positional decoder by N slots. Symptom seen on 2026-05-05: the
  OfferBook rendered offers with `5×10²⁹ ETH` principals,
  `10⁷%` rates, and `5×10¹⁸ days` durations because the worker
  was reading `lendingAsset` from the byte position where a newly-
  added enum field actually lives. Cron-tick auto-refresh in the
  worker heals D1 within 5 minutes of redeploy once the ABI is
  fixed — but only IF you redeploy the worker; the Cloudflare
  build doesn't re-fetch ABIs.
- **Missed keeper sync** ships a public bot with
  `"function selector not found"` failures in production.

`deploy-chain.sh` phase 6 and `deploy-mainnet.sh phase_abi_sync`
both invoke (a), (b), and (c) automatically — manual run is only
needed when re-syncing without a full deploy. Per-chain runbooks
(`BaseSepoliaDeploy.md` §13–14, `BNBTestnetDeploy.md`, etc.)
inherit this step from here — don't duplicate the long form
there, just point back.

**Local anvil playground** — `contracts/script/anvil-bootstrap.sh`
ships with this same sync wired in as its final step (6/6) so a
`bash anvil-bootstrap.sh` lands a fresh diamond, etches Multicall3,
flips Range Orders flags on, seeds offers, AND regenerates
`frontend/src/contracts/abis/`, `ops/hf-watcher/src/abis/`,
`frontend/src/contracts/deployments.json`,
`ops/hf-watcher/src/deployments.json`, and (when the sibling repo is
present) `vaipakam-keeper-bot/src/abis/` — all in one command. The
keeper-bot export is gated on `../../vaipakam-keeper-bot` existing
so a contributor without that checkout still gets a clean run. For
the production deploy path the sync stays manual on purpose so the
operator can review each diff before committing.

**Token-icon URL template** (`VITE_TOKEN_ICON_URL_TEMPLATE`) — not
a deploy artefact; lives in `frontend/.env.local` like the RPC URLs
and feature flags. Default points at the Trust Wallet CDN
(`assets-cdn.trustwallet.com`); override to the GitHub raw repo or
a self-hosted registry per the commented examples in
`frontend/.env.example`. Any change requires a frontend rebuild +
Cloudflare deploy to take effect — same as flipping any other
`VITE_*` flag.

---

## VPFIBuyAdapter — payment-token mode (per-chain MANDATORY config)

The mirror-chain VPFIBuyAdapter pulls the buyer's funds locally and
forwards a BUY_REQUEST via LayerZero to the canonical Base receiver,
which mints + sends VPFI. The receiver quotes a single global
**wei-per-VPFI rate denominated in ETH-equivalent value**. That makes
the adapter's `paymentToken` a per-chain economic gate, not a free
choice:

| Chain (mainnet)        | chainId | Mode                | Required env var                  | Canonical bridged WETH9                       |
|------------------------|--------:|---------------------|-----------------------------------|-----------------------------------------------|
| Ethereum               |       1 | Native-gas (ETH)    | (leave unset)                     | n/a                                           |
| Base                   |    8453 | Canonical receiver  | n/a — buys hit Diamond directly   | n/a                                           |
| Arbitrum One           |   42161 | Native-gas (ETH)    | (leave unset)                     | n/a                                           |
| Optimism               |      10 | Native-gas (ETH)    | (leave unset)                     | n/a                                           |
| Polygon zkEVM          |    1101 | Native-gas (ETH)    | (leave unset)                     | n/a                                           |
| **BNB Smart Chain**    |    **56** | **WETH-pull (REQUIRED)** | `BNB_VPFI_BUY_PAYMENT_TOKEN` | `0x2170Ed0880ac9A755fd29B2688956BD959F933F8` |
| **Polygon PoS**        |   **137** | **WETH-pull (REQUIRED)** | `POLYGON_VPFI_BUY_PAYMENT_TOKEN` | `0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619` |

**Why mainnet BNB / Polygon need WETH-pull mode:** native-gas mode
on these chains would mean the user pays 1 BNB / 1 POL where the
receiver expects 1 ETH worth of value. Every buy mis-prices vs. the
global rate. The bridged WETH9 ERC20 fixes this — buyer holds and
approves WETH; the adapter pulls the ETH-denominated `amountIn`
unchanged.

**Two-layer enforcement (don't disable, don't paper over):**

1. **Deploy-script pre-flight (`DeployVPFIBuyAdapter.s.sol`)** —
   `_chainRequiresWethPaymentToken(chainId)` is `true` for chainIds
   56 and 137. The script reverts before broadcasting if the
   resolved `paymentToken` is zero on those chains, with an error
   message naming the env var the operator should set.
2. **Contract-side validation (`VPFIBuyAdapter.initialize`,
   `setPaymentToken`)** — when `paymentToken != address(0)`, the
   adapter requires `code.length > 0` (real contract, not EOA) AND
   `IERC20Metadata(token).decimals() == 18` (canonical WETH9
   invariant; catches the most common honest-mistake misconfig of
   pasting USDC's 6-dec address). New errors:
   `PaymentTokenNotContract`, `PaymentTokenDecimalsNot18`,
   `PaymentTokenDecimalsCallFailed`.

**What's NOT enforced on-chain — the operational check.** There's
no on-chain registry that says "this is *the canonical* bridged
WETH9 on chain X." A determined operator (or an attacker at deploy
time) could deploy a fake contract returning the right decimals.
Defence is operational: the deploy script logs the configured
token's `name()` / `symbol()` for human-eyeball confirmation
against the addresses in the table above. Always cross-check
against the chain's published bridge contracts list (BscScan +
LayerZero registry for BNB; PolygonScan + Polygon bridge contracts
for Polygon) before pasting.

**Pre-flight checklist before broadcasting `DeployVPFIBuyAdapter`
on BNB / Polygon mainnet:**

- [ ] Set `BNB_VPFI_BUY_PAYMENT_TOKEN` (or
      `POLYGON_VPFI_BUY_PAYMENT_TOKEN`) in `contracts/.env` to the
      canonical bridged WETH9 address from the table above.
- [ ] Visually confirm the address on BscScan / PolygonScan —
      contract verified, deployer is the chain's canonical bridge
      operator, NOT a recently-deployed proxy or a contract from an
      unknown EOA.
- [ ] Confirm `decimals()` returns 18 (block-explorer "Read
      Contract" tab — one click). If it returns anything else, the
      env var points at the wrong contract; do NOT proceed.
- [ ] Run the dry-run (`forge script ... --rpc-url`) without
      `--broadcast` first; the deploy script's logs print the
      resolved `paymentToken` address before it would broadcast.
      Eyeball-compare to the table above one more time.

**Testnet exemption.** BNB Smart Chain Testnet (chainId 97) and
Polygon Amoy (chainId 80002) are intentionally NOT in the strict
WETH-pull list. Their gas tokens have no real value and the
testnet rate is symbolic, so native-gas mode is acceptable for
dev-loop convenience. Mainnet equivalents must use WETH-pull —
the deploy-script pre-flight will refuse to proceed otherwise.

---

## Chain-specific quirks

### BNB Smart Chain Testnet (chainId 97, eid 40102)

- **Do not pass `--slow` to `forge script` on this chain.** Alchemy's
  BNB Testnet endpoint stalls indefinitely on `eth_getTransactionReceipt`
  polling under `--slow`, causing `forge` to hang post-broadcast even
  when the txs landed. We hit a 1h hang with zero receipts confirmed
  during the first §2 mocks deploy. Use `--legacy` instead:
  ```bash
  forge script script/<Name>.s.sol:<Name> \
    --rpc-url $BNB_TESTNET_RPC_URL --broadcast --legacy -vv
  ```
  `--legacy` sends pre-EIP-1559 txs at the gas-price returned by
  `eth_gasPrice` (1 gwei on BNB Testnet at this writing) and Foundry
  resumes its post-broadcast bookkeeping immediately. The deploy then
  takes ~30s instead of timing out.
- **Wrapped-native is WBNB, not WETH.** `DeployTestnetLiquidityMocks`
  wires `OracleAdminFacet.setWethContract(...)` to the canonical
  V3-fork DEX WBNB at `0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd`.
  The Diamond's price-asset machinery doesn't care about the symbol —
  only that a Chainlink-backed feed exists and the v3-style depth
  check resolves to a non-zero pool.
- **Buy adapter pays in tBNB**, not tETH. The script writes
  `vpfiBuyPaymentToken = 0x0` (native-gas mode); the canonical Base
  receiver still quotes the rate in wei-per-VPFI on its side, so the
  user pays whatever the local chain's native asset is.
  **Mainnet equivalent (chainId 56) requires WETH-pull mode** — see
  the "VPFIBuyAdapter — payment-token mode" section above for the
  canonical bridged-WETH9 address and the deploy-script pre-flight
  that gates this. The testnet's native-gas mode is a deliberate
  exemption for dev-loop convenience; production deploys must
  flip to WETH-pull.
- **Funding floor**: the §1 Diamond cut + §2 mocks + §3-§6 contract
  deploys cost ~0.13 tBNB at 1 gwei. Have ≥0.3 tBNB on the deployer
  EOA before starting; admin EOA needs ≥0.05 tBNB for handover +
  config + peer-wire txs.

---

## 8. Off-chain alert watcher (one-time, not per-chain)

The HF alert watcher at `ops/hf-watcher/` runs as a Cloudflare Worker
and is shared across every supported chain — it polls each Diamond on
a 5-minute cron and dispatches per-user threshold notifications via
Telegram + Push Protocol. This section is one-time setup and does
**not** repeat per-chain deploy.

### 8a. Telegram bot

1. Create the bot via [`@BotFather`](https://t.me/BotFather) with `/newbot`.
   Use the handle `@VaipakamBot` for production. BotFather hands back
   the bot's API token on creation — this is the only time it appears
   in plaintext.
2. Set worker secrets / vars:
   ```bash
   cd ops/hf-watcher
   npx wrangler secret put TG_BOT_TOKEN          # paste BotFather token
   ```
   `TG_BOT_USERNAME` is committed in `wrangler.jsonc` as a public var.
3. Register the webhook so Telegram pushes inbound DMs into the worker:
   ```bash
   curl "https://api.telegram.org/bot<TG_BOT_TOKEN>/setWebhook" \
        --data-urlencode "url=https://api.vaipakam.com/tg/webhook"
   ```
   Verify with `getWebhookInfo`.

### 8b. Push Protocol channel

1. **One-time channel creation.** Connect a fresh dedicated EOA at
   <https://app.push.org/>, fund it with 50 PUSH (the staking deposit;
   refundable on channel deletion), and create the Vaipakam channel
   with name + description + icon + website.
2. **Production channel address** (do not change without rotating):
   - **`0x6F5847A0CA1F2cB1bbEf944124cE5995988a1D6b`**
   - Public URL: <https://app.push.org/channels/0x6F5847A0CA1F2cB1bbEf944124cE5995988a1D6b>
   - End-user subscribe deep-link rendered on the Alerts page goes to
     the same URL via the `VITE_PUSH_CHANNEL_ADDRESS` env var.
3. **Channel signer privkey → worker secret.**
   ```bash
   npx wrangler secret put PUSH_CHANNEL_PK       # paste 0x-prefixed 64-hex
   ```
   The private key is **never** committed and never appears in
   `wrangler.jsonc`. The channel-owner wallet should hold only the
   staking deposit + ~$50 of native gas — nothing else of value.
4. **Frontend env.** Set on every frontend deploy:
   ```
   VITE_PUSH_CHANNEL_ADDRESS=0x6F5847A0CA1F2cB1bbEf944124cE5995988a1D6b
   VITE_API_ORIGIN=https://api.vaipakam.com
   ```
   Without these, the Alerts page falls closed gracefully; with them,
   the "Subscribe on Push →" deep link and the Push rail enable
   button both render correctly.

### 8c. Smoke test the watcher

```bash
cd ops/hf-watcher
npx wrangler tail        # tail logs in another terminal

# From a test wallet:
#   1. Subscribe to the Push channel at the URL in 8b.2
#   2. /app/alerts → Save thresholds, Link Telegram, Enable Push rail
#   3. Lower one threshold below the connected wallet's HF
#   4. Wait for the next 5-min cron tick
# Expect: log lines for `tg send` + Push API success on band crossings.
```

A `[push] send failed …` line means either `PUSH_CHANNEL_PK` is
wrong format or the channel hasn't cleared the post-stake delay
(~10 blocks after channel-create tx on mainnet). Re-stake confirmations
take a few minutes; nothing else to do.

### 8d. Server-side error capture

The hf-watcher Worker also serves `POST /diag/record` — the
frontend fires-and-forgets one POST per UI failure event so
support has a server-side audit trail (UUID embedded in any
GitHub-issue prefill cross-references back to a real session).
Lives on the same Worker and the same D1 binding as §8a/§8b
above; no separate deploy.

**One-time setup (per environment)**:

1. Apply the new migration to the production database:
   ```bash
   cd ops/hf-watcher
   npx wrangler d1 migrations apply vaipakam-alerts-db --remote
   ```
   This creates the `diag_errors` table + indexes. Idempotent
   (uses `CREATE TABLE IF NOT EXISTS`).

2. Deploy the worker (same command as §8b — pushes the new
   `/diag/record` route + the per-IP rate-limit binding):
   ```bash
   npx wrangler deploy
   ```

3. Smoke test the endpoint:
   ```bash
   # From a shell on a host the FRONTEND_ORIGIN allows (or via
   # `curl --resolve` to bypass DNS):
   curl -X POST https://api.vaipakam.com/diag/record \
     -H 'origin: https://vaipakam.com' \
     -H 'content-type: application/json' \
     -d '{
       "id":"123e4567-e89b-42d3-a456-426614174000",
       "client_at":'"$(date +%s)"',
       "area":"smoke-test",
       "flow":"runbook-8d"
     }'
   # Expect: {"recorded":true,"id":"123e4567-…"}
   ```

   Then verify the row landed:
   ```bash
   npx wrangler d1 execute vaipakam-alerts-db --remote \
     --command "SELECT id, area, flow, recorded_at FROM diag_errors ORDER BY recorded_at DESC LIMIT 1"
   ```

**Tunable knobs** (all in `ops/hf-watcher/wrangler.jsonc`,
override per-environment via `wrangler vars` or the dashboard):

| Var | Default | What it does |
|---|---|---|
| `DIAG_SAMPLE_RATE` | `1.0` | Random write sampling. Drop to `0.1` to write 10% when error volume spikes. |
| `DIAG_RETENTION_DAYS` | `90` | Cron-driven prune deletes rows older than this. Bumped on every 5-min tick. |
| `DIAG_RECORD_RATELIMIT.simple.limit` / `period` | `60 / 60` | Per-IP rate limit. Tune in the `unsafe.bindings` block. |

**Frontend coupling**:

The frontend reads `VITE_API_ORIGIN` (already set —
same origin as the Alerts page uses). No new frontend env var
is required for capture itself; the optional
`VITE_APP_VERSION` (CI-injected commit hash) gets stamped on
each captured row for release-correlation.

A second frontend var, `VITE_DIAG_DRAWER_ENABLED` (default
`true`), gates the user-facing Diagnostics drawer + FAB. Set
to `"false"` once server capture is observed healthy in
production to hide the drawer entirely — server capture
keeps running regardless. The user can still grab their
session journey log from the Data Rights page when the
drawer is hidden.

**GitHub-issue cross-reference workflow** (support team):

When a user files a GitHub issue using the prefill, the body
contains `**Report ID:** \`<UUID>\``. Look it up:

```bash
cd ops/hf-watcher
npx wrangler d1 execute vaipakam-alerts-db --remote \
  --command "SELECT * FROM diag_errors WHERE id = '<UUID>'"
```

If the row exists with a matching error fingerprint, the
report came from a real session. If not, the user fabricated
or altered the UUID — the surrounding error metadata in their
issue body is unverified.

**Privacy note**: the `diag_errors` table stores only what
the existing GitHub-issue prefill already publishes (redacted
wallet `0x…abcd`, error metadata, locale, viewport). No
user-agent, no full address, no localStorage / cookies / free-form
text. The Privacy Policy on the website carries one paragraph
describing this; keep them in sync if you change the schema.

---

## 9. LayerZero security watcher (one-time, not per-chain)

The `ops/lz-watcher` Cloudflare Worker is **separate from** the
hf-watcher in §8. It is internal-only — it has no public HTTP
surface, no fetch handler, no user-facing notification rails.
Its single job is detection + alert into a private ops Telegram
channel for three LayerZero security drift conditions:

- **DVN-set drift** (every `(chain × OApp × peer eid × send/receive)`
  pair must keep `requiredDVNCount=3`, `optionalDVNCount=2`,
  `optionalDVNThreshold=1`).
- **OFT mint/burn imbalance** (Base-locked VPFI must equal sum
  of mirror supplies — exact, by construction).
- **Oversized single-tx VPFI flow** (any `Transfer` event with
  `value > FLOW_THRESHOLD_VPFI`, default 100,000 VPFI).

The split from hf-watcher is deliberate: hf-watcher doubles as
a competitive autonomous keeper that any operator can clone via
the sibling `vaipakam-keeper-bot` repo (Phase 9.A) and run from
their own infrastructure. Co-locating internal security ops on
that same Worker would conflate two adversarial postures and
risk leaking incident state to the public surface. lz-watcher's
incident-response procedures live in `IncidentRunbook.md` §5.

### 9a. D1 database

```bash
cd ops/lz-watcher
npm install
npx wrangler d1 create vaipakam-lz-alerts-db
```

Wrangler prints the new database id. Paste it into
`wrangler.jsonc`'s `d1_databases[0].database_id` (replacing the
`REPLACE_AFTER_d1_create` placeholder).

Apply the schema migration (creates `lz_alert_state`,
`scan_cursor`, `oft_balance_history`):

```bash
npm run db:migrate
```

### 9b. Per-chain RPC keys

Use Alchemy / QuickNode / Infura — public RPCs (publicnode,
sepolia.base.org, polygon-rpc) rate-limit `eth_getLogs`
aggressively and the flow scanner will silently throttle into
uselessness. One key per chain in scope:

```bash
npx wrangler secret put RPC_BASE
npx wrangler secret put RPC_ETH
npx wrangler secret put RPC_ARB
npx wrangler secret put RPC_OP
npx wrangler secret put RPC_ZKEVM
npx wrangler secret put RPC_BNB
```

Skip any chain that's not yet live — the watcher silently
skips chains with empty RPC and the corresponding alerts are
not generated for that chain.

### 9c. Telegram bot — reuse vs. fresh

The Telegram bot token can be **reused** from hf-watcher
(`@VaipakamBot`) — chat IDs alone don't grant posting access
without the token, so a single bot serving two chats is fine.
What MUST be different is the destination chat: the ops
channel for lz-watcher is internal-only and must not be the
same chat as the user-facing alert handle.

```bash
npx wrangler secret put TG_BOT_TOKEN   # paste @VaipakamBot's token (same as hf-watcher)
```

Then add `@VaipakamBot` to the internal ops Telegram channel,
send any message in the channel, and read the chat id via:

```bash
curl "https://api.telegram.org/bot<TG_BOT_TOKEN>/getUpdates" | jq '.result[].message.chat.id'
```

The chat id is a negative integer for channels and groups. Set
it as a public var in `wrangler.jsonc`'s `vars` block:

```jsonc
"TG_OPS_CHAT_ID": "-1001234567890"
```

Not a secret — chat ids alone don't authorize posting.

If the security team prefers a separate bot identity for ops
channels (so a future hf-watcher token compromise can't post to
ops, and vice versa), create a fresh bot via @BotFather and
keep the two `TG_BOT_TOKEN` secrets distinct between Workers.

### 9d. LZ inventory (vars)

Edit `ops/lz-watcher/wrangler.jsonc`'s `vars` block — paste, per
chain, the LZ V2 endpoint address, the ULN302 send + receive
library addresses, and every Vaipakam OApp deployed on that
chain. Optional vars: `VPFI_TOKEN_BASE` (only needed for the
OFT-imbalance check), `FLOW_THRESHOLD_VPFI` (default 100,000
VPFI in base units = `100000000000000000000000`).

Empty values are OK — the watcher silently skips chains /
OApps with empty addresses, useful while bringing the mesh up
incrementally.

### 9e. Deploy

```bash
npm run deploy
```

The cron `*/5 * * * *` is wired in `wrangler.jsonc`. First tick
fires within 5 minutes.

### 9f. Smoke test

```bash
npx wrangler tail   # in another terminal
```

Empty cron ticks log `[lz-watcher] tick clean — no alerts`. To
verify the alert path end-to-end without engineering a real
drift, drop the threshold for the flow detector to a value
below current daily VPFI volume:

```bash
# In wrangler.jsonc temporarily:
"FLOW_THRESHOLD_VPFI": "1"
```

Redeploy. Within 5 minutes a Telegram alert should land in the
ops channel for any recent VPFI Transfer event. Restore the
production threshold and redeploy.

To verify the dedup path: keep the bad threshold in place
across two cron ticks. Only the first tick should produce a
fresh alert; subsequent ticks should log without delivering.

### 9g. Free-tier sizing

| Limit | Free tier | This Worker |
|---|---|---|
| Requests / day | 100,000 | 1,440 (5-min cron) — 1.4 % |
| CPU time / invocation | 10 ms | idle ≈ 2 ms; per-alert ≈ 3 ms |
| Subrequests / invocation | 50 | 18-25 steady state, more on backfill ticks |
| D1 storage / writes | 5 GB / 50K writes/day | ~10 writes/day |

If volume grows past those budgets (Phase 2 traffic, sub-minute
polling needs), upgrade to Workers Standard ($5/mo) for 1000
subrequests + 30 s CPU. No per-cron-tick code changes needed.

### 9h. When to redeploy

This Worker only redeploys when:
- New chain comes online → new RPC secret + new `vars` block.
- New OApp deployed → new `vars` entry.
- Threshold tuning (`FLOW_THRESHOLD_VPFI`).
- Incident-driven changes to the alert surface.

It does **not** need a redeploy when contract code changes —
the ABIs it uses are LZ V2 standard surface (`endpoint.getConfig`,
`oapp.peers`, ERC20 `Transfer` / `balanceOf` / `totalSupply`),
not Vaipakam Diamond selectors.


---

## Appendix: 2026-05-10 testnet rehearsal record (F1 / F2 / F3)

The deploy-script modernization was validated by three end-to-end
rehearsals on three chains with three distinct topologies. Each
rehearsal caught real bugs the static analysis hadn't surfaced;
those fixes are described in chronological order in
[ReleaseNotes-2026-05-10.md](../ReleaseNotes/ReleaseNotes-2026-05-10.md).

### F1 — base-sepolia (canonical)

| Item | Value |
|---|---|
| Diamond | `0x804Bc3E9625548e50c1B589b25111783A632D964` |
| Timelock | `0xcdDA70ebd44b4B44635847e2f1cAD232f7aB3216` |
| vpfiToken | `0x75e60702fe3dD4F107596d1da28e89B88982E82a` |
| vpfiOftAdapter (canonical) | `0xdF7e6DA4a4e93e3646810C364d3E03150E1e6755` |
| vpfiBuyReceiver (canonical) | `0x61c817e24Ad6614C1FAaeC60d81354ED3d76036D` |
| rewardOApp | `0xB112C8b7832Ca3b3A8f1D586188424d72B79bDf9` |
| REWARD_VERSION | `v3-rehearsal-2026-05-10` |
| Phases landed | preflight, contracts (`--fresh`), handover, abi-sync, verify |
| Multi-sig ceremony | 3 OApps `acceptOwnership()` ✓ |
| Exit gate | `DeployerZeroRolesTest` 10/10 ✓ (Base Sepolia fork) |

### F2 — arb-sepolia (mirror, no Safe support yet)

| Item | Value |
|---|---|
| Diamond | `0x17Fe0D808F8971D7A14994a1205ee6AFd949Be91` |
| Timelock | `0x4805D6EbdCc98201e781Dd8e61d6D2e97c107633` |
| vpfiToken / vpfiMirror (mirror) | `0x2f4E10F00bB7f8A5fEDB0b1EB171bb6dfEAF1246` |
| vpfiBuyAdapter (mirror) | `0x90De6FF19aCe6833fE7EB57111DE149Ec55abc93` |
| rewardOApp | `0xB112C8b7832Ca3b3A8f1D586188424d72B79bDf9` |
| REWARD_VERSION | `v3-rehearsal-2026-05-10` |
| Phases landed | preflight, contracts (`--fresh`), mocks, abi-sync, verify, **handover deliberately skipped** |
| Flow tests | PositiveFlows (33 scenarios, 351 txs) + PartialFlows (13 midpoints, 143 txs) — same broadcast volume as Anvil + base-sepolia |
| Handover gap | Safe singletons not deployed at the deterministic CREATE2 addresses on Arb Sepolia (Safe UI doesn't support that testnet). Multisig-bytecode preflight refused; operator must Safe-SDK deploy first. |

### F3 — sepolia (mirror, full pipeline)

| Item | Value |
|---|---|
| Diamond | `0xD2903cbb8Bb0f34fbb688a6E381Dc6c73056DB1c` |
| Timelock | `0xA7b4c9b4083A6E344cb63af017FF0259DEF1cd48` |
| vpfiToken / vpfiMirror (mirror) | `0x1C837b53553D4134B00f474E04C904062CA69341` |
| vpfiBuyAdapter (mirror) | `0x17d34C77f7c93De0514a1904AaDe3A6C5d579f27` |
| rewardOApp | `0xB112C8b7832Ca3b3A8f1D586188424d72B79bDf9` |
| REWARD_VERSION | `v3-rehearsal-2026-05-10` |
| Phases landed | preflight, contracts (`--fresh`), mocks, handover, abi-sync, verify |
| Multi-sig ceremony | 3 OApps `acceptOwnership()` ✓ |
| Exit gate | `DeployerZeroRolesTest` 10/10 ✓ (Sepolia fork) |

### Cross-chain CREATE2 parity — confirmed

The Reward OApp landed at the **same address**
`0xB112C8b7832Ca3b3A8f1D586188424d72B79bDf9` on all three
rehearsal chains. This is the property `LibCreate2Deploy.protocolSalt(version, "RewardOAppProxy")`
is supposed to deliver: the proxy bytecode hash + salt
combination is identical across chains, so the deterministic
CREATE2 address is too. Cross-chain `setPeer` wiring (via
`WireVPFIPeers.s.sol`) will key on this common address.

### Bugs caught by the rehearsals

1. **F1 caught**: `vaipakamReward` vs `rewardOApp` addresses.json
   key drift (4 sites); `Handover.s.sol` broadcasting as ADMIN
   while OApps are owned by VPFI_OWNER + REWARD_OWNER;
   BASE_EID=0 missing on canonical chain in tiered scripts;
   Reward OApp proxy CREATE2 idempotency guard missing; need
   for `--fresh` + auto-archive + detect-and-refuse on
   `phase_contracts`.

2. **F2 caught**: `DeployTestnetLiquidityMocks` missing
   chain support for arb-sepolia + op-sepolia; Range Orders
   master flags don't auto-flip on `deploy-testnet.sh`;
   VPFIBuyAdapter rate limits not auto-set on mirror branch;
   Safe support gap on Arb Sepolia → multisig-bytecode
   preflight gate added.

3. **F3**: clean pass. The cumulative hardenings from F1 + F2
   meant no new bugs surfaced.

