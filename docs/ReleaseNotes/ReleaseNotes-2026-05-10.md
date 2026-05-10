# Release notes — 2026-05-10

A single-day session that took the deploy surface from "documented
intent" all the way through three live testnet rehearsals. The
work landed in three loose phases: phase-2 hardening of the
contracts (asymmetric pause, atomic-configure spell, ABI-bundle
discipline), a deploy-script modernization sweep that produced
three coherent shell scripts where there had been one, and three
end-to-end rehearsals (F1 base-sepolia, F2 arb-sepolia, F3 sepolia)
that each caught one or two real bugs before mainnet would have.

The headline number: **22 commits**, every one tied to either a
deliberate hardening or a real failure surfaced by the next
rehearsal.

## Phase 2 — asymmetric pauser/unpauser split (UNPAUSER_ROLE)

The Diamond's pause surface was symmetric: anyone holding
`PAUSER_ROLE` could both engage AND lift a freeze. That meant a
single compromised Pauser key could un-do its own mistaken pause
without any review window — defeating the purpose of a fast-key
fast-trip. Adopted the asymmetric pause pattern. `PAUSER_ROLE`
stays the fast incident lever, widely-distributed signers OK
because the worst case is a freeze that hurts UX but never drains
funds. A new `UNPAUSER_ROLE` is the deliberate reset gate, held
by the Timelock at handover so a real-incident unpause waits the
Timelock's `minDelay` review window.

Surface-by-surface:

- `pause()` — `PAUSER_ROLE` (unchanged, fast lever)
- `unpause()` — `PAUSER_ROLE` → `UNPAUSER_ROLE` (deliberate reset)
- `pauseAsset()` — `onlyAdminOrPauser` (unchanged)
- `unpauseAsset()` — `onlyAdminOrPauser` → `onlyAdminOrUnpauser`
  (new modifier, matches the global asymmetry)
- `autoPause()` (the WATCHER_ROLE write-only lever) — unchanged;
  the comment now points at UNPAUSER as the recovery surface

`LibAccessControl` got a new `UNPAUSER_ROLE` constant, the role
became part of `grantableRoles()` (so DeployDiamond's existing
loop grants it to the deployer at init + the deployer renounces
at handover with no extra step), and `Handover.s.sol`'s
`_timelockRoles()` array grew from 5 to 6 entries to route
UNPAUSER_ROLE alongside the other delayed-action roles.

Two existing tests had the pre-split semantics encoded:
`testUnpauseRevertsNonPauser` expected the revert to name
PAUSER_ROLE; `test_pauseAsset_worksWithPauserRoleAlone` asserted
PAUSER_ROLE alone roundtripped pauseAsset + unpauseAsset.
Caught up the assertions and added two new tests
(`test_unpauseAsset_revertsWithPauserRoleAlone`,
`test_unpauseAsset_worksWithUnpauserRoleAlone`) that pin the
asymmetric semantics so a future regression that re-merges the
roles fails loudly.

The split also closes the practical question of who holds
UNPAUSER_ROLE: the Timelock contract on every chain, with
TIMELOCK_PROPOSER as the only entity that can schedule a
Timelock transaction. No new multisig keys; the asymmetry comes
from the `minDelay` review window, not from a separate signer
set.

## Phase 2 — DiamondConfigSpell (atomic configure)

Pre-this-change, four post-deploy `Configure*.s.sol` scripts
(ConfigureOracle, ConfigureRewardReporter, ConfigureVPFIBuy,
ConfigureNFTImageURIs) had to run separately on each chain. Four
operator actions, four broadcasts, four chances to forget a step
or land them out of order. `DiamondConfigSpell.s.sol` composes
the four into a single `run()` that sequences each child via the
in-memory-instance dispatch pattern (same shape as
`PositiveFlows.s.sol` / `PartialFlows.s.sol`). One operator
action, all four configures attempted in a deterministic order;
a mid-flight revert short-circuits later children so the
operator can't accidentally skip the failed subset.

True on-chain atomicity (single tx covering all four configures)
isn't practical here — AccessControl's `grantRole` and the facet
setters all key on `msg.sender`, so Multicall3 batching can't
deliver it without a Diamond-side `executeSpell(bytes calldata)`
entry point we don't have today. The compositional approach is
step-1; a future single-tx upgrade can land later as a Diamond
facet without touching this surface.

