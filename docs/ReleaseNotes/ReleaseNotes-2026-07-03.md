# Release Notes — 2026-07-03

This edition folds the pending release-note fragments from the July 1–3 work
window into one dated file. The headline change is the **cross-chain
reward-budget bridge (#776)** — mirror-chain interaction-reward claims are now
funded on demand from Base over Chainlink CCIP, closing the long-standing gap
where a mirror user could pass the claim gate only to have the payout revert on
an empty balance; the bridge lands complete with its Base sender, per-mirror
receiver, fee-quote helper, end-to-end proof, and the keeper automation that
drives remittance without operator intervention.

Alongside it, several threads move the testnet and frontend surfaces forward:
**BNB testnet becomes a user-facing chain** (cross-chain stack deployed and
indexed, oracle configured via PancakeSwap with no 0x dependency, WalletConnect
and liquidity-preflight support, and a public-RPC log-index recovery fix); a wave
of **testnet deploy-flow and deploy-script hardening** (#853/#855/#856/#862);
the **naive-user-first frontend redesign** (alpha01 basic-mode build-out and the
alpha02 connected-app redesign) plus the **auto-lend dedicated page** (#878);
**realtime-push Phase B** adaptive-polling + live-updates diagnostics; and
**facet-upgrade tooling** that no longer risks a split Diamond (#778/#779). Each
section below is the fragment authored with its originating PR.

## Cross-chain reward-budget bridge — mirror claims are now funded (#776)

Interaction rewards accrue globally but are claimed on whatever chain a user
is on. Until now the cross-chain mesh finalized each day's accounting and
broadcast the global denominator to every mirror chain — which opened the
local claim gate — but nothing ever moved the VPFI a mirror needs to pay
those claims. A mirror user could pass the gate and then have the claim
revert at the token transfer because the mirror Diamond's VPFI balance was
empty. This was finding #00006 ("mirror interaction reward budgets are not
bridged during finalization").

#776 closes that gap with an on-demand Base→mirror reward-budget bridge over
Chainlink CCIP, deliberately kept off the finalization hot path (bridging
value automatically inside every finalization would drag in CCIP lane rate
limits, native-fee funding, and per-day replay/recovery). Base — which holds
the whole 69M interaction pool and every input — computes each finalized
day's per-chain VPFI slice and, when an operator or the keeper calls for it,
remits that slice to the mirror. A per-mirror receiver validates and forwards
the VPFI into the mirror Diamond, and the existing claim path simply pays out
from the now-funded balance. Sends are batched over days, idempotent (a retry
skips already-sent days), and bounded by a per-call cap so each send stays
under the live CCIP lane bucket.

The accounting is conservative on both sides: what Base has remitted to
mirrors is reserved against Base's own claim payouts, so remittances plus
Base-local claims can never jointly exceed the 69M pool; and a day's slice is
only remittable for chains that were actually folded into that day's finalized
denominator, so an operator reshuffling the expected-chain set mid-day can't
cause an over-send. Every cross-chain contract in the flow carries the
guardian pause lever and rotates to the governance timelock at mainnet
handover.

Delivered across six PRs: the design (#888), the Base-side sender (#889), the
per-mirror receiver plus deploy/CCIP wiring (#916), the end-to-end proof +
documentation (#923), a fee-quote helper that dry-runs a batch's exact
cross-chain fee (#924), and the keeper automation that drives remittance without
operator intervention (card #925, merged as PR #929). An end-to-end test
demonstrates the fix directly —
a claim on an unfunded mirror reverts, and the identical claim succeeds once
the budget has been remitted and received.

Two follow-ups are tracked as separate cards, not gaps in this work: #917
(a bounded on-chain reclaim path for the rare terminal-wind-down case where a
mirror is over-funded relative to what its users ultimately claim — today that
surplus safely funds subsequent days' claims and any true residual is a
governance action, because the mirror Diamond's VPFI is commingled with LIF
custody and treasury) and #918 (a deploy-time pre-flight that asserts the
reward-budget CCIP lane capacity clears the largest single-day slice, since a
day is remitted atomically).

Closes #776. The bridge is code-complete but stays dark until an operator
provisions the reward-budget CCIP lane, deploys and registers the per-mirror
receiver, authorizes the keeper on-chain, and turns the automation on.

## Tooling — curated facet-upgrade scripts no longer risk a split Diamond (#778, #779)

The curated "replace a stale facet" / "redeploy specific facets" operator scripts
each hand-maintained their own partial list of which function selectors to cut
into the Diamond. Those lists had drifted below the facets' real surface — the
Oracle, VaultFactory and Profile lists were each missing selectors that exist on
the live facet. Running such a script would `Replace`-cut only the listed
selectors and leave the unlisted ones pointing at the old facet bytecode, quietly
splitting one facet across two implementations (most dangerous around the
sanctions/keeper controls and shared vault state).

The per-facet selector lists for those facets now come from a single shared
source, and a new guardrail test pins that source to each facet's compiled ABI —
so if a facet gains or loses an external function, the test fails until the one
shared list is updated, rather than a live upgrade silently splitting the Diamond.
Building this even surfaced two selectors that the previous "canonical" reference
list had itself been missing.

No production/runtime behaviour changes — this hardens the operator upgrade
tooling and its safety checks only.

## Thread — Anvil positive-flow UX + accept-offer gas messaging (PR #833 / #780)

A Chrome/CDP walkthrough of the basic local-Anvil lend/borrow flow surfaced a
cluster of frontend rough edges. Triage split them into genuine app bugs (fixed
here) and stale-local-deployment artifacts (the walkthrough ran against an Anvil
diamond built from older contracts than the app's ABIs — those decode errors
resolve by redeploying Anvil, not by app changes, since the current contracts
match the shipped ABIs and every live testnet decodes cleanly).

Fixed in the app:

- **Signing-safety: the accept review and offer-detail views now show the real
  economics.** A lender ERC-20 offer's headline principal is its max-provide
  amount (what accepting actually locks), but two surfaces were reading the
  offer's minimum-partial-fill field — showing, e.g., 10 mUSDC where the loan
  settles 100. A single shared role-aware helper now feeds the principal, rate,
  projected repayment, initiation fee and net-proceeds everywhere, so the last
  screen before signing matches what executes.
- **The create-offer preflight stops crying wolf.** It previously flashed "this
  transaction would revert" because it simulated before the token approval the
  submit path grants first. It now recognises that specific allowance case and
  shows a calm "token approval required first" note instead.
- **The Permit2 accept path no longer asks the wallet to submit a doomed
  transaction.** A free read-only preflight runs first; if Permit2 isn't usable
  on the chain, the app falls straight through to the classic path without
  spending gas on a reverting send.
- **Local-Anvil loan visibility.** The event-index scan no longer refuses to run
  when the local deploy block is unresolved (harmless on a local node), so a
  freshly opened loan shows up on the Dashboard/Activity/loan surfaces in local
  mode.
- **No more mainnet-RPC CORS noise on Anvil.** ENS name resolution is skipped on
  the local chain, so the console isn't flooded with cross-origin errors that
  masked real failures.
- **The cookie banner no longer overlaps transaction dialogs.** Its stacking
  order was lowered so a review modal's backdrop covers it — the "Accept all"
  button can't sit in front of the protocol "Accept".

Accept-offer gas messaging (#780): the historical "exceeds max transaction gas
limit" failure was an old two-argument accept call shape against a contract that
had moved on — the classic estimateGas-fallback artefact. The current typed
accept flow already approves before writing, and the Permit2 preflight above
removes the other doomed-send path. As the remaining piece, the shared error
decoder now recognises that gas-cap phrase and, when it can't decode a real
revert, explains it is usually an approval or stale-build issue rather than a
true gas shortage — so users can tell the two apart.

Stale-Anvil items (protocol-config bundle decode, a loan-detail number-range
decode, and a missing collateral-lien view) are resolved by redeploying the
local Anvil diamond from current contracts; a fresh-Anvil browser
re-walkthrough is the remaining validation for that subset and for end-to-end
loan visibility. The app fixes above are covered by typecheck + unit tests.

Closes #833. Closes #780.

## Thread — Realtime push Phase B: adaptive polling + live-updates diagnostics (PR #845)

The connected app now spends less RPC and Worker budget while the realtime
WebSocket push channel is healthy. Previously the watermark poll kept running at
its full per-view cadence (as fast as every 5 seconds for a hot Offer Book) even
when the push channel was already delivering near-instant invalidation signals —
so the investment in push from the earlier Phase B work wasn't actually reducing
background polling. With this change, whenever the push transport is `live` the
poll relaxes to a 60-second backstop floor (a 12× reduction for the hottest
view); any disconnect, fallback, or chain switch restores the normal tier
cadence immediately. Correctness is unchanged — the poll only ever slows as a
backstop, never stops, and the push carries a signal only, never authoritative
data.

The diagnostics drawer gained a "Live updates" section so an operator or
power-user can see, at a glance, why the app is as fresh as it is: the transport
state (live / polling / reconnecting), the age of the last push event, a
session reconnect count, the effective poll interval (and whether it is
push-backed), and the measured push-to-refetch latency. The latency is anchored
to the moment the invalidation frame arrived — including any debounce and any
wait behind an in-flight probe — so it reflects what the user actually
experiences rather than under-reporting. All of these readings reset cleanly on
a chain switch so the drawer never attributes the previous chain's freshness,
reconnect count, or latency to a newly selected one, and the reconnect count
increments only when an established-live channel actually drops, not on every
failed retry during an outage.

Closes #843. The remaining Phase B polish items — narrower, slice-specific
invalidations and the diagnostics surfacing of dropped/duplicated frames — were
split out to #844 so this card could close on the adaptive-polling +
diagnostics deltas alone.

## Thread — Testnet deploy-flow hardening (PR #853)

A batch of real deploy-flow fixes surfaced while deploying the protocol fresh
to Base Sepolia, Arbitrum Sepolia and BNB testnet over public drpc RPCs. Each
one unblocked a concrete failure the operator would otherwise hit at broadcast
time. The `DeployDiamond` diamondCut is now applied in small batches (the old
fixed two-half split reached ~17.7M gas per half at 61 facets — over drpc's
per-transaction send cap), a gas-estimate multiplier pads every broadcast so a
batched cut clears that ceiling, and the L2-block reader falls back to an
`ARB_L2_DEPLOY_BLOCK` override on Arbitrum because forge's simulator does not
emulate the `ArbSys` precompile that returns the real L2 block number.

The canonical VPFI token now has a first-class place in the deploy sequence.
A new `DeployVPFIToken` script mints the 23M canonical supply behind a UUPS
proxy and records it, and it is wired into the contracts phase **before** the
cross-chain step — the canonical CCIP LockRelease pool wraps that existing
token, so it must exist first (previously the operator had to hand-deploy it).
The token deploy is hard-guarded to the canonical chain ids (Base / Base
Sepolia) and refuses to overwrite an already-recorded token unless the operator
explicitly opts into a redeploy, so it can never mint a second supply or run on
a mirror chain by mistake. A companion `ConfigureVPFIToken` step (folded into
the post-deploy `DiamondConfigSpell`) performs the admin-gated diamond wiring —
registering the token and flagging the chain canonical — so the diamond can
actually mint and use VPFI; on mirror chains it is a clean no-op. The mainnet
handover now also rotates the canonical token's owner to the governance
timelock alongside the rest of the cross-chain stack, closing a gap where a
post-handover admin key could still upgrade or re-mint canonical VPFI outside
governance.

The automated fresh-deploy D1 purge is also part of this thread: `--phase
cf-indexer --fresh` now purges the chain's stale indexer rows after a fresh
contract redeploy (the diamond address changed, so old rows keyed by chain id
would otherwise still surface), and the misleading forge `--retries`/`--delay`
knobs were removed — those govern contract-verification retries, not
`eth_sendRawTransaction`, so they gave a false sense of send-retry protection;
transient RPC send failures are recovered by re-running the phase (with
`--resume`) instead. The fresh purge now enumerates every chain-scoped
indexer table dynamically (any table carrying a `chain_id` column) rather than
a hardcoded list, so tables added to the schema later can never be silently
left behind — a stale prepay-listing or swap-intent row could otherwise be
inherited by a new loan that reuses a retired diamond's loan id.

The frontend deployments bundle also now derives a universal `vpfiToken` on
mirror chains (equal to the burn/mint `vpfiMirror`), matching the documented
"present on every chain" contract of that field. Without it, a mirror-chain
record that only carried `vpfiMirror` would make the app's "block VPFI as a
lending asset" guard silently disable, letting a user submit a flow the diamond
then rejects.

## Thread — Deploy-script hardening follow-ups (PR #855, Closes #855)

Four operator-facing deploy/ops hardening fixes that were deferred from the
testnet-deploy-hardening work (#853) to cap that PR's review loop. None change
the already-live Base/Arb Sepolia deploy; they close footguns in the
mainnet/multi-chain deploy scripts and the incident-pause tooling.

The `--phase ccip-wire` step now hard-errors if `CCIP_GUARDIAN` is unset. The
cross-chain configure silently skips wiring the incident guardian onto every
`GuardianPausable` contract when that address is missing, and setting a guardian
is owner-only — so once ownership hands over to the governance timelock, the
fast Pauser-Safe pause lever can no longer freeze those contracts during an
incident. Requiring it at wire-time (while the admin still owns them) keeps the
containment path intact. `CCIP_GUARDIAN` is a single global address (typically
the Pauser Safe), documented in the CCIP infra reference.

A canonical VPFI redeploy now has a third, non-destructive option. Previously a
Diamond/CCIP redeploy on the canonical chain could only either abort (a token
already exists) or mint a second 23M supply (forking the token). Setting
`VPFI_TOKEN_REUSE_ADDRESS` to the existing canonical token now carries it forward
— it is recorded for the new deploy and the mint is skipped — with a loud
reminder that the operator must rotate the token's minter to the new diamond
afterward (owner-only).

Two smaller fixes: the post-deploy configure now skips VPFI registration
gracefully when no VPFI token was deployed (a `--skip-vpfi` deploy), so the
configure spell no longer reverts; and the emergency-unpause helper now routes
its calldata through the governance timelock (unpause is owner-only /
UNPAUSER_ROLE by the asymmetric-pause design) instead of mislabeling it as a
Pauser-Safe action — which would have reverted for the cross-chain contracts.

## Thread — Phase B flow-rehearsal portability (#856) + BNB-testnet cross-chain deploy

Two testnet-rehearsal follow-ups from the Base/Arb Sepolia flow work.

### #856 — Phase B positive-flow rehearsal now runs on any testnet

The Phase B rehearsal (the "new-features" wave of the positive-flow script)
self-deploys mock USDC/WETH and a mock price/liquidity fixture, then exercises
loan lifecycle features that need on-chain risk math (loan-to-value and
health-factor). It passed on a fresh local devnet but aborted on Arbitrum
Sepolia the moment any scenario asked for risk math — the mock USDC was being
classified as an illiquid asset, and the platform refuses to compute risk math
on illiquid loans.

The cause was that the mock liquidity fixture didn't satisfy the platform's
depth check on a real testnet. Two things had to be corrected so the mock
asset reads as liquid on any chain: the fixture now tells the platform which
quote asset to price the mock pool against (previously it inherited the real
chain's own quote-asset list, for which no mock pool exists), and the mock pool
is now priced consistently with the mock price feeds (previously it used a
placeholder 1:1 price, which the depth check rejected because the pool's value
didn't agree with the feed). With both corrected, every Phase B scenario now
runs on Arbitrum Sepolia exactly as it does locally. This is a test/rehearsal
tooling change only — no platform contract behaviour changed.

### BNB-testnet — cross-chain stack deployed and indexed

The BNB Chain testnet deployment previously had only its core diamond and
timelock. Its cross-chain stack (the mirror VPFI token, the messenger, the
token pool, the rate governor and the reward messenger) is now deployed and the
mirror VPFI token is registered on the diamond. BNB testnet has been added to
the indexer's active-chain set, and the indexer now tracks it alongside Base
and Arbitrum Sepolia. The earlier "stuck on BNB RPC" blocker turned out to be a
minimum-gas-price requirement on the network rather than an RPC-connectivity
problem.

## Thread — Deploy-script swap-adapter phase hardening (#862)

Follow-up hardening from the BNB-testnet oracle work (#860). None of these change
the deployed state of any chain; they make the deploy tooling correct for the
edge cases that surfaced while wiring an on-chain DEX (PancakeSwap) swap adapter
into the deploy flow for chains that have no 0x backend.

The main change relaxes an over-strict coupling between two deploy phases. The
oracle-configuration step used to hard-fail unless a liquidation-swap adapter was
already registered on-chain in a specific slot order, which cascaded into a series
of adapter-index edge cases. Slot ordering properly belongs to the swap-adapters
phase and the keeper's per-chain routing map, so the oracle step now only emits an
advisory warning about slot ordering rather than blocking on it. It still keeps a
hard gate on the essentials: the adapter list must be non-empty (an oracle config
run before any swap adapter is registered still refuses, because every liquidation
would otherwise revert), and its own inputs must be coherent (the 0x
proxy/allowance-target pair, and that only chains without a 0x backend may omit
them). In short: adapter *existence* is a hard requirement; adapter *ordering* is
advisory.

The remaining fixes: the swap-adapters phase no longer registers the 0x/1inch
aggregator adapters on a chain that has no 0x backend even if a stale settings
value is left in a shared env file (they would be useless and would displace the
on-chain DEX adapter from the slot the keeper expects); on such no-0x chains the
deploy now hard-requires the on-chain DEX router up front, since that adapter is
the sole liquidation route there; re-running the swap-adapters phase to add the
DEX adapter after the aggregators already landed skips a duplicate aggregator pair
based only on that phase's own dedicated completion marker (an older, ambiguous
combined marker is deliberately NOT treated as proof the aggregators ran); and the
DEX-adapter deploy now requires the configured factory address up front — resolved
under the same env-var name the oracle step uses — so a missing/misspelled value
can't skip the same-DEX safety check.

## Thread — Alpha01 naive-first frontend plan (PR E1, Issue #864)

Adds `docs/DesignsAndPlans/Alpha01NaiveFrontendPlan.md`, the architecture and
PR-plan document for the greenfield connected app at `alpha01.vaipakam.com`.
The plan commits to naive-first Basic mode (intent wizards, review receipts,
mobile-first shell, light/dark themes) with a later Advanced mode for
DEX-exposed users, while leaving `apps/defi` untouched until operator cutover.

The doc records codebase scout findings: reuse `@vaipakam/contracts`,
`@vaipakam/lib`, and `@vaipakam/ui`; introduce `packages/defi-client` and
`apps/alpha01` without importing from `apps/defi`. Phased PR stack (P0–P3) maps
to GitHub issues #865–#868 under epic #863.

Closes #864. Implementation PRs follow the merge order in the design doc.

# Alpha01 scaffold (P0, #865)

Greenfield `apps/alpha01` Vite SPA with Cloudflare Worker config (`vaipakam-alpha01`), light/dark theme tokens synced via `@vaipakam/lib` cross-domain cookie, mobile-first `MobileShell` with bottom navigation, and wagmi/ConnectKit bootstrap on dev port 5175.

# Alpha01 UX primitives (P1, #866)

Shared Basic-mode components: `ReviewReceipt` (six-field trust surface), `EligibilityChecklist` (fixable preflight items), `ModeContext` (basic/advanced persisted in `vaipakam.alpha01.uiMode`), and intent-first home with four job cards. `packages/defi-client` package scaffolded for protocol types.

# Alpha01 Journey B1 — borrow (P2, #867)

`packages/defi-client` implements indexer offer reads, EIP-712 accept terms signing, and `acceptOffer` flow. Alpha01 borrow wizard walks pick-offer → eligibility → review receipt → confirm, plus position detail command center with repay entry.

# Alpha01 Journeys L1 + M1 (P3, #868)

Lend wizard posts lender offers with the same eligibility/review pattern. Positions list shows active loans as mobile-friendly cards; loan detail supports repay and lender/borrower claim paths. Claims and More pages provide simplified navigation without touching `apps/defi`.

# Alpha01 Basic mode journey wiring (#869)

Completes Basic-mode journeys B1, B2, L1, L2 (create path), M1, and C1 in alpha01: intent-first borrow/lend wizards with eligibility (wallet, chain, sanctions, terms), vault + allowance preflight in defi-client, review receipts with journey copy, loan command center with plain health labels and repay→claim CTAs, claim center backed by indexer `/claimables`, NFT rent intent chooser, and help links to the Basic user guide.

## Thread — Auto-lend moved to its own page (PR #878)

The Auto-lend (standing lender intent) surface has moved off the landing
Dashboard onto a dedicated **Auto-lend** page (`/auto-lend`), reachable from the
app sidebar (Advanced group, next to Keepers — an auto-lend intent delegates a
keeper to fill on the lender's behalf). Since the multi-intent list and Manage
controls landed, the feature had grown from a single card into a full management
surface that crowded the Dashboard.

The full surface now lives on that page: create a standing intent, see the
"Your auto-lend intents" list across every pair you run, and manage each one.
Every on-chain write still flows through the same audited auto-lend card — this
change only relocates and hosts it; there is no new mutation path, and the
list's "Manage" deep-link (which retargets the card and scrolls to it) works on
the new page exactly as it did on the Dashboard.

In its place the Dashboard shows a compact summary widget — the wallet's
standing-intent count (active plus paused) with a link to the page. It appears
only once the wallet actually holds a standing intent; first-time discovery is
via the sidebar's Auto-lend entry. Opening the page without a connected wallet
shows a connect prompt, and — since the create/fund/withdraw paths are
sanctions-gated — the page carries the same wallet sanctions banner the
Dashboard used to show above these cards. Both the page's cards and the
Dashboard widget stay hidden on chains where the intent facet set isn't
deployed, so neither renders a dead surface.

Closes #878.

## Keeper now auto-funds mirror reward budgets (#925)

The #776 reward-budget bridge lets Base fund each mirror chain's
interaction-reward VPFI on demand, but until now an operator had to call the
remittance by hand. This adds a keeper pass that drives it automatically.

On every cron tick the keeper, running against the canonical (Base) chain,
re-scans a bounded window of recent days for each mirror, batches the ones that
have a finalized-but-un-remitted budget (keeping each send under a configured
per-lane VPFI ceiling), quotes the exact cross-chain fee, and remits — so
mirrors stay funded ahead of the day their claim gate opens and users don't hit
the "claim reverts on an empty balance" back-pressure. Discovery needs no stored
cursor: the on-chain quote returns zero for any non-finalized or already-sent
day, so re-scanning is harmless, and sends are idempotent (a day already remitted
is skipped), so retries after a hiccup are always safe.

The pass is dark by default. It runs only when the master `KEEPER_ENABLED`
switch and a dedicated `REWARD_REMIT_ENABLED` flag are both on AND the keeper's
address has been authorized on-chain (either as ADMIN or via the optional
reward-remittance keeper role) — so enabling the automation is a deliberate,
reversible operator step. If a single day's slice ever exceeds the configured
lane ceiling it is skipped with a loud log pointing at the lane-capacity
provisioning follow-up (#918), since a day is remitted atomically.

Closes #925.

## Thread — Alpha01 basic UX polish (borrow/lend, positions, activity)

The naive-first alpha01 app now completes the core review loop for borrow, lend, positions, and claims. Borrow and lend wizards use bucketed duration dropdowns, CoinGecko-backed asset pickers, collateral balance checks, and plain-language review receipts. Asset symbols link to the chain explorer everywhere amounts appear, and NFT collateral renders as token IDs instead of mis-scaled ERC-20 decimals.

Positions reads loans and open offers from the corrected indexer endpoints, with an Activity feed under More for per-wallet on-chain history. Legal links (Terms, Privacy, risk disclosure) are surfaced in More and Settings; borrow/lend review steps require explicit consent with links before any transaction is submitted.

Follow-up: on-chain Terms gate parity with the classic defi app is deferred — alpha01 uses action-time consent mapped to `riskAndTermsConsent` on offers.

Codex review follow-ups (P1/P2): accept-term binding now mirrors stored offer fields; spendable balance counts wallet only; open offers and positions resolve role via current-holder indexing; direct-accept pickers hide NFT legs, partial fills, and expired GTT rows; lender fund flow checks wallet principal before approval; sanctions screening fails closed when the oracle read errors.

Round 2: ERC-20 approvals zero stale allowances first; borrow checklist blocks while collateral balance is unresolved; `settled` loans no longer show a borrower claim CTA; linked-loan id reads fail closed except on legacy missing-selector deploys; read-chain resolution skips wallet chains without a Diamond.

Round 3: position cards and borrow wizard reset assets on chain change; lender `settled` claims removed; create-lending balance gate; risk-terms hash fail-closed; APR capped at 100%; collateral hint labels wallet-only.

Round 4: BNB testnet restored as user-facing; token decimals fail closed without persisting a bogus 18; risk-disclosure link targets the Basic guide anchor; vault reads use the view getter; indexer outages surface errors instead of empty portfolios; accept flow rejects cross-chain offer/wallet mismatches.

Round 5: Arb Sepolia and BNB testnet borrow/lend defaults now resolve wrapped-native addresses (with deployment/env fallbacks for mock stable); open offers can be cancelled from Positions; ERC-20 approvals verify receipt success and re-read allowance; borrow matcher requires an exact principal match for direct accept; Claims surfaces indexer failures and shows collateral for borrower claims; create-lending gates on collateral decimals; Help links target real Basic guide anchors; AGENTS.md points at the canonical `~/.codex/scripts/` poller path.

Round 6: Cancel offer is gated to the on-chain creator; create-lending adds curated asset pickers when chain defaults are absent; Activity merges participant loan/offer timelines (not actor-only); borrow accept receipts disclose net wallet proceeds after upfront LIF; create-lending receipt clarifies offers do not auto-expire on the duration field.

Round 7: Activity merge preserves all actor rows; enrichment includes current-holder loans/offers; token metadata cache is chain-scoped; Positions merges creator + holder offers for cancel paths; borrow receipts read live LIF from the diamond; CoinGecko lists clear on chain switch; borrow-request collateral hint is wallet-only.

Round 8: Open offers list is current-holder only so transferred-away positions cannot be cancelled from alpha01; fund-lend receipt discloses principal leaves wallet custody; position cards render asset symbols as text inside the loan link (no nested anchors).

Round 9: Borrow/lend offer pickers exclude self-authored offers and render plain symbols inside selectable rows; raw amount formatting no longer assumes 18 decimals; canonical asset labels use lowercase keys; loan detail and activity pages surface indexer errors instead of empty/not-found states.

Round 10: Raw formatting uses cache-resolved decimals only; offer pickers require wallet connect and clear stale selections; unhealed indexer stubs filtered from lend picker; loan detail warns when indexer origin is missing; lender active loans show Active status; activity merge reserves participant slots; defaulted lender claims show collateral; claim buttons respect wallet chain.

Round 11: Root `alpha:dev`/`alpha:build` target `@vaipakam/alpha01`; alpha01 adds `typecheck` script; Claims unions holder loans in resolution paths and filters empty borrower defaults via on-chain `getClaimable`; activity merge never drops actor rows from a cursor page; borrow matching requires a parsed amount before listing offers.

Round 12: Borrower `fallback_pending` claims filtered via on-chain probe; accept-terms signing fails closed on RiskAccess deploy skew; loan detail surfaces claim CTAs for borrower defaulted/internal-matched and lender fallback/internal-match loans.

Round 13: Zero `amountMax` normalized for offer matching; public offer fetch before wallet connect; defaulted borrower claim CTA gated on `getClaimable`; borrow request fallback stays visible on indexer errors; borrower `fallback_pending` excluded from Claims; Codex watch paginates reviews.

Round 14: Borrow accept receipt reuses `offerPrincipalWei`; Claims prunes empty lender rows via `getClaimable`; indexer by-current-holder loan/offer routes return 503 when the chain is not configured; dual NFT holders resolve to both roles with lender fallback on loan detail; `internal_matched` borrower claims gated on on-chain claimability.

Round 15: Offer cards use `offerPrincipalWei` for display; `liquidated` borrower claims gated on `getClaimable`; activity merge reserves participant slots when the actor page is full.

# Alpha01 P4 — NFT rental wizards (N1 / N2)

## Summary

Replaces the `/rent` stub with full Basic-mode NFT rental flows inside `alpha01.vaipakam.com`, backed by new `defi-client` rental modules.

## User-visible changes

- **List NFT (N1):** Owners can post ERC-721 / ERC-1155 rental listings with daily fee, prepay token, and duration; review receipt explains vault custody and temporary renter rights.
- **Browse & rent (N2):** Renters browse indexer listings, see total prepay (fees + buffer), and accept with the shared eligibility + receipt pattern.
- **Post request (PF-044):** When no listing fits, renters can post a demand offer that locks prepay + buffer at create time.
- **Positions:** Rental rows and detail pages use rental vocabulary (renter / NFT owner, close rental, claim fees and NFT) instead of debt-loan copy.

## Technical

- `packages/defi-client`: rental prepay math, NFT rental offer payloads, NFT approval helper, accept/create flows, indexer filters.
- Daily fees scale with prepay-token `decimals()` (fixes the raw-integer footgun in legacy defi NFT rental forms).

## Verification

- `pnpm --filter @vaipakam/alpha01 test`
- `pnpm --filter @vaipakam/alpha01 exec tsc -b --noEmit`

## Thread — alpha02: naive-user-first connected-app redesign (PR #887)

A new frontend surface, `apps/alpha02` (`@vaipakam/alpha02`, to serve at
alpha02.vaipakam.com), begins the ground-up redesign of the connected app
for non-expert users. It implements the intent-first, progressively
disclosed product direction from the Basic User UX Simplification Plan:
the first screen asks what the user wants to do (borrow, lend, rent an
NFT, manage positions); every write flow shares one six-row review
receipt (you receive / you lock / you may owe / you can lose / fees /
when this ends) and a fixable-items eligibility checklist; empty states
distinguish "truly empty" from "couldn't load"; unknown routes land on a
recovery page instead of a blank screen. The app is mobile-first (bottom
tab bar under 720px), ships light and dark themes, and carries a
persisted Basic/Advanced mode switch that reveals advanced controls in
place without navigating.

Wired end-to-end in this first cut: wallet connect (wagmi + ConnectKit,
mirroring apps/defi's connector decisions), deployment-driven chain
support with plain-language network gating, guided borrow/lend flows
that post offers through the Diamond (allowance handled inline, payload
mapping copied verbatim from apps/defi's offerSchema), positions list
and loan detail with repay and claim actions, Claim Center, Offer Book
browsing, and an availability-first VPFI education page. It also designs
out the five findings of the 2026-07-02 naive-user browser audit
(curated asset picker, honest offer-book empty states, availability-first
VPFI state, user-centred network copy, no blank route dead-ends).

The accept-offer journeys (B1: borrower uses an existing lender offer;
L1: lender funds an existing borrow request) are wired as the guided
flows' primary path: after the user states asset, amount, and duration,
the flow surfaces matching open offers first — accepting one opens the
loan immediately — and posting their own offer is the explicit
fallback. Accepting signs the EIP-712 AcceptTerms against the canonical
on-chain offer (ported from apps/defi's useAcceptTermsSigning, with the
fail-closed risk-terms-hash behaviour preserved), approves the
acceptor-side asset for the exact signed amount, and calls acceptOffer.
The Offer Book gains a "Use this offer" action that deep-links into the
same review-and-sign step.

The VPFI vault journey (V1) is live: the page decides availability
first (a chain without a registered VPFI token — or a failed check —
never shows deposit controls), shows the tracked vault balance and the
ACTIVE effective discount with a plain "warming up" note when the raw
balance-implied tier is higher (the fee path applies a 30-day average
behind a minimum-history gate), carries the platform-level consent
toggle, and runs deposit/withdraw through the shared review receipt
with exact-amount approvals.

The NFT rental journeys (N1/N2) are live and deliberately separated
from debt lending: an owner lists an NFT (ownership verified in the
checklist before any gas, collection approval granted only when
missing, rentals created at a 0% rate since fees are prepaid), and a
renter browses listings and rents with the full prepay — daily fee ×
days plus the live refundable buffer — spelled out before signing,
computed from the signed canonical terms at approval time. Positions
and detail pages now speak "rental" for NFT legs (close/claim, never
"repay"). One deliberate divergence from apps/defi: the daily fee a
user types is scaled by the payment asset's decimals before it goes
on-chain; apps/defi's form sends the typed number through unscaled,
which is flagged in the page header as a candidate code-vs-docs audit
entry.

The completion pass fills out the remaining product surfaces: open
offers are cancellable from My positions (two-tap confirm, releases
the locked side); loan details gain a plain-language health row
(health factor + loan-to-value from RiskFacet — label only in Basic,
numbers in Advanced, and an explicit "no automatic liquidation" note
for unpriced/illiquid legs), an add-collateral action, and partial
repayment for opt-in loans in Advanced mode; a "Your Vaipakam Vault"
page shows per-asset total/locked/free with totals clamped to the
protocol-tracked balance; the Claim Center gains the
interaction-rewards claim with an honest "being finalized" waiting
state; a sanctions banner (fail-open, shown only to oracle-flagged
wallets, with wind-down paths explicitly kept open) renders across
the app; an Activity page joins the Advanced navigation; and NFT
rental listings in the Offer Book deep-link into the guided renter
flow.

A max-effort review pass (ten finder angles, adversarial verification,
gap sweep) plus the Codex PR review then hardened the whole surface.
Consent-integrity: accepts now re-verify the signed canonical terms
against the reviewed offer (and its chain) and abort with a plain
notice on any mismatch; unpriced (illiquid) legs get an explicit
in-kind-transfer warning before signing; the sanctions check joined
the pre-approval checklist so a flagged wallet never pays approval gas
for a doomed transaction. Funds-access: loan actions follow the
current position-NFT holder (transferees were locked out as
"viewers"); borrowers can claim residual entitlements after
default/liquidation (the Claim Center listed rows the detail page
couldn't act on); VPFI withdrawals cap at the FREE (unencumbered)
balance and the Max button is lossless. Honesty: partial indexer
failures now read as "unavailable" instead of confident half-lists;
the rental prepay buffer and all fee/tier copy are read live from
protocol config (never a hardcoded default at signing time); RPC
failures no longer masquerade as "no liquidation applies"; overdue
loans no longer show "Due today". Robustness: wallet-rejection
detection uses error types instead of a message regex that matched
the word "cancel" inside cancelOffer reverts, with contract errors
decoded via the shared @vaipakam/lib decoder (fixing the #780
gas-limit trap); non-numeric amount/rate inputs can no longer crash
the page; approvals zero-first for USDT-style tokens; repay approvals
carry day-boundary headroom; deep links validate asset kind, side,
ownership, and existence; RPC transports batch; the Safe-App connector
is included. The defi rental daily-fee unit divergence was filed in
docs/FunctionalSpecs/_CodeVsDocsAudit.md and the alpha02 intended
behaviour was added to docs/FunctionalSpecs/WebsiteReadme.md.

With the naive-user surface converged (Codex review rounds dropped
from repeated correctness findings to only narrow race-window polish),
the first Advanced-mode reveal landed on the Offer Book: a side
filter (lending offers / borrow requests / NFT rentals), rate and
duration sorting, an any-leg asset-address filter, and a per-row
detail line with the exact basis points, offer id, expiry, range
bounds (size band on lender offers, rate band on borrow requests) and
the partial-repay flag. Basic mode keeps the plain newest-first list;
a filter that matches nothing says so explicitly instead of claiming
the market is empty. Loan details already showed exact health-factor
and loan-to-value numbers in Advanced mode.

apps/defi is untouched and stays the live app until alpha02 reaches
parity; apps/alpha (the earlier static mock) is untouched and unused.
The remaining parity milestones are tracked in `apps/alpha02/README.md`,
which is the live source of truth as the redesign continues (the inline
list is intentionally omitted here to avoid drift against that README).

## Frontend — BNB testnet log-index recovers from the public RPC's "limit exceeded"

On BNB testnet, the app's on-chain log scan (which backs Dashboard/Activity/Offer
history when reading directly from the chain) was failing outright with
`getLogs …: limit exceeded` and never recovering.

The scanner already copes with RPC providers that cap how many blocks or how many
logs a single request may return: it detects the rejection and automatically
retries with a smaller block window. But it recognised that rejection only by the
wording other providers use ("block range", "response size", "query returned more
than …"). BNB testnet's public RPC rejects with the terse phrase "limit exceeded",
which didn't match, so instead of shrinking the window and retrying, the scan gave
up and surfaced an error.

The detector now also recognises "limit exceeded" (and a few equivalent phrasings),
so the scan shrinks its request window and completes on BNB testnet's public RPC
the same way it already did on other chains. This is chain-agnostic — any RPC that
reports its cap this way now recovers automatically.

## Thread — BNB-testnet oracle configured via PancakeSwap (no 0x dependency)

The BNB Chain testnet deployment now has its price-oracle and liquidation
routing fully configured, completing the earlier BNB cross-chain + indexing
work. BNB testnet can now price assets and run risk math (loan-to-value,
health-factor) rather than fail-closing every asset to illiquid.

The notable part is how liquidation swaps are routed. The platform's
HF-liquidation path isn't tied to one venue — it tries a configurable list of
swap adapters in order. The default testnet setup uses the 0x and 1inch
aggregator adapters, but neither aggregator has a BNB-testnet backend (0x's
swap API covers BNB mainnet but not the testnet). Rather than leave BNB
testnet without a liquidation route, a Uniswap-V3-style on-chain swap adapter
was pointed at PancakeSwap V3 (which is a Uniswap V3 fork with a compatible
router). This gives BNB testnet a fully on-chain liquidation route with no
dependency on an external aggregator API.

To support this, the oracle-configuration script now recognises BNB (mainnet
and testnet) and treats the 0x proxy as optional: when it isn't configured, the
script requires that at least one on-chain swap adapter is already registered
(validated before any transaction is broadcast, so a misconfigured run can't
leave the chain half-configured), so a chain can never end up with no
liquidation route at all. Chains that do have 0x (all mainnets, including BNB
mainnet) continue to require it as before.

The price numeraire follows the platform's canonical rule: the "WETH" oracle
slot must be a bridged-WETH9 (ETH-denominated) token plus an ETH/USD feed —
never the wrapped-native — because the pool-depth valuation assumes
ETH-denominated value. BNB testnet has no canonical bridged-ETH, so a deployed
18-decimal WETH stand-in is used there (mainnet BNB and, later, Polygon use
their real bridged-WETH9). This keeps the configuration production-representative
and identical in shape across every non-ETH-gas chain. The keeper's swap-quote
registry was also given a BNB-testnet entry (PancakeSwap's V3 quoter + the
on-chain adapter index) so the keeper actually produces liquidation quotes for
the chain rather than skipping it.

Every BNB-testnet address was verified on-chain before use (the price feed, the
PancakeSwap factory / router / quoter — the router and quoter both confirmed to
share the oracle's configured factory), and the result was confirmed by checking
that the numeraire asset classifies as liquid on the BNB-testnet diamond. The
adapter-deploy step also validates the router before wrapping it (its factory
must match the oracle's, and its bytecode must expose the swap entry-point — so
the quoter or another periphery contract can't be registered by mistake).

Scope note: this configures the oracle's numeraire and the liquidation route.
Making ordinary BNB-testnet *assets* tradeable/liquid is a separate matter —
that needs real quote-asset pools and per-asset price feeds, and BNB testnet has
only thin real liquidity, so lifecycle rehearsals on the chain deploy their own
mock market fixtures (the same way the positive-flow rehearsal already does).
BNB testnet's role here is a cross-chain mirror; full local lending markets are
a mainnet concern where the real bridged-WETH9 and deep pools exist.

## Frontend — BNB testnet is now a user-facing chain

BNB testnet (chain 97) now appears in the app's network switcher and wallet
network picker, so a connected wallet can select it like any other supported
testnet. Previously it was tracked by the indexer but deliberately hidden from
the app, because its price-oracle configuration hadn't been completed yet — a
half-configured chain would have made lending and risk flows misbehave.

That oracle configuration has since landed (a numeraire price feed plus an
on-chain PancakeSwap-based liquidation route), and sample loan/offer flows are
already being indexed on the chain, so the chain has graduated from
"indexed-only" to fully user-facing.

Making the chain fully usable (not just visible) also required teaching the app
about its liquidation venue. Because BNB testnet has no 0x aggregator backend,
its swaps route through an on-chain PancakeSwap-based adapter. Two frontend
surfaces are now aware of that: the swap-quote registry knows the chain's
PancakeSwap quoter, fee tiers, and adapter slot (so the health-factor liquidation
button works instead of staying disabled), and the create/accept liquidity
preview skips its 0x-only check on chains that have no 0x backend (so valid pairs
are no longer flagged with a false "no route" warning).

One caveat worth knowing on the testnet specifically: only the chain's numeraire
asset is deeply liquid, so offers using other BNB-testnet assets will be valued
and routed conservatively. That is an accepted limitation of the testnet
environment and does not affect the mainnet BNB configuration.

Note for operators: the deployed app must be re-published for this change to
appear on the live site.
