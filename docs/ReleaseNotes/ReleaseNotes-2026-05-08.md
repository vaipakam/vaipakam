# Release Notes — 2026-05-08

The post-pivot architectural-optimisation push the user signed
off on at the end of the 7th. Six commits across two calendar
days landed a coherent thread: the dashboard's loans table
moved onto a new server-side bundle reader, the public Cloudflare
staging surface was provisioned end-to-end, the on-chain analytics
layer's walking patterns were swept out in favour of pre-built
per-user indexes, two new analytical getters were added, and the
keeper-driven swap path was hardened to match what 0x and 1inch
actually require off-chain. No frontend-visible feature work
today; this is foundations for the next phase.

## Dashboard loans table — single bundled read

The user dashboard's "your loans" table previously fanned out
into one contract call per loan to assemble its row state (status,
counterparty, principal, collateral, accrued interest, health
factor, side). On a wallet with N loans this was N+1 round trips
and a stair-step render as the rows trickled in. The replacement
reads the entire table from a single getter that returns each
row already tagged with the lender / borrower side, so the
dashboard receives a fully-populated payload in one round trip
and renders the whole table at once. The header subtitle that
used to say "lender stake total" now reflects whichever side the
user has more capital on, and the empty-state copy was refreshed
to match the unified-table framing. No new fields surfaced — the
gain is purely first-paint speed.

## Cloudflare staging surface — five Workers + archive database

The public testnet operator surface is now provisioned end-to-end
on Cloudflare under the chosen names. Five Workers stand at their
own subdomains, each with a clean separation of concern so a
compromise of one doesn't bleed credentials or write authority
into the others:

- **labs.vaipakam.com** — the marketing / docs / overview site.
  Read-only. No chain credentials. Will host the public guides
  + the buy-VPFI page once the consolidated content lands there.
- **defi.vaipakam.com** — the in-app surface (Dashboard, Loans,
  OfferBook, NFT Rentals, Settings). Reads from the chain and
  from the archive database; never writes either. User
  signatures land via the wallet, not via the Worker.
- **agent.vaipakam.com** — the read / index Worker. Hosts the
  diagnostics-drawer endpoints, the indexer status snapshot, the
  cursor-advance heartbeat, plus the per-user offers / loans /
  activity reads that paginate over the archive database. Holds
  read-only API keys for the chain RPC providers and for the
  archive database; no signing keys, no swap-aggregator
  credentials.
- **keeper.vaipakam.com** — the write / act Worker. Owns the
  autonomous keeper that fires liquidations and offer matching.
  Holds a signing key (kept as a Cloudflare secret) and the
  swap-aggregator API keys it needs for off-chain quote fetching.
  Strict least-privilege: it does not read user-side state, does
  not serve any frontend traffic.
- **indexer.vaipakam.com** — the chain-to-archive ingester. Runs
  the cursor walk, decodes events, writes rows into the archive
  database. Holds chain RPC credentials + archive database write
  credentials; doesn't sign chain transactions, doesn't serve
  frontend traffic.

The shared archive database is a Cloudflare D1 instance named
`vaipakam-archive`. Three custom domain bindings are active.
All five Workers currently serve a placeholder 503 from the
bootstrap deploy — actual code lands as the source-tree refactor
to the apps/ + packages/ layout completes in a later pass.
Secrets are loaded for everything except the Blockaid API key
(pending vendor approval) and the Push Channel private key
(provisioned later in the day).

## Walking-list optimisation sweep — every user-keyed view now O(results)

The on-chain analytics layer has two ways to enumerate user-side
state: walk the global active set and filter for matches, or read
a per-user index that's maintained at lifecycle edges. Until this
sweep landed, several read paths were doing the former — including
the four most-trafficked user dashboard views (your active loans,
your active offers, your loan summary, your NFTs in escrow). On a
testnet with ~100 active loans this is invisible; at the scale we
expect on mainnet it would be a chronic gas / latency cliff.