ConfigureLZConfig is intentionally NOT in the spell: its
broadcast key is `PRIVATE_KEY` (OApp owner), not
`ADMIN_PRIVATE_KEY`, and it targets the LZ endpoint, not the
Diamond. It stays as its own phase.

The spell got wired into both `deploy-mainnet.sh` and
`deploy-testnet.sh` as `--phase configure`, sequenced AFTER
`--phase lz-config` (different signer key) and BEFORE
`--phase handover` (so configs land while ADMIN still holds
every Diamond role).

## Phase 2 — apps/agent + apps/keeper ABI imports + a real bug fix

The two non-indexer Cloudflare Workers (`apps/agent`,
`apps/keeper`) still hand-typed their Diamond-read ABIs as
`parseAbi([...])` string literals. The indexer Worker had
already migrated to JSON-imports from
`@vaipakam/contracts/abis` (the same per-facet bundle the
frontend reads); the other two surfaces hadn't. Five files got
the migration: `apps/agent/src/{frames,buyWatchdog,
periodicPreNotify}.ts` and `apps/keeper/src/{keeper,watcher}.ts`.

The migration turned out to surface a real, latent bug.
`apps/agent/frames.ts` (the Farcaster Frame for "check your
active loans") and `apps/keeper/watcher.ts` (the HF cron) both
called `getActiveLoansByUser(address)` on the Diamond. That
selector doesn't exist on any facet — the actual selector is
`getUserActiveLoans(address)` on `MetricsFacet`. Word-order
swap. Pre-fix, every Frame hit and every keeper tick that read
a user's active loans was silently reverting against the
on-chain Diamond. The hand-typed `parseAbi` string had been
hiding the typo since the function was renamed; the
JSON-import migration would have failed at module-load if the
function name doesn't appear in `MetricsFacet.json`, surfacing
the bug. Both call sites now use the correct selector.

The `keeper.ts` `getLoanDetails` call also moved from a hand-
typed-tuple ABI to `LoanFacetABI` from the bundle — the
inline version had every Loan struct field hand-typed, the
exact drift hazard ReleaseNotes-2026-05-05.md flagged when the
old hf-watcher silently misaligned its `getOfferDetails`
positional decoder.

`enableAaveAccount` (a literal ConnectKit prop name) stayed
unchanged in `wagmiConfig.ts` — it's an external library API
identifier, not a brand reference.

## Deploy-script modernization sweep — three coherent scripts

The deploy surface had been one big `deploy-chain.sh`
(testnet one-shot) plus a tiered `deploy-mainnet.sh`. Both
referenced the pre-Stage-3 source tree (`frontend/`,
`ops/hf-watcher/`) and the per-app skip-flags couldn't address
the new five-app shape (apps/{defi,www,keeper,indexer,agent}).
A few modernization passes landed:

- **Stage 3/4 path-modernization** of `deploy-chain.sh` —
  single `frontend/` deploy split into two SPA deploys
  (apps/defi + apps/www), single `ops/hf-watcher` deploy split
  into three Worker deploys (apps/keeper + apps/indexer +
  apps/agent), `--skip-frontend / --skip-watcher` flags
  replaced with five per-app skip flags + `--skip-cf` alias,
  the dead `exportWatcherAbis.sh` call removed, D1 binding
  renamed `vaipakam-alerts-db → vaipakam-archive`. npm → pnpm
  throughout the new sections.

- **`deploy-testnet.sh` (new)** — mirrors `deploy-mainnet.sh`
  phase-for-phase so testnet rehearsals exercise the same
  ceremony, the same confirm-flag friction, and the same
  operator muscle memory as mainnet day. Three deltas only:
  the testnet chain registry, a lifted dirty-tree refusal,
  and an enabled `--phase pause-rehearsal` (refused on
  mainnet — pause there is an incident lever, not a drill).
  The pause-rehearsal phase has a three-mode dispatch:
  `--mode calldata` prints `pause()` calldata for the
  operator to sign through the Pauser Safe UI, `--mode check`
  reads `paused()` on every contract and reports elapsed time
  vs the 5-minute budget, `--mode unpause-calldata` prints
  the inverse for cleanup.

- **`deploy-mainnet.sh` modernization** — same path/per-app
  splits as deploy-chain, plus a hardened argument parser
  (`--fresh` + `--confirm-purging-prior-mainnet-deploy` two-
  gate combo for re-running `--phase contracts` on a chain
  that already has a deployed Diamond), the new
  `--phase handover` (rotates DEFAULT_ADMIN to governance Safe
  direct, ADMIN/KYC/ORACLE/RISK/ESCROW/UNPAUSER to Timelock,
  PAUSER to Pauser Safe direct, ERC-173 to Timelock; ADMIN
  renounces every role), `--phase configure` (the spell), and
  five replacement cf-* phases (`cf-defi`, `cf-www`,
  `cf-keeper`, `cf-indexer`, `cf-agent`) for the retired
  `cf-frontend` + `cf-watcher`.

Three new export scripts under `contracts/script/` populate
the corresponding `ops/` surfaces from a single source of
truth (the deployed addresses + compiled-bytecode ABI):
`exportSubgraphAbis.sh` writes the consolidated event-ABI bundle
+ per-chain `subgraph.<slug>.yaml`, `exportTenderlyAlerts.sh`
substitutes `${CHAIN}` + `${DIAMOND_ADDRESS}` placeholders into
per-chain `alerts-<slug>.yaml`, and `exportLzWatcherVars.sh`
emits the `wrangler secret put` shell snippet for the OAPP_*
variables the lz-watcher Worker reads. All three are wired into
each deploy script's `--phase abi-sync` so they fire automatically
post-deploy.

`Handover.s.sol` — the new Solidity script the handover phase
shells out to — broadcasts as ADMIN for the Diamond role grants +
renounces, then opens separate broadcast windows keyed on
`VPFI_OWNER_PRIVATE_KEY` and `REWARD_OWNER_PRIVATE_KEY` (each
falling back to ADMIN_PRIVATE_KEY when not set) for the OApp
ownership transfers. Each OApp transfer reads the on-chain
`owner()` first and skips with operator-friendly guidance if the
signing key's EOA doesn't match — robust to the
ownership-set-during-deploy variation between OApp deploy
scripts.

`pause-all-chains.sh` (new, standalone) is the production
incident-response equivalent of the testnet `pause-rehearsal`
phase: walks every chain under `contracts/deployments/`, prints
`pause()` calldata for the Diamond + every LZ OApp on every
chain, stamps a sentinel for the 5-minute budget check,
supports `--check` for state verification + `--unpause-calldata`
for post-incident cleanup. Standalone (not a deploy-script
phase) because pausing on mainnet is never a deploy-script
side-effect.

## Inspirational brand-name scrub

Three groups of third-party names had accumulated in code
comments + user-facing copy:

1. **Inspirational pattern attribution** (MakerDAO,
   EigenLayer, Penpie) — comments using these names as
   shorthand for the patterns they originated. Replaced with
   the pattern descriptions themselves: "MakerDAO-spell-style"
   → "spell-style", "asymmetric pause split" stays
   self-descriptive, "Penpie (Sept 2024) lost ~$621k on
   Arbitrum" → "A September 2024 cross-chain incident lost
   ~$621k on Arbitrum". Across contracts/{script,src,test} +
   docs/.

2. **DeFi competitor mentions** in user-facing copy
   (Aave, Compound, Pendle, Lido, Yearn, Frax) — generally
   replaced with "major DeFi protocols", "yield protocol",
   "liquid-staking protocol", "stablecoin protocol", etc.
   across apps/{defi,www} navbars, app shells, environment
   helpers, and library-pattern comments. The literal
   ConnectKit prop name `enableAaveAccount` stayed (external
   library API identifier; the surrounding comment lost the
   brand emphasis). Docs also got the same scrub (research
   tables of competitor protocols genericized).

3. **Sushi + Pancake** (mid-session correction) —
   intentionally KEPT. They're complementary integrations,
   not competitors: Vaipakam's oracle policy reads from
   Uniswap V3 + PancakeSwap V3 + SushiSwap V3 pools as part
   of its 3-V3-clone OR-logic for liquidity classification.
   Removing them would be technically wrong. The earlier
   scrub pass that genericised PancakeSwap V3 / SushiSwap V3
   in user-facing whitepaper + userguide copy got reverted
   to the original wording; the literal Solidity function
   selectors (`setPancakeswapV3Factory`,
   `getSushiswapV3Factory`, etc.) were already on-chain
   identifiers that can't be renamed without a contract
   refactor + ABI break, so those stay too.

## F1 — base-sepolia rehearsal

First end-to-end rehearsal of the modernized flow against a
real testnet. Caught two real bugs the script-only sanity
check hadn't surfaced:

- **`addresses.json` key drift** — the new `Handover.s.sol`
  + `pause-all-chains.sh` + `exportLzWatcherVars.sh` all
  spelled the Reward OApp key as `vaipakamReward` (vibing
  off the contract's name). The actual key per
  `script/lib/Deployments.sol` is `rewardOApp`. Pre-fix,
  the Handover script silently dropped the rewardOApp
  transfer (read-as-zero-address branch); the pause-all-
  chains script silently excluded rewardOApp from the
  pause-target list; the lz-watcher export emitted no
  OAPP_REWARD_<KEY> wrangler-secret line. All four sites
  fixed.

- **Handover OApp-owner mismatch** — `Handover.s.sol`
  initially broadcast every transferOwnership inside the
  ADMIN's broadcast window. But the OApps are owned by
  `VPFI_OWNER` (the deployer per .env.example) and
  `REWARD_OWNER`, not ADMIN. Every transferOwnership would
  have reverted `OwnableUnauthorizedAccount`. Fixed with the
  per-owner broadcast windows + on-chain owner read +
  skip-with-guidance-on-mismatch pattern described above.

Subsequent issues caught + hardened during the actual
broadcast walk:

- **BASE_EID=0 missing on canonical chain** — DeployRewardOAppCreate2
  has a `require(baseEid == 0)` on the canonical chain. The
  testnet/mainnet phase_contracts didn't override BASE_EID=0
  before the forge script (deploy-chain.sh's `[5]` step did,
  via `export BASE_EID=0`). Added the same override to both
  tiered scripts.

- **Proxy CREATE2 idempotency bug** — `DeployRewardOAppCreate2`
  had an `expectedBootstrap.code.length == 0` guard for the
  bootstrap impl, but no equivalent guard for the proxy. A
  re-run (after the BASE_EID fix above) hit `Create2DeployFailed`
  because the proxy was already at the deterministic CREATE2
  address from the failed run's CREATE2-deploy step. Added the
  same `expectedProxy.code.length == 0` guard.

- **`--fresh` flag + auto-archive + detect-and-refuse** — added
  to deploy-{testnet,mainnet}.sh `phase_contracts`. If
  `addresses.json` already has a `diamond` key, the phase
  refuses unless `--fresh` is passed (mainnet adds a second
  `--confirm-purging-prior-mainnet-deploy` gate). With the
  flag, the prior chain state — `addresses.json`,
  `deployment_source.json`, `.markers/`, `.history/`, and any
  `addresses.prior-rehearsal.*.json` sidecars — gets archived
  to `<chain>/.archive/<ISO-8601>/` before being wiped. Two
  explicit gates + automatic forensic archive: nothing
  destructive happens by default, but the recovery path is
  one flag away.

End-state: Diamond at `0x804Bc3E9625548e50c1B589b25111783A632D964`,
all 33 facets registered, master flags ON, BuyAdapter rate-limit
caps finite, governance Safe holds DEFAULT_ADMIN_ROLE, Timelock
holds the 5 delayed-action roles + UNPAUSER + ERC-173, Pauser
Safe holds PAUSER_ROLE, ADMIN holds zero roles. Three OApps
queued for Safe acceptOwnership; ceremony executed via Safe UI,
all three transferred to the governance Safe. DeployerZeroRolesTest
10/10 against the Base Sepolia fork.

## F2 — arb-sepolia rehearsal

Caught three more real bugs the deploy-script's static analysis
hadn't surfaced:

- **`DeployTestnetLiquidityMocks` chain coverage** — the script
  hardcoded chainId 84532 / 11155111 / 97 / 31337 and refused
  arb-sepolia (421614). Without it, the flow tests can't seed
  loans because the protocol can't classify mock assets as
  liquid. Added arb-sepolia (chainId 421614, WETH9 at
  `0x980B62Da83eFf3D4576C647993b0c1D7faf17c73`) and OP Sepolia
  (11155420, WETH9 at the OP-stack predeploy `0x4200…0006`).

- **Range Orders master flags don't auto-flip on testnet** —
  the flow scripts assume `rangeAmountEnabled` /
  `rangeRateEnabled` / `partialFillEnabled` are ON (Anvil's
  `BootstrapAnvil` flips them; `deploy-chain.sh` step `[5b]`
  flips them on testnets via cast-send). The new
  `deploy-testnet.sh` skipped the flip; PositiveFlows reverted
  in simulation at scenario N22 ("rangeAmountEnabled
  precondition"). Added the same `cast send` sequence to
  `deploy-testnet.sh`'s `phase_contracts` (testnet ergonomics
  only — `deploy-mainnet.sh` keeps the dormancy per the
  staged-rollout discipline).

- **VPFIBuyAdapter rate limits not auto-set on mirror chains**
  — the OApp ships with both rate caps at `type(uint256).max`,
  and the verify phase's rate-limit gate refuses the deploy
  until they're finite. `deploy-chain.sh` had a `[4c]
  setRateLimits` step; the tiered scripts didn't. Added it to
  both `deploy-testnet.sh` + `deploy-mainnet.sh`'s mirror
  branch (canonical chains have `vpfiBuyReceiver` instead;
  no rate-limit needed there).

- **Multisig-bytecode preflight on `--phase handover`** — the
  user surfaced a critical gap mid-rehearsal: Safe's testnet UI
  supports Sepolia + Base Sepolia but NOT Arbitrum Sepolia
  (Safe officially only supports Arb mainnet for the Arbitrum
  family). Running `--phase handover` on arb-sepolia would have
  granted DEFAULT_ADMIN_ROLE to an EOA-shaped address with no
  Safe behind it; combined with ADMIN's renounce, the role
  surface becomes permanently inaccessible. Added a preflight
  check at the top of `phase_handover` that reads `cast code`
  on each of the three multisig addresses and refuses with a
  clear recovery menu if any has zero bytecode. Mainnet variant
  has stricter language ("on mainnet this is a hard NO ... no
  recovery path") because the blast radius is real value.

End-state for arb-sepolia: Diamond at
`0x17Fe0D808F8971D7A14994a1205ee6AFd949Be91`, mocks deployed,
33 facets registered, master flags ON, BuyAdapter rate-limit
caps finite, **handover deliberately skipped** until the
operator deploys the Safe singletons to the matching CREATE2
addresses on Arb Sepolia via the Safe SDK. Diamond stays under
ADMIN's ownership for now. Flow tests landed: PositiveFlows
(33 scenarios, 351 txs), PartialFlows (13 midpoints, 143 txs)
— same broadcast-volume signature as Anvil + base-sepolia, so
the protocol behaves identically on Arb Sepolia under real
testnet RPC + gas.

The Reward OApp landed at `0xB112C8b7832Ca3b3A8f1D586188424d72B79bDf9`
on arb-sepolia — **the same address as base-sepolia**, confirming
the CREATE2 cross-chain parity property the salt is supposed
to deliver.

## F3 — sepolia rehearsal

The cleanest pass of the three. Safe is supported on Sepolia,
so the full pipeline ran end-to-end (preflight → contracts
--fresh → mocks → handover → abi-sync → verify), and the new
auto-steps (rate-limit set, master-flag flip, archive on
--fresh, multisig-bytecode preflight) all behaved as expected
without operator intervention.

End-state: Diamond at `0xD2903cbb8Bb0f34fbb688a6E381Dc6c73056DB1c`,
Reward OApp at `0xB112C8b7832Ca3b3A8f1D586188424d72B79bDf9`
(third chain to land at the same CREATE2 address — parity
holds across all three rehearsal chains). Multi-sig ceremony
executed via Safe UI for vpfiMirror + vpfiBuyAdapter +
rewardOApp; all three transferred to the governance Safe.
DeployerZeroRolesTest 10/10 against the Sepolia fork.

## What's still pending (operator-side, off the critical path)

1. `WireVPFIPeers.s.sol` — wire the cross-chain peer mesh
   (each canonical↔mirror pair signs `setPeer`).
2. `--phase lz-config` — populate DVN policy env vars per the
   project's "Cross-Chain Security Policy" (3 required + 2
   optional, threshold 1-of-2).
3. `--phase swap-adapters` — pull current 0x Settler
   addresses into INITIAL_SETTLERS.
4. `--phase configure` — populate per-chain Chainlink feed
   addresses (`{CHAIN}_WETH_ADDRESS`, `_ETH_USD_FEED`,
   `_USDC_FEED`, `_SEQUENCER_UPTIME_FEED`).
5. `--phase cf-{defi,www,keeper,indexer,agent}` — `pnpm
   install` at the monorepo root + `wrangler login` +
   per-Worker `RPC_<CHAIN>` secrets.
6. **Arb Sepolia handover** — deploy the three Safes to their
   deterministic CREATE2 addresses on Arb Sepolia via Safe
   SDK, then re-run `--phase handover` (the new bytecode
   preflight will pass once the contracts exist).
