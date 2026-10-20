# `script/e2e/` — the e2e chains

The app's e2e suite (`apps/app/e2e/`, the `fork-tier scenarios` CI job) runs
against the repository's **current** contracts, deployed from source onto a
bare local Anvil for every run (#2334). It no longer forks live Base Sepolia.
The keeper's Anvil scenarios (`apps/keeper/e2e/`, the `keeper anvil
scenarios` CI job, #2496) start from the same deploy and then configure it as
a canonical reward chain.

| File | What it is |
| --- | --- |
| `DeployE2EFixture.s.sol` | Deploys the Diamond (`DeployDiamond.runWith`) and the faucet + oracle mocks (`DeployTestnetMocks._deployTestnetMocks`) in one script. It writes its artifact to the gitignored `deployments/.forge-test/e2e/`, never to a committed per-chain file. |
| `Permit2.runtime.hex` | The runtime bytecode of Uniswap's canonical Permit2. The harness installs it at `0x000000000022D473030F116dDEE9F6B43aC78BA3`. |
| `Multicall3.runtime.hex` | The runtime bytecode of the canonical Multicall3. The harness installs it at `0xcA11bde05977b3631167028862bE2a173976CA11`. |
| `ConfigureKeeperRewardsFixture.s.sol` | Keeper scenarios only. Run after the deploy, once the chain presents 84532, it makes the Diamond a canonical reward chain: a VPFI token with the Diamond as minter, the interaction-reward launch, reward custody activated, the reward pool funded, and a `TestnetSanctionsOverlay` set as the sanctions oracle. It writes `deployments/.forge-test/e2e/keeper/rewards.json`. |
| `E2ELocalCcip.sol` | Keeper two-chain scenarios only (#2516). The two halves of a local CCIP lane that sit where Chainlink's DONs sit on a live lane: `E2ELocalOnRamp` (registered on the REAL `Router` as the on-ramp toward the other chain; calls each token pool's real `lockOrBurn` and emits the message) and `E2ELocalOffRamp` (registered as the off-ramp from it; executable only by the harness relay's key, once per message; calls the real pool's `releaseOrMint`, checks the receiver got exactly the reported amount, then routes the message through the real router). Test doubles, and kept here, never under `src/`. |
| `DeployE2ELocalCcip.s.sol` | Keeper two-chain scenarios only. One node's half of the lane: the REAL `RMNRemote` behind the REAL `RMNProxy`, the REAL `Router` (native fees wrapped into the canonical WETH9), the REAL `TokenAdminRegistry` with the REAL `RegistryModuleOwnerCustom`, and the two ramps above. Records the addresses under `deployments/.forge-test/`; the selectors and the fee are written as decimal strings because a CCIP selector is past 2^53. |
| `E2EOperatorScripts.s.sol` | Keeper two-chain scenarios only. The operator scripts themselves (`DeployVPFIToken`, `DeployCrosschain`, `ConfigureVPFIToken`, `ConfigureCcip`, `ConfigureRewardReporter`, `SetInteractionLaunch`), each inherited unchanged with one addition: `setUp()` redirects that script instance's artifact root under `deployments/.forge-test/`, so it reads and writes only scratch artifacts. Run with `--tc <Contract>`. |
| `ConfigureKeeperMeshFixture.s.sol` | Keeper two-chain scenarios only. The admin steps no operator script performs: reward custody activated on each chain; on the canonical chain, the reward pool funded and the keeper authorized to remit (`setRewardRemittanceKeeper`). |

The harness side is `packages/anvil-harness/src/fixture.ts` (shared by both
suites since #2496; the app's entry point is still `apps/app/e2e/lib/fixture.ts`,
which calls it). The steps it runs around this script:

1. Install WETH9, Multicall3 and Permit2 at their canonical addresses. A bare
   chain has none of the three, and the script refuses to run without them.
   WETH9 is constructed normally and then cloned (code and storage), because
   its `decimals` lives in storage its constructor writes; the other two keep
   no constructor state, so their runtime is copied as is.
2. Run the script on Anvil's own chain id, 31337. A script may redirect
   its artifact only on 31337, under `forge test`, or on a node that answers
   `anvil_nodeInfo` (a local Anvil, whatever id it presents — which is what
   lets the keeper's two-chain scenarios run the operator scripts unchanged
   on nodes presenting 84532 and 11155111).
3. Switch the chain id to 84532, so the app's Base Sepolia wiring applies
   unchanged. Every contract reads `block.chainid` at call time.
4. Write the e2e deployments bundle that the app, the harness and the
   indexer stub all read. (The keeper fixture writes its own bundle, under
   `apps/keeper/e2e/.state/`, after running `ConfigureKeeperRewardsFixture`.)

## Permit2 provenance

Permit2's source is not in this tree. Spec `12-permit2` needs the **real**
contract, because it verifies signatures, so `test/mocks/MockPermit2.sol`
cannot stand in for it. The file holds the code at the canonical address,
read with `eth_getCode` from Base Sepolia on 2026-09-26. The runtime
bytecode is the same on every chain except for two immutables: the cached
chain id and domain separator. Base Sepolia's copy caches 84532, the id the
e2e chain presents. Permit2 recomputes its domain whenever `block.chainid`
differs, so the choice affects only which branch it takes.

- keccak256 of the runtime bytes (`cast keccak $(cat Permit2.runtime.hex)`, which is also what `eth_getCode`'s result hashes to): `0xdcde65555316946c298e4c60c6213eb5c3aeab4354d1f3fac5427236bcbb9ebe`
- Licence: MIT (Uniswap Permit2).

## Multicall3 provenance

The app batches reads through Multicall3, including `getBlockNumber()`, so
the test mock `test/mocks/Multicall3Mock.sol` (which implements only
`aggregate3`) cannot stand in for it. The file holds the code at the
canonical address, read with `eth_getCode` on 2026-09-26. Unlike Permit2 it
has no immutables: the copies on Base Sepolia and Ethereum mainnet are
byte-identical.

- keccak256 of the runtime bytes: `0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891`
- Licence: MIT (Multicall3).

`DeployE2EFixture` pins both code hashes, so an install of anything else
fails before the deploy.
