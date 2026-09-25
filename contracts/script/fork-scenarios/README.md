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
# 1. a fork of the target chain, on 127.0.0.1:8545 — this forks the LATEST
#    block, so it verifies the deployment as it is NOW, and a later run need
#    not reproduce an earlier ledger's figures (configuration can change).
anvil --fork-url "$BASE_SEPOLIA_RPC_URL" --chain-id 84532
#    To re-run against the exact state a recorded ledger describes, pin its
#    block (every ledger records it as `forkBlock`):
#      anvil --fork-url "$BASE_SEPOLIA_RPC_URL" --chain-id 84532 --fork-block-number <forkBlock>
#    Figures that depend on elapsed time (accrued interest) can still differ
#    in the last decimals, because the time warps land on different seconds.
#    No Foundry install? Its official npm packages work where GitHub
#    release downloads are blocked:  npm i @foundry-rs/anvil @foundry-rs/forge
#    Anvil is the node to use, and the only one the current driver is
#    verified on. The first run used a hardhat fork node, which did NOT
#    reproduce the EIP-7702 delegations on the real chain (see below), so it
#    can pass what the live chain would refuse.

# 2. install the pinned dependency graph for the driver, once
cd contracts/script/fork-scenarios && npm ci

# 3. drive
node run-all.mjs            # everything, in order
node run-all.mjs 02 04      # just the lifecycle and early-exit sets
```

Environment:

| Variable | Default | Meaning |
| --- | --- | --- |
| `FORK_RPC_URL` | `http://127.0.0.1:8545` | the fork node |
| `FORK_CHAIN_SLUG` | `base-sepolia` | which `contracts/deployments/<slug>/addresses.json` to read. The scenarios drive the deployment's **testnet fixtures** (faucet tokens, owner-gated feeds, a mock v3 pool and swap venue), and today only `base-sepolia`'s artifact carries them; any other slug stops before running, naming the missing fixtures |

