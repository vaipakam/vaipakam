# Vaipakam public data feed (v1)

The indexer serves a small, versioned, read-only subset of its data for
anyone to use: the open offer book, loans and their states, the agreed rates
of this platform's own past loans by pair and term, and the totals the transparency page shows. This
page is the feed's documentation. The feed also describes itself: a `GET` of
the prefix returns the same catalogue as JSON.

```
GET https://<indexer origin>/public/v1            the catalogue
GET https://<indexer origin>/public/v1/<route>    one route, wrapped
```

## What the feed is for, and what it is not

Every figure the feed serves is a record of something that happened on
chain, read from the platform's own contract events as the indexer recorded
them. **No figure is the platform's rate, a benchmark, advice or an offer.**
Every response repeats that notice, and a caller who republishes a figure
should keep it.

The feed serves only chain-derived records. Nothing the platform keeps
privately for a wallet (goals, alert settings, watched loans, the Telegram
link) is ever served. The per-wallet convenience reads the app uses for one
wallet's own page (claimables, notifications, loans by participant) are
chain data too, but they are not part of the feed. Addresses appear exactly
as they do on chain.

## Versioning

The prefix carries the version: `/public/v1`. Within v1:

- a new route, or a new field inside a route's `data`, may be added;
- an existing route is never removed, renamed or reshaped, and no field is
  removed or given a new meaning. A change of that kind is a new version,
  served beside v1 under its own prefix.

Every response, including an error passed through from a route, carries the
header `X-Feed-Version: v1` or the `version` field. A path under the prefix
that is not one of the routes below answers `404` with
`{"error": "not-in-feed"}`.

## The envelope

A successful answer is wrapped:

| Field | Meaning |
| --- | --- |
| `version` | `"v1"` |
| `chainId` | the chain answered for |
| `asOf` | `{ block, scannedAt }`: the block the indexer had reached on that chain when the read began, and the time (Unix seconds) it recorded reaching it. `null` when the indexer has not yet scanned that chain. |
| `about` | `{ what, source, excludes[], cacheSeconds }`: what the route returns, where its figures come from, what they leave out, and how long the answer may be cached (`null` when the route states no cache time) |
| `notice` | the notice above |
| `data` | the route's own answer |

**Reading `asOf`.** The block is read *before* the data, so every record at
or below that block is in the answer. The answer may also include a little
more than that, if the indexer moved on while the read ran. It is a floor,
never a ceiling. The indexer follows the chain a few blocks behind its head,
so a very recent transaction may not appear yet.

## Choosing a chain

Every route takes `?chainId=<id>`. Without it the indexer's default chain is
used. A chain the indexer does not serve answers `503`. The chains served
today are testnets; the platform is not live on any mainnet.

## Limits

- **120 requests a minute per IP address**, one budget across all feed
  routes together. Cloudflare counts it per location, so the figure is
  approximate. Over the limit the feed answers `429`, with a body stating
  the limit and the period and a `Retry-After` header. If the limiter
  itself is unavailable the feed refuses with `503` rather than serving
  unmetered.
- Each route states its own cache time in `Cache-Control` and in
  `about.cacheSeconds`. A caller polling faster than that receives the same
  answer.

## Routes

| Route | What it returns | Query parameters |
| --- | --- | --- |
| `/offers/active` | The open offer book, paginated. | `limit`, `before`, `lendingAsset`, `collateralAsset`, `durationDays`, `excludeExpired`, `excludeSaleVehicles`, `excludeOffsetVehicles` |
| `/offers/recent` | Recently created offers. | `limit`, `before`, `lendingAsset`, `collateralAsset`, `durationDays` |
| `/offers/markets` | Each pair and term (lending asset, collateral asset, term) with open offers, and their open-offer aggregates. | |
| `/offers/stats` | Open-offer counts and totals. | |
| `/offers/{id}` | One offer by id. | |
| `/loans/active` | Active loans, paginated. | `limit`, `before` |
| `/loans/recent` | Recently opened loans, optionally for one pair and term. | `limit`, `before`, `excludeSaleVehicles`, and together `lendingAsset`, `collateralAsset`, `durationDays` |
| `/loans/stats` | Loan counts by status and the totals the transparency page shows. | |
| `/loans/rate-candles` | The agreed rates of this platform's own past loans for one pair and term, by interval (open, high, low, close). `fills` is each interval's sample size. | `lendingAsset`, `collateralAsset`, `durationDays` (all required), `interval` (`1h`, `4h`, `1d`), `range` (`7d`, `30d`, `90d`, `all`) |
| `/loans/{id}` | One loan by id, with its status. | |

Each route takes only the parameters listed (and `chainId`). Any other
parameter is refused with `400` and `{"error": "unknown-parameter",
"parameters": [...], "allowed": [...]}` naming it.

Each route's `data` is exactly the answer the indexer's own route at the
same path gives the app; the indexer's README describes those shapes. The
field names each route returns in v1 are pinned by a test: a field may be
added, never removed or renamed.

### What the figures leave out

Each response's `about.excludes` lists this for the route. In short:

- **Open offers** leave out cancelled, filled and expired offers, and
  gasless signed offers, which live in their own book and are not indexed
  here.
- **Loan totals and rate candles** leave out the temporary loan a lender's
  sale creates: it is a change of holder, not a new loan.
- **Rate candles** also leave out loans with an NFT on either side, and
  loans whose agreed terms the chain has not yet confirmed (these are
  counted, as `unplaced`, but not drawn). An interval with no filled loan
  has no figure; nothing is filled in for it.
- **Recent loans for one pair and term** leave out loans whose agreed terms the
  chain has not yet confirmed.

## Errors

| Status | Meaning |
| --- | --- |
| `400` | a parameter the route does not take (named in the body), or a value outside what the route accepts |
| `404` | not a feed route, or the offer or loan does not exist |
| `429` | the per-IP limit is spent; the body states the limit and period, and `Retry-After` says when to try again |
| `503` | the chain is not served, or the feed cannot read its data right now |

An error from a route is passed through with its own body and the
`X-Feed-Version` header. Nothing is wrapped around it.

## Browsers

Every route answers with `Access-Control-Allow-Origin: *` and accepts an
`OPTIONS` preflight, so a page on any site can read the feed directly.
