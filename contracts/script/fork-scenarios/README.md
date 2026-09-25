# Fork scenarios — driving a live deployment as an advanced user

This is a no-compiler driver that exercises a **real deployed Diamond** on a
local fork, as an advanced user would: it opens offers, accepts them, repays,
preclosesses, defaults, liquidates, and probes the sanctions / KYC / illiquid
gates — accounting every movement of value to the wei.

It exists alongside, not instead of, the Solidity flow scripts
(`AnvilNewPositiveFlows.s.sol` and siblings, catalogued in
[`docs/TestScopes/AdvancedUserGuideTestMatrix.md`](../../../docs/TestScopes/AdvancedUserGuideTestMatrix.md)).
Those are the canonical on-chain flows and they need `forge`. This driver
answers a different question — *does the deployment that is live right now
behave as documented* — and it needs only Node, because it reads the
committed per-facet ABIs rather than compiling anything.

The findings from its first full run are written up in
[`docs/TestScopes/ForkVerification-BaseSepolia-2026-09-24.md`](../../../docs/TestScopes/ForkVerification-BaseSepolia-2026-09-24.md).

## Why forking beats a fresh local deploy here

A fresh deploy proves the source tree is self-consistent. A fork proves the
*deployed bytecode* is, which is the only thing a user ever touches — and it
carries the deployment's real configuration with it (the registered swap
venue, the seeded faucet prices and pool depth, the external treasury
address, whatever facets are actually routed). Several findings in the
write-up above are properties of the deployment, not of the source, and a
fresh deploy would have hidden every one of them.

## Running it

```bash
# 1. a fork of the target chain, on 127.0.0.1:8545
anvil --fork-url "$BASE_SEPOLIA_RPC_URL" --chain-id 84532
#    No Foundry install? Its official npm packages work where GitHub
#    release downloads are blocked:  npm i @foundry-rs/anvil @foundry-rs/forge
#    Anvil is the node to use. A hardhat fork node runs the driver too, but it
#    did NOT reproduce the EIP-7702 delegations on the real chain (see below),
#    so it can pass what the live chain would refuse.

# 2. install viem for the driver, once
cd contracts/script/fork-scenarios && npm install

# 3. drive
node run-all.mjs            # everything, in order
node run-all.mjs 02 04      # just the lifecycle and early-exit sets
```

Environment:

| Variable | Default | Meaning |
| --- | --- | --- |
| `FORK_RPC_URL` | `http://127.0.0.1:8545` | the fork node |
| `FORK_CHAIN_SLUG` | `base-sepolia` | which `contracts/deployments/<slug>/addresses.json` to read |

Nothing is hard-coded: the Diamond, treasury, admin and faucet-mock addresses
all come from the deployment artifact for the selected slug, so the driver
follows a redeploy without an edit.

The driver leaves `last-run.json` beside itself — the full ledger, one row per
scenario, with the verdict and the observed numbers, plus any scenario file
that aborted.

Five things the driver handles for you, each of which silently cost a
scenario file, or a whole run, before it was fixed:

- **It mines one block first.** On a fresh fork `latest` IS the fork block,
  and a hardhat node refuses to execute `eth_call` there ("No known hardfork
  for execution on historical block N"). `eth_getCode` still answers, so a
  naive preflight passes and the first scenario dies on its first read.
- **An aborted file is named in the summary**, not only in the scroll-back,
  and it sets a non-zero exit. A file that aborts contributes no rows, so
  without that the tally reads clean while a fifth of the suite never ran.
- **It generates fresh actor keys every run** and funds them with
  `setBalance`, refusing to start if any actor has code. The published
  test-mnemonic keys a fork node pre-funds are not clean on a public testnet:
  on Base Sepolia the second and third already carry **EIP-7702 delegations**,
  so the Diamond saw a contract where the scenario meant a wallet — accept
  signatures went down the ERC-1271 path (`AcceptSignatureInvalid`) and a
  position-NFT mint to one hit a receiver hook (`NFTMintFailed`). The first
  full run used a hardhat fork node that did not reproduce those delegations
  and passed; Anvil does, and failed.
- **Each scenario file runs inside a node snapshot** (`evm_snapshot` before,
  `evm_revert` after, abort or not). A file that aborted halfway used to
  leave its price moves behind — one abort in A3 left the debt asset priced
  2.5× and turned every later file into an unrelated-looking
  `IlliquidAssetNotAcknowledged`. Restoring by hand in every file is only as
  complete as the last person remembered; the snapshot is complete by
  construction.
- **Sends carry a 20% gas margin over the estimate**, and a send that still
  reverts on-chain is replayed at its parent block so the abort line says
  whether it was a real refusal or a gas shortfall. Anvil's estimate for a
  loan-CLOSING call comes back short: clearing that much storage earns a
  refund that hides the peak, and the send dies with "not enough gas for
  reentrancy sentry" (the EIP-2200 rule that an SSTORE needs more than 2,300
  gas left) — observed on `repayLoan` after a partial, estimate 573,777,
  reverted at 565,251.

