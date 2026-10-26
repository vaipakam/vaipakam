# Vaipakam Feed Registry (#2880)

Status: design, owner decisions recorded below. Fresh deploy only (pre-live).

## 1. The gap

On the retail path an ERC-20 is priced in one of two ways. WETH is priced from
the ETH anchor feed. Every other asset goes through a Chainlink Feed Registry,
`getFeed(asset, denomination)`, either directly or as asset/ETH × ETH/USD. If
neither works, the read reverts `NoPriceFeed` and the asset is illiquid.

Chainlink runs that registry on Ethereum mainnet only. Base, Arbitrum,
Optimism and Polygon have none. So on every L2 mainnet, every asset except WETH
would be unpriced. Testnets hide this, because the testnet-mocks rig deploys a
`MockChainlinkRegistry`.

## 2. Decisions

| # | Decision | By | When |
|---|---|---|---|
| D1 | Build it now, before the all-waves fresh deploy, so testnets run the real registry shape too | owner | 2026-10-26 05:38 UTC |
| D2 | Token binding source: _pending card_ (recommended: a reviewed per-chain bindings file in the repo) | owner | — |
| D3 | Cross-check every binding against CoinGecko and CoinMarketCap as well as the chain's official token list | owner | 2026-10-26 05:41–05:46 UTC |

## 3. What Chainlink's directory gives, and what it does not

The source is Chainlink's official feed directory, the JSON behind
docs.chain.link/data-feeds/price-feeds/addresses (one file per network). On
2026-10-26 the Base mainnet file listed 188 feeds:
- 114 price feeds quoted in USD and 23 in ETH, plus proof-of-reserve,
  macroeconomic and exchange-rate products;
- by risk category: 68 low, 29 medium, 7 high, 73 custom, 3 new, 3 deprecating
  and 5 uncategorised;
- 34 SVR variants, which are extra proxies of a pair that already has a
  standard proxy. For example, "USDC / USD" has a standard proxy and several
  SVR proxies.

Each entry carries a proxy address, a pair name such as "LINK / USD", decimals,
a heartbeat, a category and a base-asset name. **No entry carries a token
contract address.** Tying a feed to a token on a given chain, such as native
USDC vs bridged USDbC, is therefore a separate step. It is the one step where a
mistake misprices, so the design puts its controls there.

## 4. The contract: `VaipakamFeedRegistry`

One per chain, owned by the chain's admin and later the Timelock.

**Interface the Diamond reads.** `getFeed(address base, address quote)`, the
call `OracleFacet._registryFeed` already makes. The denomination sentinels are
Chainlink's: USD `0x…0348` and ETH `0x…eEeE`. The Diamond then points
`chainlnkRegistry` at this contract on every chain, Ethereum included, so there
is one shape everywhere and no oracle-code change. A missing pair returns zero,
which the Diamond already reads as "no feed". The registry fixes Chainlink's USD
and ETH sentinels as constants, and `ConfigureOracle` sets the Diamond's two
denominators from them, so the Diamond and the registry can never key a lookup
differently (the old per-chain denominator variables are retired).

**Entry.** For each (token, quote): the feed proxy, its decimals, its pair name
as Chainlink publishes it, its directory risk category, and the SHA-256 and
date of the directory file it was checked against.

**Checks on every add or replace,** for what the chain can prove:
- the token is a contract that answers `decimals()`;
- the feed answers `decimals()` with the declared value;
- the feed answers `description()` with the declared pair name;
- the feed answers `latestRoundData()` with a positive answer updated within
  its declared heartbeat.

The contract cannot prove which token a pair name means. That is the binding,
section 5.

**Roles.** These follow the sanctions list's split (owner decisions
2026-10-18):

| Role | Who | May |
|---|---|---|
| owner | admin, then the Timelock | appoint and remove the proposer and the guardian; set the delay inside its bounds |
| proposer | the feed service's key | propose adds, replaces and removals; execute a proposal whose delay has passed |
| guardian | the Pauser Safe | veto any pending proposal |

The veto goes to the Pauser Safe rather than the governance Safe because it is
a stop-only power, the same class as the pause that Safe already holds, and
the handover gate already requires every guardian to be the Pauser Safe. The
handover rotates it there before ownership leaves the admin (a testnet deployed
without a Pauser Safe starts with the admin as guardian).