The sweep audited every read in the metrics + dashboard surface
and switched ten sites to read from the per-user index instead.
The on-write hooks that maintain those indexes were already in
place — what was missing was disciplined consumption. As part of
the sweep, the test scaffold helpers used by every metrics test
were patched to mirror the production hooks, so any future
analytic getter added against these indexes is automatically
exercised under the test mutator path. Two helper functions in
the metrics dashboard facet that walked the global active list
became unreachable after the switchover and were deleted.

User-visible effect: identical numbers, but each "list my loans"
or "list my offers" call now scales with the number of rows the
user actually has, not with the protocol's total active set.

## New analytical getter: active offers by asset pair

The OfferBook's two-filter UX (lending asset + collateral asset)
needed a contract-side primitive that returned active offers
filtered by both legs at once. The walking implementation would
have iterated every active offer per page-load — fine for our
testnet's offer count but not for a populated book. A new
per-asset-pair index is now maintained alongside the existing
global active-offers list: every offer creation pushes the
offer's id into the (lendingAsset, collateralAsset) bucket; every
acceptance / cancellation removes it via the same swap-and-pop
discipline as the global list. The new pageable getter reads
that bucket directly, so an OfferBook page-load returns only
matching offers and only the page the user is looking at.

The getter is asymmetric on purpose: there is no "all" sentinel
for either filter. The OfferBook UI will require both legs to be
chosen explicitly (with a per-chain default seeded in the
frontend config), which simplifies the UX and lets the contract
keep the index keying tight.

## New analytical getter: full per-user offers, struct variant

A second getter shipped alongside the asset-pair one: a struct-
returning variant of the existing per-user paginated offers view.
The original returns offer ids only, which forces the frontend to
fan out a per-row detail call to render the row. The new variant
returns each row's full struct in one round trip, eliminating
the multicall fan-out for any per-user offer detail table —
useful for the dashboard's "your offers" tab and for the upcoming
activity-history view. Both variants cohabit; callers pick by
the table they're rendering.

## Aggregator adapter security refactor — allowance target split

The keeper-driven liquidation path forwards opaque calldata that
the keeper bot fetched from 0x or 1inch. The previous adapter
shape used a single pinned router address for both the ERC20
allowance the adapter granted before the swap AND the call
destination the swap was forwarded to. That shape works for
1inch, where the same AggregationRouterV6 address handles both
roles, but it is wrong for 0x v2 by design — and dangerously so.

0x's v2 architecture deliberately separates the two:

- The **AllowanceHolder** is the address you grant ERC20
  approvals to. It is canonical and pinnable per chain — the
  same address on every Cancun-fork chain we deploy to, with one
  alternate on Mantle.
- The **Settler** is the address that actually executes the
  swap. It rotates with each release, varies by route type
  (taker-submitted, metatransaction, intents, bridge), and is
  read out of each individual quote response.
