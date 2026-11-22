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

Every table the feed reads is one the indexer rebuilds from the chain alone
(the indexer's table classification calls these replay-derived). It never
reads a table born off chain, or one that mixes the two. A test holds both
rules, and records the tables each route reads.

Two routes take an address, each exactly one: the repayment record, and the
rental `may-use` read. A route that takes an address joins the feed only
when a design names it public, and none lists, ranks, searches or filters
addresses by their record.

The two rental reads are public because they return only what the chain
already publishes: every row restates one `VaultRentalUpdated` event, and an
ERC-721 renter can also be read from the owner's vault. They do not hide who
rents. `by-collection` lists every renter of a collection, and anyone can
read every collection, or the events themselves, and work out what one
address rents. Both answer from the event-built rental table, reading
beside it only the latest block time the index recorded, so they can never
join anything the platform keeps for a wallet; a test holds that.

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
| `/offers/active` | The open offer book, paginated. Offers past their expiry, and offers whose expiry the index has not read yet, are always left out (the feed sets this itself; it is not a parameter). | `limit`, `before`, `lendingAsset`, `collateralAsset`, `durationDays`, `excludeSaleVehicles`, `excludeOffsetVehicles` |
| `/offers/recent` | Recently created offers. | `limit`, `before`, `lendingAsset`, `collateralAsset`, `durationDays` |
| `/offers/stats` | Open-offer counts and totals. | |
| `/offers/{id}` | One offer by id. | |
| `/loans/active` | Active loans, paginated. | `limit`, `before` |
| `/loans/recent` | Recently opened loans, optionally for one pair and term. | `limit`, `before`, `excludeSaleVehicles`, and together `lendingAsset`, `collateralAsset`, `durationDays` |
| `/loans/stats` | Loan counts by status, and the principal lent per lending asset in that asset's own smallest units. `counting` states how it counted (see below). | |
| `/loans/rate-candles` | The agreed rates of this platform's own past loans for one pair and term, by interval (open, high, low, close). `fills` is each interval's sample size. | `lendingAsset`, `collateralAsset`, `durationDays` (all required), `interval` (`1h`, `4h`, `1d`), `range` (`7d`, `30d`, `90d`, `all`) |
| `/loans/{id}` | One loan by id, with its status. | |
| `/repayment-record/{address}` | A count of how the loans and rentals one address held as borrower or renter here closed, with the statements of what it is and is not. An address with no history gets an empty record, not an error. The rules are in [`RepaymentRecordDerivation.md`](RepaymentRecordDerivation.md). | |
| `/rentals/by-collection` | Each active rental of one collection: `rentalId`, `tokenId`, `user`, `expires`, `quantity`, and the `owner` of the vault holding the item. 200 a page by rental id; pass `nextCursor` back as `cursor`. | `collection` (required, exactly one), `tokenId`, `cursor` |
| `/rentals/may-use` | The active rentals in one collection that name one address as `user`: what that address may use there, until when, and how many units. `truncated` is `true` past 500. | `collection` and `user` (both required, exactly one each), `tokenId` |

**Active**, for both rental reads, means not cleared and with an expiry not
before `activeAt`: the vault's own comparison (`expires >= activeAt`). Each
answer states `asOf` (`block`, the block the clearings are known through, and
`chainTime`, the latest block time the index recorded at or below it) and
`activeAt`, the later of the server's time and `chainTime`. A server clock
behind the chain therefore cannot show a rental the chain already treats as
ended. An expiry fires no event, so a rental past its expiry is left out even
when the indexer has seen no block since. The feed can say "ended" a few
seconds before the chain's newest block does; that is the safe side.
`chainTime` is a floor of the `asOf` block's own time, which the index does
not store. To read it the rental routes read `activity_events` for that one
value only, the network's largest recorded block time at or below `asOf`;
they read the rental table, the cursor and that value, and every one of
those is rebuilt from chain events.

When rentals first reach a network the indexer has already scanned, the
rental table is filled from the rental events already indexed, a bounded
step per indexer pass, each resuming where the last stopped. Until
that has finished, both rental reads answer `503` with
`{"error": "rentals-index-building"}` rather than a list that could leave
rentals out. For an ERC-1155
item several rentals of one token can be active at once, one row each.

The rental reads refuse a repeated `collection` or `user`, a list, and a
wildcard, with `400` and `{"error": "one-value-required", "parameter": ...}`;
a missing one is `{"error": "missing-parameter", ...}`.

Each route takes only the parameters listed (and `chainId`). Any other
parameter is refused with `400` and `{"error": "unknown-parameter",
"parameters": [...], "allowed": [...]}` naming it.

Each route's `data` is exactly the answer the indexer's own route at the
same path gives the app; the indexer's README describes those shapes. The
field names each route returns in v1 are pinned by a test: a field may be
added, never removed or renamed.

### How the figures count

Three rules hold for every figure the feed publishes.

1. **No value total.** The index reads no price, so it never adds amounts of
   different assets together. Each amount is stated in its own asset's
   smallest units, on its own line, and `counting.valueTotal` is always
   `null`.
2. **One address on both sides.** A loan whose opening event names the same
   address as lender and borrower is left out of rate figures and counted on
   its own line (`counting.oneAddress`). It is judged on the opening event
   only: a later sale or handover moves a loan neither in nor out. The rule
   sees one address on both sides only; it cannot see two addresses that
   belong to one person. A loan whose opening parties cannot be established
   is left out of rate figures too and counted on its own line
   (`counting.openingPartiesUnknown`); it is never assumed to have two
   parties.
   The repayment record applies the same test to the loans it counts and
   states both counts under `leftOut`.
3. **No mean across assets or terms.** Every rate figure is per lending asset
   and term range. No figure averages the rates of different assets or terms
   together.

Each figure carries a `counting` object that states these in words, and the
envelope states the block, as above.

### What the figures leave out

Each response's `about.excludes` lists this for the route. In short:

- **Open offers** leave out cancelled, filled and expired offers, and
  gasless signed offers, which live in their own book and are not indexed
  here.
- **Loan totals and rate candles** leave out the temporary loan a lender's
  sale creates: it is a change of holder, not a new loan.
- **Rate candles** also leave out loans whose opening event names one
  address on both sides (counted as `oneAddress`) and loans whose opening
  parties cannot be established (counted as `openingPartiesUnknown`;
  `leftOutAtLeast` is `true` when the two counts stopped at their shared cap
  of 1,000 and are lower bounds), loans with an NFT on either side, and
  loans whose agreed terms the chain has not yet confirmed (these are
  counted, as `unplaced`, but not drawn). An interval with no filled loan
  has no figure; nothing is filled in for it.
- **Recent loans for one pair and term** leave out loans whose agreed terms the
  chain has not yet confirmed.
- **The repayment record** covers this network only, from where its index
  begins (`historyBegins`), and leaves out the temporary loan a lender's
  sale creates and anything outside this platform. Loans opened with one
  address on both sides, and loans whose opening parties are unknown, are
  counted under `leftOut` rather than in any class, and so are loans whose
  holder at a needed moment cannot be told apart because two changes of the
  borrower position share one block (`leftOut.holderUnresolved`). A payment
  by another address counts for the holder. The fees the address paid are not stated
  yet (`feesPaid.stated` is `false`, with the reason), never shown as a
  partial sum.
- **The rental reads** leave out cleared rentals and rentals past their
  expiry. They form no rent figure; when one is first built from the rental
  table it follows the same one-address rule as the loan figures.

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
