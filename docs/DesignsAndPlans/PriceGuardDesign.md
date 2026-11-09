# Price guard (#3272)

## Why

The Diamond prices every asset in `OracleFacet`, and the pricing config is
Diamond storage that ADMIN sets at once. #3268's close-out checks need a price
that a faulty Diamond cannot influence: if a vault asked `OracleFacet`, a
compromised Diamond would be checking itself. The owner decided on 2026-11-07
that pricing moves into one standalone guard that both the Diamond and the
vaults read.

- **The Diamond** finds it through the Timelock-owned `ProtocolRegistry`
  (pointer `RegistryKeys.PRICE_GUARD`), never from Diamond storage.
- **A vault** never reads a mutable registry (owner decision 2026-11-09,
  #3431: "check outcomes, not identities"). So a vault holds the guard's
  address as a constant in its own code, and a new guard reaches vaults as a
  new vault version under the code delay, which an owner can pin against.
  #3268 builds that read. Its open question: the guard's own config still
  changes under the guard's delay (default 3 days), which a pinned vault does
  not hold back.

## What moves, what stays

**Moves to the guard: the whole pricing path, unchanged.**

- The primary read:
  - the asset/PAD feed resolved through `VaipakamFeedRegistry`;
  - the asset/ETH × ETH/PAD fallback;
  - the industrial-fork PAD pivot and per-asset direct feeds;
  - staleness, the stable-peg branch and per-feed overrides;
  - the L2 sequencer check.
- The Pyth cross-check on the ETH anchor.
- The soft 2-of-N secondary quorum (Tellor, API3, DIA), keyed by the
  registered pair identity.
- The status split: **Priced**, **Unavailable** (missing) and **Divergent**
  (distrusted). The existing rules keep their meaning: a missing price takes
  the lender-first in-kind path, and a distrusted price refuses (#666).
- The one freshness rule for a Chainlink answer. The liquidity probe still
  needs it for pool-implied reserves, so the guard exposes it as a
  non-reverting view instead of the facet keeping a second copy.

**Stays in the Diamond.**

- The liquidity classification: pool depth probes, tiers and the tier LTV
  cache.
- The daily price snapshots and the numeraire value rule
  (`LibNumeraireValue`).
- Every numeraire-denominated threshold.

`OracleFacet` keeps its price selectors (`getAssetPrice`,
`getAssetPriceStatus`, `tryGetAssetPrice`, `countLiveSecondaryOracleFeeds`,
`sequencerHealthy`) as forwarders to the guard. No consumer facet changes,
and EIP-170 room comes back to `OracleFacet`.

## Trust model

- **Not upgradeable.** A new guard version is a new deploy, swapped in by the
  registry pointer under its delay (min 3 days). The guardian can cancel the
  swap.
- **Config is the guard's own.** Every entry is proposed by the owner (the
  Timelock) and executed by anyone once the guard's delay has passed. The
  owner or the guardian (the Pauser Safe) may cancel a pending change. One
  change is pending per entry, and each waits the delay that was set when it
  was proposed.
- **Delay.** On a production chain the delay is 1 to 14 days, 3 by default. A
  testnet may set 0, as the feed registry allows.
- **One fast lever.** The guardian may disable a secondary source (Tellor,
  API3 or DIA) at once. This is stop-only: the quorum runs on fewer sources,
  and no price can be introduced. Re-enabling a source waits the delay.
- **Not configurable by the Diamond.** The Diamond holds no write path into
  the guard.
- **First settings** (owner decision 2026-11-09, "Set at deploy, checked
  once"): the constructor takes the full config. A guard goes live only through the
  registry's delayed pointer swap, which the guardian can cancel, so its
  starting config gets that review window.
- **Numeraire** (owner decision 2026-11-09, "Fix numeraire at deploy"): the guard's
  numeraire identity (its Chainlink denominator and symbol, and the PAD
  identity) is fixed at construction. Live numeraire switching
  (`setNumeraire`, `setPredominantDenominator`) is removed: once prices live
  in the guard and thresholds in the Diamond, a live switch would be a race
  between two contracts. The feeds behind the identity stay replaceable under
  the delay, so a Chainlink deprecation is a delayed replace, not a new guard.

## Where the deploy builds it

The protocol registry takes the guard as its `PRICE_GUARD` pointer at
construction, the one registry write that does not wait. The registry is built
inside `DeployDiamond` (step 5c-ii), because the vault code is built with the
registry's address. So the guard is built there too, just before the registry,
by `script/lib/PriceGuardDeployment.sol`:

- The chain's feed registry, the guard's feed source, is created in the same
  step (or the recorded one is reused). The later `DeployFeedRegistry` step
  reuses it and sets a testnet's delay, which needs the admin's key.
- The identity is retail USD, keyed by the feed registry's own USD and ETH
  denominators.
- The entries come from the deploy settings the oracle's configure step reads:
  `WETH_ADDRESS`, `ETH_USD_FEED`, `SEQUENCER_UPTIME_FEED` and the
  `VPFI_STABLE_FEED_SYMBOLS` references, chain-prefixed first. The deploy's
  operator entry reads them once and hands them to the deploy body as named
  inputs, with the Pauser Safe (`PAUSER_ADDRESS`) that guards a new feed
  registry on a production chain. The body reads no settings of its own, so a
  test names its inputs without touching settings other tests share.
- On a production chain the feed registry, WETH and the ETH/USD feed are
  required, each with code, so the guard starts complete. On a testnet a
  missing entry is left for the configure step; a mock rig's feeds and WETH
  exist only after the Diamond, and the testnet's zero delay applies them at
  once (part 2 moves the configure steps onto the guard).
- The owner and the guardian start as the admin; the handover moves them to
  the Timelock and the Pauser Safe.

WETH is a delayed entry, not part of the fixed identity: a testnet's WETH can
be a mock created after the Diamond, and which token is WETH is routing config
like a direct asset feed.

## Build order

1. **This PR.**
   - The `PriceGuard` contract, with its own test suite, ported from the
     pricing tests.
   - The deploy creates the guard and seeds it into the registry.
   - Nothing reads it yet.
2. **The switch.**
   - `OracleFacet` forwards to the guard.
   - The Diamond's pricing setters and storage are retired.
   - Tests and scripts configure the guard.
3. **#3268.** The vaults read the guard, at an address fixed in the vault
   code, for the outflow bound.

Everything ships at the fresh deploy (pre-live). There is nothing to migrate.
