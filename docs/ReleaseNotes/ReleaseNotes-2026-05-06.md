# Release Notes — 2026-05-06

Post-rehearsal hardening pass. Three contract follow-up items shipped,
the watcher's offer + loan indexing pipeline rewritten end-to-end to
fix a stub-row data-quality bug at root cause, the per-chain inclusion
gate moved to an explicit allow-list, and the Cloudflare-free-tier
50-subrequest cap engineered around via per-tick round-robin chain
processing. Base Sepolia fully redeployed with the new contracts +
new watcher + new frontend bundle. Arb + OP Sepolia redeploys queued
to land in lockstep so the cross-chain peer wiring stays consistent.
No mainnet deploys.

## Contracts — three follow-ups from the 2026-05-06 rehearsal landed

### Item 1 — VPFIBuyAdapter `getRateLimits()` view function

The `VPFIBuyAdapter` contract on each mirror chain accepts a
`setRateLimits(perRequestCap, dailyCap)` call from the timelock /
multisig owner. Before today there was no symmetric public getter, so
operators had to inspect raw storage slots after the post-deploy
rate-limit ceremony to confirm the values landed. The mainnet-readiness
gate in CLAUDE.md ("BuyAdapter rate limits are a hard mainnet-deploy
gate") couldn't be machine-verified — the deploy script's health
check and the `--phase verify` step were both leaving an operator-
confirmation note instead of a hard-fail.

The new `getRateLimits()` returns both the per-request cap and the
24-hour rolling daily cap as a tuple, mirroring the symmetry of
`setRateLimits`. The deploy-script's step `[5d]` health check and the
mainnet operator's `--phase verify` step `[4]` now read from this
getter and refuse to declare the deploy ready when either cap is
still at the unlimited `type(uint256).max` default. Three new tests
in `VPFIBuyAdapterRateLimitsTest` cover the defaults-to-max state,
the round-trip after `setRateLimits`, and agreement between the new
tuple and the existing per-field public getters.

This view exists on every mirror chain that has a BuyAdapter — Arb
Sepolia, OP Sepolia, and the future Polygon zkEVM / BNB / Polygon
PoS mirrors. Canonical chains (Base / Base Sepolia) don't have a
BuyAdapter so the change doesn't apply there.

### Item 2 — Diamond pause-by-default

Between the deploy script's two `diamondCut` transactions (split
because the full 32-facet cut blows the gas cap) the Diamond is in a
half-cut state — half-2 selectors revert with `FunctionDoesNotExist`
because their facet hasn't been wired yet. Today the only damage from
calling such a half-2 selector is a clean revert. Tomorrow, if a
future change ever adds a fallback that swallows revert reasons, the
half-cut window becomes a foot-gun.

The Diamond is now born paused: `LibPausable.pause()` is the last
write the constructor performs. Every facet entry point gated by
`whenNotPaused` reverts `EnforcedPause` for the duration of the
deploy. The deploy script's new step `[5e]` calls
`AdminFacet.unpause()` after every facet is cut, every initialize call
has run, and the post-cut facet-count assertion has passed — flipping
the protocol back to its normal state in one explicit step.

Mainnet operators who want a multi-eye review window before unpausing
can comment out the step `[5e]` line and run a separate manual
`unpause()` after the `--phase verify` ceremony confirms the post-cut
state.

A new dedicated test file pins this behavior end-to-end: born paused
before any cut, born paused after the AccessControl + AdminFacet cut,
unpause flips the bit, and any `whenNotPaused` selector reverts in
the born-paused state.

### Item 3 — Atomic `transferAdmin` on AccessControlFacet

The legacy role-handover (deploy script step `[6]`) is a sequence of
23 separate transactions: 11 `grantRole` calls to the new admin,
1 `transferOwnership`, 11 `renounceRole` calls in reverse so
`DEFAULT_ADMIN_ROLE` is renounced last. If any of those 23 reverts
mid-flight the diamond's role distribution lands in an inconsistent
half-applied state requiring manual recovery via the
`DeploymentRunbook` §6.

A new external function on `AccessControlFacet` — `transferAdmin(address newAdmin)` —
performs the same end-state in a single atomic transaction:

1. Grants every role in `LibAccessControl.grantableRoles()` to
   `newAdmin` (DEFAULT_ADMIN first).