Nothing is hard-coded: the Diamond and faucet-mock addresses come from the
deployment artifact for the selected slug, so the driver follows a redeploy
without an edit; the treasury and the admin, both mutable, are read from the
live Diamond (the artifact's values are only compared against them).

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
`package.json` and needs its own install — `npm ci`, against the committed
`package-lock.json`, so every machine resolves the same viem and the same
transitives (an unpinned `^` range would let a viem release change the
harness's gas estimation, ABI decoding or error names with no repository
diff). It imports the ABIs by
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
- **Impersonating the testnet mocks' deployer**, to reprice a faucet feed,
  its mock v3 pool, or the mock swap venue. To rehearse a PRICE MOVE use
  `repriceFaucetAsset`, which moves the feed and the pool's spot together:
  the oracle only trusts a pool whose spot agrees with the feed within the
  TWAP-consistency band (3% by default), so moving the feed alone flips the
  asset Illiquid after a 3% move — which looks exactly like a pool too
  shallow for the trade, and was first misdiagnosed that way (#2314). Those setters are owner-gated *on purpose* — a public
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

## What a run verifies — and what it does not

The scope is DECLARED, not open-ended. "Is the verification complete?" has no
natural end — there is always one more invariant a regression could break —
so a run certifies exactly this, for every step a row is written about:

1. **An exact token ledger** over every holder the funds pass through (both
   parties' wallets and vaults, the Diamond, the treasury, the venue, any
   third party): every watched balance change equals the spec-derived map.
2. **The whole position**: every field `getLoanDetails` returns, both
   position-NFT holders, and every field of the collateral lien — each
   changed to the stated value or exactly as it was (`expectPosition`), and
   every claim through `claimAndExpect`.
3. **Refusals by name**, with the probe set up so only the guard under test
   can refuse.
4. **No configurable number written in**: read from the chain or derived
   from a spec formula; a chosen input is derived or declared as an envelope.

Fixture steps a scenario only sets up with (`openLoan`, gate-probe offers)
are asserted once, in A2, not at every use. Every loan a scenario creates has
a fixed shape, which is itself an envelope: the shared `createOffer` /
`acceptOffer` treat a refusal on one of the protocol's own admission limits
(`HealthFactorTooLow`, `LTVExceeded`, `InitLtvAboveTier`,
`CollateralBelowRequired`, `MinCollateralBelowFloor`,
`OfferDurationExceedsCap`) as DID NOT RUN, naming the refusal; any other
refusal is a broken flow or a refusal the scenario asserts on. Every step's
position check compares against a snapshot taken BEFORE that step.

**Not verified, and tracked in #2332**: position-NFT metadata and the
reverse position index; position locks while a sale or offset link is live;
the SIZE of a periodic auto-settlement's collateral sale (the spec does not
define its buffer — an owner question); and whether interest booked by a
periodic settlement is credited when that loan later closes. A finding in one
of those is a follow-up for #2332, not a gap in what a run claims.

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
- **Assert, observe, or abort — the ledger API allows nothing else.**
  `check(id, name, ok)` (and `expectEq`) is an assertion and can only be
  PASS or FAIL; `observe(id, name, detail)` is an observation and is always
  INFO; `cannotContinue(step, why)` throws, and the runner names the file as
  ABORTED and exits non-zero. There is no way to write a verdict string. The
  first version took one, and grew two quiet failure shapes: rows that
  printed a number under a hard-coded `'PASS'`, and rows whose FAILURE branch
  was `'INFO'` — so a regression on either read as green. Use `observe` only
  for something with no expectation worth failing on — a deployment's
  configured value, a shape worth writing down — and give every `check` a
  condition that would actually be false if the behaviour regressed: an exact
  expected value, the refusal's NAME rather than "it reverted", both sides of
  a transfer rather than one.
- **A refusal is asserted by name** — `expectRefusal(id, name, result,
  'ErrorName')`. A row that accepts any revert certifies whichever guard
  fired first, so with the guard under test removed a later, unrelated
  refusal (a missing allowance, an empty route, an illiquid asset) keeps it
  green. Set the probe up so only the guard under test CAN refuse, then name
  it.
- **A step that moves money is asserted as an exact ledger** —
  `expectLedger(id, name, before, after, expected)`. Every watched balance
  change must equal the expected map (absent = 0), so an unexpected transfer
  fails as surely as a wrong amount. Compute the expected map from the
  functional spec's formula, never from the deltas the step just produced —
  deriving the expectation from the outcome only proves the outcome equals
  itself.
- **No configurable number is written into a scenario.** Fee rates, the
  matcher share, health-factor floors, liquidation LTV, the rental buffer,
  grace windows — all governance-tunable, and all stamped on a loan when it
  opens. Read the live getter (`liveFees()`, `getMinHealthFactor`,
  `getEffectiveGraceSeconds`, …) for what a new loan will stamp, and the
  loan's own stamp for how an open loan settles. A hard-coded default
  certifies one deployment's configuration as a protocol invariant.
- **A step asserts the WHOLE position** — `expectPosition(id, name, loanId,
  before, changes)` with `before = positionOf(loanId)` from before the step.
  Every tracked field — EVERY field `getLoanDetails` returns, derived from
  the ABI, plus both NFT holders and every lien field — must change to the
  stated value or stay exactly as it was. A position the step creates passes
  `before = null` and states every field except `CHAIN_ASSIGNED_AT_CREATION`
  (ids, timestamps, accumulators), building its terms with
  `termsFromOffer(storedOffer)` and its stamps with `liveStamps()`; `ANY` is
  only for a token id a step re-mints on an existing position. A row that checks one field of a position
  leaves every other field unchecked, and adding them row by row never ends.
- **An input a scenario CHOOSES is derived, or declared.** The same holds
  for the probe's own inputs — how far to warp, how big a partial, what
  price to move to. Derive it from the chain where that is cheap (warp to
  the grace end the chain reports; raise a partial to the asset's
  `minPartialBps`; compute a probe price from the loan's stamps). Where it
  is not, declare the configuration the scenario was written for with
  `requireEnvelope(knob, ok, detail)`: a deployment outside it stops the
  file, reported as DID NOT RUN with the knob named — not as a protocol
  FAIL. Scaling every input to every valid setting is an edge list with no
  end; one declared envelope per scenario is bounded. The runner applies one
  globally: the ledgers are written for an EXTERNAL treasury, so a
  Diamond-as-treasury deployment stops the run before any file.
- **Resolve a vault through `vaultAddressFor`, never `getUserVaultAddress`
  directly.** The raw getter answers `address(0)` for a user who has no vault
  yet, without reverting, and snapshotting the zero address yields a
  perfectly plausible balance of zero for every token. The helper ensures,
  re-reads and refuses a zero; `snapshot()` refuses one too, as an
  independent second guard on the same failure.