## It is not a member of the pnpm workspace

`contracts/` is deliberately outside the workspace (it is a Foundry project),
and this driver lives under it because it belongs to the contracts' test
surface rather than to any app. It therefore carries its own tiny
`package.json` and needs its own `npm install`. It imports the ABIs by
relative path from `packages/contracts/src/abis`, which keeps the compiler as
the single source of truth for every decode — the same rule the Workers
follow.

## What it may and may not do to the fork

It uses the fork node's own cheatcodes — time warp, `setBalance`,
impersonation, `setCode` — and nothing else. Three of those are unavoidable
and worth naming:

- **Impersonating the Diamond admin**, to arm the sanctions oracle and to
  flip KYC enforcement. Both are admin-only by design; there is no other way
  to observe what those gates do when they bite.
- **Impersonating the testnet mocks' deployer**, to reprice a faucet feed or
  the mock swap venue. Those setters are owner-gated *on purpose* — a public
  testnet's HF and liquidation demos must not be repriceable by a passer-by —
  so the harness has to step into that role rather than around it.
- **`setCode` for a stub sanctions oracle**, because this driver has no
  Solidity compiler. The stub is a ten-byte runtime that answers `true` to
  everything; the Diamond itself is never patched.

A scenario that changes global state still puts it back where it can (A3
restores the seeded prices, A5 disarms the oracle and the KYC knob, A9
re-sets the periodic-interest switch), but that is now belt-and-braces:
`run-all.mjs` reverts the fork to its pre-file snapshot after every file, so
each file starts from the same chain state whether it runs alone, in a
subset, or after a predecessor that aborted. A file that runs on a node
without `evm_snapshot` support is refused rather than run unisolated.

## Adding a scenario

Drop an `NN-name.mjs` under `scenarios/` exporting `async function run()`, and
record outcomes through `lib/report.mjs`. Three conventions carry the value of
this harness and are worth keeping:

- **Simulate before you send.** `lib/errors.mjs`'s `simulate()` decodes the
  Diamond's custom errors by name. Several behaviours under test *are*
  refusals; a scenario that can only say "it reverted" cannot tell an
  expected refusal from a defect. `tx()` decodes a reverted SEND through the
  same table (`lib/selectors.mjs`, which is separate precisely so both sides
  can reach it without an import cycle), so a state change that refuses is
  named too — it used to abort on raw hex.
- **Account the money, don't assert a status code.** `snapshot()` / `delta()`
  over every party (both EOAs, both vaults, the Diamond, the treasury, the
  venue, the liquidator) is what turns "the repay succeeded" into "the
  treasury took 2% of the interest and nothing of the principal".
- **Record an honest `INFO` rather than a flattering `PASS`.** An observation
  worth keeping that has no assertion behind it is an `INFO`; a mis-specified
  expectation gets its expectation fixed, never its verdict. A hard-coded
  `'PASS'` on a row that only prints deltas is the worst of both — it reads as
  a check and is not one. That is how an unresolved vault address survived
  ten steps before an accounting assertion caught it.
- **Resolve a vault through `vaultAddressFor`, never `getUserVaultAddress`
  directly.** The raw getter answers `address(0)` for a user who has no vault
  yet, without reverting, and snapshotting the zero address yields a
  perfectly plausible balance of zero for every token. The helper ensures,
  re-reads and refuses a zero; `snapshot()` refuses one too, as an
  independent second guard on the same failure.