2. Transfers ERC-173 ownership via `LibDiamond.setContractOwner`.
3. Revokes every role from the caller in REVERSE order, so
   DEFAULT_ADMIN is renounced last (preserves recoverability if a
   future library bug introduces a mid-step revert).

Gated by `onlyRole(DEFAULT_ADMIN_ROLE)` and reverts on
`address(0)` or self-transfer. Eight new tests in
`AccessControlTransferAdminTest` cover the happy-path role + ownership
end-state, the `AdminTransferred(prevAdmin, newAdmin)` event,
former-admin lockout, new-admin can wield, and the three revert
paths.

`PAUSER_ROLE` and `KYC_ADMIN_ROLE` are NOT special-cased here — both
transfer along with everything else. The mainnet pattern in
`MainnetMultisigSetup.md §F.1` expects governance to move those two
roles to a dedicated ops Safe AFTER the transferAdmin call lands, via
timelock-gated grants.

The deploy script's role-handover step `[6]` keeps the legacy 23-tx
flow for now; switching it over to `transferAdmin` is a separate
operational ceremony tracked in `MainnetMultisigSetup.md`.

## Watcher — full pipeline rewrite to fix root-cause stub-row data

A multi-day rehearsal pattern surfaced where the watcher's D1 rows
for offers and loans would land with placeholder values
(`lending_asset = '0x'`, asset_type = 0, durationDays = 0, etc.) that
never healed. The frontend's Dashboard table rendered these as
`"0x...0x"` asset symbols and out-of-bound `1000000000000000000 days`
duration cells. Today's pass closes the bug at root cause and rebuilds
the indexing pipeline around a more cap-friendly shape.

### Inline-fetch on `OfferCreated` and `LoanInitiated`

Old flow: `OfferCreated` event fired → INSERT a stub row with
`lending_asset = '0x'` placeholder → wait for the periodic
`refreshStaleOfferDetails` cron pass to overwrite via `getOfferDetails`.
Race window: if `LoanInitiated` for the same offer fired in the same
cron tick, the loan handler read the freshly-stubbed offer row and
propagated the `'0x'` placeholder into the loan row permanently
(no UPDATE path back-filled it).

New flow: the OfferCreated handler attempts an inline
`getOfferDetails(offerId)` call BEFORE the INSERT. On success, the
row lands with full canonical data immediately — same RPC call count
as before, just shifted earlier; one fewer D1 write per offer (no
follow-up UPDATE). On RPC failure, falls through to the original
stub INSERT and the periodic refresh heals.

Same shape applied to the LoanInitiated handler — `getLoanDetails`
is now used for the FULL loan struct (40+ fields) including asset
metadata. The cross-domain JOIN with the offer row that the loan
handler used to depend on is gone entirely. Loan rows land
self-contained from a single RPC, no offer-row coupling, no
cold-start race.

### `is_stub` column + targeted refresh predicate

The previous refresh predicate — `WHERE chain_id = ? AND
(lending_asset = '0x' OR status = 'active')` — re-fetched every
active offer every cron tick to catch partial-fill `amountFilled`
ratcheting. At scale (hundreds of active offers) that scan blew the
free-tier 50-subrequest cap on every tick.

Today's migration `0008_offer_is_stub.sql` adds an explicit `is_stub`
boolean column to the offers table; `0009_loan_indexes_and_is_stub.sql`
mirrors it on the loans table plus adds three loan-side indexes
(`(chain_id, is_stub)`, `(chain_id, lender_token_id)`,
`(chain_id, borrower_token_id)`, `(chain_id, start_at)` for the TVL
analytics endpoint). Inline-success INSERTs land with `is_stub = 0`;
stub-fallback INSERTs land with `is_stub = 1`; the refresh pass flips
to 0 once canonical data lands. The new predicate is
`WHERE chain_id = ? AND is_stub = 1` — refreshes only the rows that
actually need it.

### Event-driven `OfferMatched` + `OfferClosed` handlers

Range-Orders Phase 1 partial-fill ratcheting is now event-driven
instead of cron-driven. The contract's `OfferMatched` event payload
carries `lenderRemainingPostMatch`, so the watcher can compute the
new `amount_filled = amount_max - lenderRemainingPostMatch` in a
single-field UPDATE, no RPC round-trip. The `OfferClosed` event
maps the contract's three-state close reason
(`FullyFilled / Dust / Cancelled`) to the indexer's status string
in the same UPDATE. Replaces the prior cron-driven sweep.