**Every change waits a delay the Safe can veto.** That covers adds, replaces
and removals alike. The delay is bounded at 1–14 days on a production chain and
defaults to 3 days. A testnet chain (`TestnetChains`) may set 0, so the mock
rig can register its feeds in the same transaction batch.

There is no instant removal. Unpricing a collateral asset stops health-factor
reads on its open loans, which is worse than a stale price, because a stale
price at least reverts by the oracle's own freshness rule. A Chainlink
deprecation is handled as a replace onto the successor proxy, proposed ahead of
the shutdown date the directory publishes.

**Transparency.** Every proposal, veto, execution and resulting entry change
emits its own event. The live set can be enumerated (`entriesPage`), so the
service and any reader can diff it against the bindings file from state at one
block. A view reports the directory hash and date each entry was last checked
against.

## 5. Bindings (assuming D2 = reviewed file)

`contracts/deployments/<slug>/feed-bindings.json` is the reviewed record, one
per chain. Each binding lists the token, quote, feed proxy, pair name,
category, and the sources that agreed on the token address.

A drafting tool, `packages/contracts/scripts/chainlink-feed-bindings.mjs`,
writes the file:
1. It reads Chainlink's directory for the chain. It keeps price feeds quoted in
   USD or ETH, standard proxies only (no SVR variants), in the low or medium
   category, with no shutdown date. High, new and custom feeds enter only as an
   entry the owner adds by hand, marked as such.
2. For each feed it resolves the base asset to a token address from three
   sources: CoinGecko's per-chain contract addresses, CoinMarketCap's
   (`/cryptocurrency/info`, which also answers the reverse lookup by address),
   and the chain's official token list. That is the Superchain token list for
   Base and Optimism, Arbitrum's bridge token list, or the issuer's own page,
   such as Circle for USDC.
3. It drafts a binding only when all three name the same address. A
   disagreement, a missing entry or an ambiguous symbol is written to the
   file's `review` section with the conflicting answers, and nothing is drafted
   for it.

A binding reaches chain only after the file merges by PR review. API keys for
CoinGecko and CoinMarketCap live only with the drafting tool.

**On-chain backstop that already exists.** An asset is liquid only if its own
DEX pool's spot price agrees with the oracle price. A binding that pointed a
feed at a token trading at a different price therefore fails closed at the
liquidity check, without mispricing a loan. Two tokens at the same price
(native vs bridged USDC) pass that check, which is why the binding itself is
reviewed.

## 6. The service

`ops/feed-registry/` follows `ops/sanctions/`: its own key, env file and units,
installed from one release on the always-on machine. Once a day it:
1. reads the merged bindings file at the release commit, the live registry at
   the finalized block, and Chainlink's directory;
2. proposes every difference between the bindings and the registry;
3. executes every proposal whose delay has passed and that nobody vetoed;
4. reports per chain to the journal and the ops Telegram chat, including any
   feed whose directory entry has a shutdown date or a moved proxy, so the
   bindings file gets a replace before the feed stops.

It never proposes anything not in the merged bindings file.

## 7. Launch readiness

The launch step gains a requirement that the Diamond's registry is set and is
a contract answering `getFeed`. A production chain's declaration also carries
the registry address, so the Safe reviews which registry the chain prices
through.

## 8. Testnets

`DeployFeedRegistry` sets a testnet's delay to `FEED_REGISTRY_DELAY_SECONDS`
(0 when unset). The testnet-mocks rig, the Anvil bootstrap's liquidity mocks
and the e2e fixture register their mock feeds into the chain's real registry
by one owner proposal executed at once (`TestnetFeedRegistration`). Their
feeds are `MockChainlinkPairFeed`s, which answer `description()`.
`MockChainlinkRegistry` stays only as a unit-test double and for the
stand-alone dev flow scripts that build a throwaway Diamond; nothing that
reaches a chain uses it.

## 9. Build order

1. Contract, deploy wiring (`DeployFeedRegistry` in every contracts phase,
   `ConfigureOracle`, the mock rigs, the handover and its gate), tests and
   spec. The launch-readiness check (section 7) lands with it once #2747's
   readiness change is on main, since both edit the same check list.
2. Drafting tool and the first bindings files.
3. Feed service.
4. #2745 on top: secondary oracle keys come from the registered feed's pair
   name, with an optional per-token pin.