- 0x's contracts documentation is explicit that approving the
  Settler instead of the AllowanceHolder is unsafe ("potential
  loss of tokens or exposure to security risks").

The refactor matches that shape. Each adapter now carries the
allowance address as an immutable construction parameter and
holds a separate owner-managed allowlist of permitted swap-call
destinations. Approvals always land on the immutable allowance
address — the keeper cannot redirect them. Each swap call
checks that the keeper-supplied destination is on the allowlist
before forwarding the call, which means a compromised keeper
cannot pivot funds to an arbitrary contract. When 0x ships a
new Settler, the operator pushes the new address to the
allowlist; when an old Settler is deprecated, the operator
removes it. The adapter refuses to remove the last entry to
prevent an accidentally bricked adapter that would have to be
re-seeded by the owner anyway.

The 1inch adapter inherits the same shape even though the
upstream venue currently coalesces both roles. The strict-
equality check on the allowlist still defends against a
compromised keeper injecting a rogue destination, and the shape
is forward-compatible if 1inch ever follows 0x's lead and
splits the two roles in a future major version.

User-visible effect: none today. The adapters are not yet wired
into the deployed liquidation path; this work is preparatory.

## Quote-service repacking — three consumers brought in line

Same-day follow-up to the adapter refactor: every off-chain
consumer that builds a swap-call for the new adapter now packs
the destination address alongside the calldata in the format the
on-chain adapter expects. Three repos touched, plus one doc
correction:

- **Reference keeper bot** — the autonomous liquidation bot's
  quote orchestrator now reads both the destination and the
  calldata from each 0x and 1inch response and bundles them
  together. A small validator rejects responses with a malformed
  destination so a fetcher hiccup can't ship a half-formed
  AdapterCall. The same packer is the single source of truth
  for both venues so they cannot drift on the wire format.
- **Frontend liquidator UI** — the in-app liquidate button's
  quote service got the same treatment. The AdapterCall type's
  jsdoc was updated alongside the implementation so a future
  contributor sees the new shape directly on the type, not
  buried in a separate doc.
- **Cloudflare hf-watcher** — the autonomous keeper inside the
  Worker reads the same shape. Symptoms of a Settler rotation
  that hasn't yet been added to the on-chain allowlist would
  surface in this Worker's logs first, so getting the encoding
  right here is what the Incident Runbook's §6 rotation-lag
  procedure detects against.
- **Quote-proxy doc** — the pass-through proxy that fronts the
  0x and 1inch APIs from the watcher's edge had its response-
  shape comment updated so the next reader doesn't see a stale
  description that says only `transaction.data` is consumed.

User-visible effect: still none. This is the missing wire-format
piece between the on-chain adapter refactor and a deployed
liquidation that uses it. Once the adapters are seeded with the
live Settler set on a chain (per the Deployment Runbook), the
on-chain side, the autonomous keeper, the in-app liquidator, and
the reference bot will all speak the same encoding without any
further changes.

Typecheck clean across all three repos. The watcher will pick up
the new shape on the next Worker deploy; the bot ships at next
release; the frontend rolls in with the next bundle.

## Test coverage delta

Twelve new contract tests landed alongside this thread:

- Three for the asset-pair active-offers getter (single pair,
  pagination across the bucket, empty bucket).
- Three for the struct-returning per-user offers getter (full
  rows in push order, page clipping with stable total, empty
  user).
- Six for the aggregator adapter security refactor (rejection
  of an unallowlisted destination, three constructor-validation
  rejection paths, owner-gated add / remove with a last-entry
  protection, plus a structural proof that approvals land on the
  allowance address and never on the swap destination).

The metrics test suites stayed at 25 / 25 + 12 / 12 after the
walking-list sweep, with the test mutator scaffold updated so
every future analytic getter that reads a user-keyed index is
automatically exercised.

## OfferBook 2-filter UX — required-pair shape with sort across the entire bucket

The OfferBook page now requires the user to pick BOTH a lending
asset and a collateral asset before showing any rows — no more
"all assets" sentinel. Each supported chain ships a sensible
default pair so the page lands non-empty without user input:
USDC × WETH on Base / Ethereum / Arbitrum / Optimism / Sepolia /
Base Sepolia, USDC.e × WETH on Polygon zkEVM, USDT × WBNB on
BNB. Testnets without canonical addresses fold to "user must
pick" rather than show a broken default.

Three architecturally interesting pieces ship behind this UX:

- **Skinny ranking getter on-chain.** A new view function returns
  every active offer in the (lending, collateral) bucket as a
  thin row of the rank-relevant fields only — id, side
  (lender/borrower), principal min/max, rate min/max, duration,
  creation timestamp. Roughly 256 bytes per offer in the encoded
  payload, returned in one round trip. The contract avoids the
  alternative of maintaining sorted indices on-chain (which would
  cost extra gas on every offer create / accept / cancel for what
  is purely a read-side optimisation), instead handing a thin
  fan-out array to the client and letting JavaScript do the
  sorting.

- **Sort across the entire bucket.** Because the skinny call
  surfaces every active offer in the pair without per-offer
  hydration, the frontend can sort by any direction (rate ASC /
  DESC, principal ASC / DESC, duration ASC / DESC, recency) on
  the full data set in JavaScript memory. The user toggling sort
  directions burns zero RPC calls — only the page slice that's
  actually being rendered ever gets hydrated to its full Offer
  shape via a multicall. The both-tab (depth-chart layout that
  shows both lender and borrower offers around the market
  anchor) keeps its existing "top-N per side" rendering and does
  NOT expose a sort UI; sort applies on the lender-only and
  borrower-only tabs where the user is browsing a single side
  sequentially.

- **Configurable hydration cap, env-tunable.** The hydration
  multicall (the per-page-load batch that fetches full Offer
  structs) is now env-tunable via `VITE_OFFER_BOOK_PAGE_SIZE`
  (default 200, clamped to a sane range). Going from 200 to 500
  is NOT an RPC-quota concern — both are exactly one multicall,
  request-priced by every public RPC provider — but bandwidth
  and first-paint latency on slow connections motivate keeping
  the default low. Operators on chains with consistently large
  pair buckets can dial it up without a code change. Documented
  in the frontend env-template alongside the existing knobs.

- **Near-real-time updates across the whole protocol.** When ANY
  user globally creates / accepts / cancels an offer matching
  the current pair, the existing log-index event stream catches
  it within seconds and the OfferBook invalidates the skinny-
  ranking cache so the new row appears on the next render. Same
  near-real-time behaviour the page had before, just now bound
  to the pair filter rather than the global active set.

- **AssetPicker clear behaviour adjusted for the required-pair
  invariant.** The X button on the lending / collateral filter
  pickers used to clear the field to empty; it now resets to the
  chain default. Picking a different non-empty asset still works
  the same way. This keeps the required-pair shape without
  breaking the AssetPicker primitive, which is shared across
  many other surfaces (offer creation, allowance management,
  etc.) where clear-to-empty is the right behaviour.

User-visible effect today: the page lands on a meaningful
default pair on every supported mainnet, sorts across the full
bucket without RPC pressure, and surfaces new offers
near-instantly as they appear. The user-chosen sort UI plumbing
on the single-side tabs is the next chunk; the skinny call
already carries every sort key, so it's a UI-only addition.

## Test coverage delta (additions today)

Three new contract tests for the skinny ranking view:

- Returns the right shape with mixed lender / borrower / range
  offers in one bucket.
- Empty pair returns empty array + zero total.
- Range Orders min/max fields round-trip correctly when an
  offer's max diverges from its min.

Brings the MetricsFacetTest suite to 28 + 3 = 31 passing.

## What's queued behind today

Four things, in priority order:

1. **OfferBook sort UI** on the lender-only and borrower-only
   tabs: dropdown or pill-row for rate ASC / DESC, principal
   ASC / DESC, duration ASC / DESC, recency. The skinny call
   already carries every sort key — this is a UI-only
   addition with zero RPC pressure.
2. **Source-tree refactor** to the monorepo apps/ + packages/
   layout the Cloudflare staging Workers were provisioned
   against. Each Worker becomes its own app folder; shared
   utilities move into packages.
3. **Cancelled-offer capture in the archive database**: a
   schema migration adds a cancellation timestamp column, the
   chain indexer updates rows on cancel rather than dropping
   them, and a weekly retention cron prunes the long tail.
   Frontend gets a "view activity" link to surface cancelled
   offers without storing them on chain.
4. **GitHub Actions matrix deploy** for the five Workers, so
   each app's commit-to-Cloudflare path is wired and parallel.

## Documentation discipline

Per the user-declared "Document every completed task functionally
under /docs/" rule, this entry continues the daily-cadence
release-notes thread. Plain language, no code blocks or facet /
selector / interface jargon, so a reader on the project's
product or ops side can follow what changed and why without
having to read source.