### Round-robin chain processing + 1-min cron

The Cloudflare Workers free tier caps a single cron invocation at 50
subrequests. The watcher's previous "process all chains in serial in
one tick" architecture spent ~38 subs per chain in worst-case backfill;
3 chains × 38 = ~114 subs, blowing the cap and silently dropping
events past the budget on the second and third chain. Symptom: only
chain 84532 ever wrote its cursor row to D1; chains 421614 and
11155420 never appeared.

The cron now round-robins one chain per invocation via a pointer
stored in `indexer_cursor (chain_id=0, kind='roundrobin')`. Each tick
processes exactly one chain — the next in the sequence. Combined
with a flip of the cron schedule from `*/5 * * * *` to `* * * * *`
(every minute), the per-chain refresh cadence is `len(chains) × 1min`
≈ 3 minutes today (vs the prior 5-minute nominal that frequently
broke).

Per-chain subrequest budget is now ~12 / 50 in worst-case backfill
and ~2 / 50 in steady state. Comfortable margin even at 6 chains.

### `.active-chains` allow-list — explicit chain inclusion gate

Previously the export script that produced the consolidated
`deployments.json` walked every per-chain folder under
`contracts/deployments/`. Stale folders (Sepolia, BNB testnet — old
rehearsals) accumulated and got automatically picked up by the
watcher cron, which then crawled chains the operator had retired.

A new `contracts/deployments/.active-chains` file (one chainId per
line, comments via `#`) is now the authoritative inclusion gate.
Folders for retired chains stay on disk for forensic value (audit
trail of what was deployed when) but stop being crawled by the
watcher and stop appearing in the frontend's chain picker.

The export script reads the file and filters per-chain folders by
the allow-list; folders missing from `.active-chains` are reported
in stderr (`⊘ <name>: chainId X not in .active-chains — skipped`)
and silently dropped from the output JSON. Backward-compatible: if
`.active-chains` doesn't exist, falls through to the old "include
every folder" behavior.

This file is NOT auto-updated by deploy scripts — adding or removing
a chain stays a conscious operator decision (a one-line edit + a
re-export + a watcher redeploy).

## Frontend — keeper-management UI per offer / per loan

The contract's keeper authorization model has three independent
gates: a global per-user master switch, a per-user-per-keeper
action-bitmask whitelist, and a per-offer-per-keeper / per-loan-per-keeper
toggle. The Keeper Settings page already covered the first two; the
third gate had no UI surface, so even users who'd opted into keeper
authority couldn't actually authorize any keeper for any specific
position — defaulted to `false`, and stayed there.

Today's pass adds a `<PerThingKeeperToggles>` component, surfaced
inline on both the offer details page (creator-only, pre-acceptance,
calls `setOfferKeeperEnabled`) and the loan details page (each NFT
holder sees their own whitelist, calls `setLoanKeeperEnabled`).
Empty-state CTA points to the Keeper Settings page when the user
hasn't whitelisted any keepers yet. A warning banner surfaces when
the global master switch is off.

The previous "Manage keepers" deep-link button on offer-list rows
(both the OfferBook and the Dashboard's "Your Offers" card) was
removed. Per-offer toggles now live exclusively on the detail page
where the user is already looking at the specific offer.

The `OfferDetails` page also got a small visual cleanup — every
external-link icon on the page (Position NFT, Principal NFT,
Collateral NFT, First seen block, Creation tx) now uses the same
brand-blue color, opens links in a new tab where appropriate, and
flags the new-tab behavior in tooltips.

## Base Sepolia full redeploy with the new code

The Base Sepolia testnet diamond was rolled fresh end-to-end —
`deploy-chain.sh base-sepolia --fresh` — picking up Items 2 + 3 (Item
1 doesn't apply on canonical chains). Two operational gotchas
surfaced and were worked around:

1. The deploy script's broadcast phase hung 30+ minutes against the
   `drpc.live` Base Sepolia RPC. Same drpc throttling pattern as
   prior rehearsals. Worked around by overriding `BASE_SEPOLIA_RPC_URL`
   to `https://base-sepolia-rpc.publicnode.com` for the deploy run.
2. Step `[5] DeployRewardOAppCreate2` failed on the first attempt with
   `Create2DeployFailed` — the predicted CREATE2 address already had
   bytecode from an earlier rehearsal at the same `REWARD_VERSION`
   salt. Bumped `REWARD_VERSION` from `v1-rehearsal-2026-05-06` to
   `v2-rehearsal-2026-05-06`, re-ran with `--resume` to skip the
   already-completed steps; second attempt landed clean.
3. The deploy-script's step `[7]` Frontend build attempted `vite build`
   under the system's Node 18 default; Vite needs Node 20+ and crashed
   with `ReferenceError: CustomEvent is not defined`. Worked around by
   running the frontend build manually via `nvm` Node 25. The
   underlying script failure was silently swallowed by the deploy
   script's exit-0 propagation — flagged as a follow-up to fix the
   PATH override inside `deploy-chain.sh` itself.

End-state: new Diamond at `0x8C59f0Ebf2AA3F1B19529Cc6C1Ec037342FC7625`,
new Timelock at `0x749677e93D2449590cE5c10e2aeBc1681DC85E99`, new
canonical OFT adapter at `0xaA0418BeBE1c465dE14FEe80C6Bb0aDfdBDED7E6`,
new Buy Receiver at `0x9d1bDA2D7FE05b73BD0A497eb229Ce366D13cA81`. The
watcher has been redeployed with the new diamond address baked into
its `deployments.json`, and the frontend bundle has been rebuilt and
deployed to Cloudflare with the same address.

Arb Sepolia and OP Sepolia redeploys (Path B — full mainnet-rehearsal
pass) are queued. After both land, `deploy-peers.sh` wires the
cross-chain peer mesh between the new Base canonical and the new
mirror diamonds, then PositiveFlows + PartialFlows reruns validate
the full pipeline on the new addresses.

## Test infrastructure

The Diamond pause-by-default change required a coordinated update
across the test suite — every test fixture that builds a fresh
diamond inline now needs to call `unpause()` after
`initializeAccessControl()`, otherwise every `whenNotPaused` path in
every test would revert `EnforcedPause`. 47 test files were patched:

- 36 files cut `AdminFacet` into their fixture and got an
  `AdminFacet.unpause()` call auto-inserted after the
  `initializeAccessControl()` line.
- 9 files (e.g. `OfferFacetTest`, `LoanFacetTest`, `AccessControlFacetTest`)
  don't cut `AdminFacet` because they only exercise specific facets
  in isolation — those got direct `vm.store(diamond, slot, 0)` writes
  to flip the `LibPausable` storage slot directly. Same effect as
  calling unpause through the selector route, doesn't require cutting
  AdminFacet just for the test.
- 2 files were intentionally left at the paused default —
  `SetupTest.t.sol` already had unpause from the in-flight edit, and
  `DiamondBornPausedTest.t.sol` actively asserts the paused state.

Full broad regression: 1620+ tests passed, 0 failed, 5 pre-existing
skips, across 81 test suites. Item 1 + Item 2 + Item 3 ship clean.

Item 4 (forge verify-contract dedup patch validation) was already
green from the 2026-05-04 rehearsal pass — covered by the deploy
script's `--verify-contracts` flag end-to-end against Base Sepolia.
Doesn't require its own redeploy to validate.

## Documentation + knowledge artifacts

- `docs/internal/ContractFollowupsFromRehearsal-2026-05-06.md` — Item
  1 marked SHIPPED with the as-built notes; Item 5 added (a fifth
  follow-up — `getLoanDetails` returning the full Loan struct). Item
  5 turned out to be already-correct on the contract side: the slim
  view was a watcher-side type-cast limitation, not a contract
  limitation. Watcher updated to consume the full struct; contract
  unchanged.
- `docs/ops/MainnetMultisigSetup.md` — six-step runbook covering
  Safe-multisig + Timelock setup for mainnet, including the
  `transferAdmin` use case post-Item-3.
- `docs/ops/DeploymentRunbook.md` — added a "Rehearsal lessons
  learned" section capturing the Node-version, REWARD_VERSION-bump,
  and `.active-chains` mechanics (separate file commit).

The watcher's D1 schema migration count is now at 9; both 0008 and
0009 ran cleanly against the live Cloudflare D1 instance for all
testnet chains.
