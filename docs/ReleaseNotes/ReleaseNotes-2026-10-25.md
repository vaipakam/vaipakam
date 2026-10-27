# Release Notes — 2026-10-25

Most of today is about selling no more collateral than a debt needs. Liquidations, defaults and periodic auto-liquidation now sell only what the debt or the missed interest requires, and the keeper sizes partial liquidations from the loan's own threshold. A global pause now keeps repayment open and adds the paused time to every open loan's due date and grace end, and the app and the off-chain services read due dates from that same loan clock. On rewards, the day-close safety rules moved into the contract, and remittances now fund one day per send. The indexer's scan finishes whole blocks and leaves the rest for its next pass, so a busy window can no longer freeze a chain. The full regression is green again, and deploy scripts and tests now create facets from their built artifacts. The contract changes are fresh-deploy only and have not reached the testnets.

## Thread — the indexer's scan finishes whole blocks and leaves the rest for the next pass (PR #2836)

The indexer counts every request a pass makes against the hosting plan's three limits (#2647). The scan itself was still unbounded: the work of decoding and storing a window's events. A window busy enough to need more requests than one invocation allows was stopped before the scan recorded how far it had got. Every later pass then re-read the same window and was stopped at the same point, so the chain froze, and it would freeze on exactly its busiest day.

The scan now works through its window one block at a time, in chain order. From the second block on, a request that would use up what the end of the pass needs is refused before it is sent. That covers recording the scan's position and the once-per-pass steps after it. Once one request is refused, every later request in that pass is refused too. The block where this happens is left unfinished. What it had already written stays visible, as any pass's writes are while it runs, and the next pass processes the block again in full. A new loan's row and its starting lender and borrower are written together in one step, because only the pass that first records the loan may record those two, so a stop can no longer leave a loan that its participants' history never shows. The scan records its position just below that block, logs where and why it stopped, and the next pass starts there with a fresh allowance. A pass that stops this way starts the next pass itself, about thirty seconds later, however close to the head it stopped. It does not wait for the regular five-minute schedule, and because it made progress it does not count against the retry allowance. The first block of a pass is never refused, so a pass always makes progress, even on a block heavier than a whole allowance. The steps after the scan (notifications, live-update hints, the protocol-settings refresh) read only the blocks the pass finished. A pass that stops inside a block skips the repair steps that re-read the chain at its recorded position, since the unfinished block has already stored records newer than that position, and the next pass that finishes its window runs them. It also tells connected apps to refresh every view, because it cannot say which records that block had already changed, and the pass that finishes the block will not see those records change again.

What this costs: a busy window now takes several passes instead of one. The amount held back for the end of a pass is a starting value, to be tuned from the spend figures every pass already logs. The database limit stays at the documented 50 queries, by owner decision. The reward and recycling ledgers now repeat three small one-time checks for every block they are given, not once per pass, which lowers how many blocks one pass can finish. They are being changed to run those checks once per pass (#2835). One of those checks, the recycling series' reported-total projection, ran only when there were events to apply. A chain that was caught up, or a window with no events, therefore never brought a stale projection up to date. It now runs with the other one-time preparations at the start of every pass. Refs #2221.

_Committed 2026-10-25 14:37 UTC (b5c6ed832)._
<!-- assembled-fragment: 2221-scan-finishes-whole-blocks.md sha256=0bfa0180cf173be2d60a55c01a33fb5176d0892f616a5ef026e67805c40bd07c -->

## Thread — the payment reminder lane remembers what each pass examined, loan by loan (PR #2845)

The agent's periodic-interest reminder lane works through the loans whose payment deadline is inside the reminder window, nearest deadline first, within a bounded allowance per run. Until now it remembered how far it had got as a single place in that order. A loan that appeared in front of that place waited for the whole pass to wrap round, even when its deadline was the nearest of all. That could be a loan the index had only just found, or a period that had just come into the window. Re-checking the front of the window on every run would not fix that, because loans that are examined but never reminded (nobody to tell, an opt-out, a loan the chain rejects) would then hold the allowance on every run (#2230).

The lane now records, on each loan it examines, which pass examined it and for which payment period. A run works through the loans the current pass has not yet examined, nearest deadline first, wherever they sit in the order. So a newly found loan goes ahead of every unexamined loan due after it, and a loan already examined in this pass is not paid for again until the next pass. When every loan in the window has been examined, the next pass begins. A mark for an earlier payment period counts as no mark, because that is a different reminder. A mark that cannot be read counts as no mark too, so the loan is examined again rather than skipped. The summary says how many such marks there were.

The order is now the deadline the chain enforces, including the time the protocol spent paused. Before, it was the period's unmoved end, which the old stored place had been written in.

The lane also says, on each run, when the current pass has run longer than the reminder window, including on the run that finishes it. From then on, a loan the pass examined without reminding anybody may not be looked at again before its deadline. That is a sign the lane needs a larger allowance or a shorter cadence, and it is now visible instead of silent.

A pass is dated and numbered by its own record, one per chain, which says which pass is the latest, when it began and whether it has finished. The start is written together with the pass's first marks. Reading the start from the marks instead would not work: a marked loan leaves the window once its deadline passes, so a long pass would keep looking recent and never be reported, and a pass whose marked loans had all left would fall back to the previous number. The finish is written together with the pass's last marks, or by a run that finds the window empty, so a loan arriving later begins a new pass instead of joining one that ended days before and having its age reported as a backlog. When the record is missing or unreadable, the next pass begins, numbered above every mark still in the window, and an unreadable record is reported.

The marks are two new columns on the shared loans table, and the pass record is a new table (both in migration 0073). Neither needs a request of its own to read: the marks come with the candidate query, and the pass record is read in the same batch. One write per batch records the marks, and the first and last of a pass carry the pass record in the same write. A run therefore spends one request fewer on bookkeeping than before. The old stored place (`prenotify_scan_cursor`) is no longer read or written. It is dropped by a later migration once this agent is deployed (#2838).

_Committed 2026-10-25 15:39 UTC (828ce8821)._
<!-- assembled-fragment: 2230-prenotify-per-loan-passes.md sha256=bede4b548cfd8720f515a6b09451f82b9414607f0aca44e0d7d89d4c36387674 -->

## Thread — Metrics, fee log and option thresholds on the shared 1e18 valuation (PR #2779)

The last valuations outside the risk and KYC paths now read the same shared
rule the loan risk checks use (#2419): the protocol metrics views, the
treasury fee log, the periodic-interest cadence threshold an offer is checked
against, and the treasury conversion threshold. Each value is in the active
numeraire with eighteen decimal places, one unit being 1e18 whatever the
token's own decimals, rounded down. The two offer facets no longer carry their
own copy of the cadence-threshold conversion; create and modify read the one
rule.

These values inform or switch on an option, and none of them may block what
it is attached to, so each reads the rule best-effort through one shared
helper. Where the rule cannot value an amount (no price, a stale or distrusted
price, a token whose decimal count cannot be read, a value too large to
state), the metrics count that leg as zero, the fee log records the fee at
zero while the fee itself still lands, the cadence threshold treats the
principal as below it (which only ever narrows the cadences allowed), and a
treasury conversion falls back to its time condition. The fee log never
blocks the settlement it records: an entry too large for its field is stored
at the field's maximum, and the running total stops at its maximum rather than
overflowing.

The fee log is a new ledger written only on this valuation, so every entry it
holds and its running total share one scale. A Diamond refreshed in place
starts that ledger empty: its fee totals and revenue windows count only fees
recorded after the refresh, and the earlier log is no longer read. The
per-asset daily revenue figures, which are kept in each token's own amounts,
are unaffected. The reward-accounting valuations and the
Full fee-entitlement tariff quote (whose tariff funds the recycling bucket)
belong to the rewards and recycling work and are not part of this change. Closes #2419.

_Committed 2026-10-25 02:25 UTC (7632b8a41)._
<!-- assembled-fragment: 2419-numeraire-value-best-effort-reads.md sha256=1e61004f354f4cc12329fb47a71e3cd465848b25c946fdfbec4c2fb02be78245 -->

## Rewards — the day-close safety rules move into the contract (PR #2790)

Closing a reward day and finalizing it are both open to anyone. Until now, three of the rules that make those calls safe were enforced only by the platform's own keeper, so anyone else could still make an unsafe call. They are now enforced by the contracts for every caller.

**One report shape.** Mirrors used to send their day report to Base in one of four generations, with fallbacks between them, and only the newest could arrive after Base had finalized the day without being refused once its fee was paid. There is now a single report. It carries the reporting chain's reward-clock start time alongside its figures. The older shapes and every fallback are gone. The platform is pre-live, so this ships by fresh deploy of every reward chain, with no compatibility path.

**The route is checked at the moment of the close.** A mirror's close now tells its messenger which chain the Diamond calls Base. If the messenger is set to send anywhere else, it refuses, so the close fails and the day stays unsent rather than being marked as sent to a chain that will never receive it. A messenger without the report shape refuses the same way. This closes the race where governance rotates the messenger between the keeper's checks and its close.

**Base counts a report's day figures only on its own reward clock (#2620).** A day number covers the same hours on every chain only if every chain's clock started at the same moment. Base now compares the reporter's clock with its own. When they differ, Base still applies what the report says about the chain as a whole (custody era, recycled and commitment totals), announces the mismatch with both times, and leaves the chain unreported for that day, so the day completes or zeroes as if the report had never arrived. A report that lands after its day is finalized is handled the same way and is announced as late. Neither is refused, because a refusal would also throw away the chain-wide figures. The one report Base does refuse is one that arrives before Base's own reward clock is set. There is nothing to compare it against, and dropping it would zero that chain's day for good. Refused, the delivery stays failed and can be re-executed by hand once Base's clock runs.

The fourth rule, that Base's expected-source list can never be empty or leave Base out, was already enforced by #2645. The keeper now prices the one report along the route the close names, and no longer holds days on account of the report's shape. Its clock and channel checks stay in place as a second line of defence, and so does its alert for a close that left through a rotated messenger.

Closes #2620, closes #2621.

_Committed 2026-10-25 01:08 UTC (cd13dc99b)._
<!-- assembled-fragment: 2620-2621-day-report-one-shape.md sha256=efd2b38f3e029fed4b19a6dff7117c629f389a52e0873a6ea1048fbce42a5fd6 -->

## Thread — An unconfigured asset can back a loan; the reserve factor is retired (PR #2817)

Any ERC-20 that passes the liquidity test was meant to be usable as collateral
without per-asset setup, with the per-asset loan-to-value value acting only as
an optional, tighter ceiling. The code read that value raw, so an asset nobody
had configured counted as a 0% ceiling and every liquid loan against it was
refused. A freshly deployed chain therefore refused all liquid borrowing until
governance had set a number for each collateral, and the launch step had to
warn about it. Now an unset ceiling means no extra per-asset limit: a new
loan's size is bounded by the loan-admission health-factor floor and, where
depth-tiered LTV is on, by the collateral's tier cap. A ceiling governance sets
still tightens that, the setter still refuses a value below 10% (so a ceiling
cannot be set to zero), and every reader of the ceiling (loan start, offer
bounds, intent matching, refinance, partial withdrawal, add-collateral and the
previews) goes through one rule. The risk-profile view now says whether a
ceiling is set rather than reporting an unset one as a number, and the launch
step's "not a check" note describes the new behaviour.

The per-asset reserve factor is retired. It was stored and range-checked but no
fee path ever read it; the treasury's cut of interest is the per-loan treasury
fee fixed when the loan starts. The risk setter now takes two values (the
ceiling and the liquidator-bonus cap), its event carries those two, and the
per-asset risk view leaves the retired field out. The storage slot keeps its
place under a declared rename, so an in-place refresh stays possible; the
curated redeploy script removes the old four-argument setter. The admin guide
and whitepaper no longer list the reserve factor or the per-asset liquidation
threshold retired earlier in #999.

Closes #2696.

_Committed 2026-10-25 06:47 UTC (31784c3cd)._
<!-- assembled-fragment: 2696-optional-asset-ltv-ceiling.md sha256=245560cbed033f694c2c3cc9b2fa11315fa42c17a859c388f4aca4ac89fa04f6 -->

## Thread — The flash-loan discount path sizes itself from measured figures (#2697)

The keeper's flash-loan discount path used two placeholders: it took the
loan's debt to be its collateral amount, and its gas headroom to be a fixed
1e18 base units of the principal token, which is one token only for an
18-decimal principal. It also quoted the swap for the whole collateral,
whatever the liquidation would actually deliver. No chain has the
FlashLoanLiquidator deployed, so nothing moved, but the path could not be
armed usefully.

The platform now publishes a preview of the discounted liquidation, on the
forced-sale host beside the forced-sale preview: whether it can run (and if
not, the first reason it cannot), the debt the liquidator pays, the
collateral delivered and the surplus left for the borrower. The figures come
from one shared rule, which the liquidation itself now charges and seizes by,
so a reading inside the same transaction is exactly what the liquidation
does. The one exception is named in the preview's own description: a
collateral token that delivers less than it sends. Its recipient receives
less than the seizure, and a liquidation that first moves the collateral to
a new holder of the borrower position can seize less, so for such a token
the previewed seizure is an upper bound on what arrives. The flash-loan
receiver refuses a run that delivers less than its swap was quoted for. The FlashLoanLiquidator reads that preview in the liquidating
transaction and flash-borrows exactly the debt, takes the loan's assets from
it rather than from its caller, clears its Diamond allowance after the call,
and sells exactly the collateral its swap was quoted for. Each run also names
the least profit it must keep, and the receiver reverts below it. Each owner
call now runs at most one liquidation: the receiver commits to the one
callback it expects and spends that commitment, so a second flash loan opened
mid-run cannot make it run a swap it was not asked to.

The keeper reads the preview, quotes the swap for the previewed seizure,
estimates the exact call (which simulates the whole run, including the real
flash-loan fee), and sets that least profit to the transaction's whole fee
converted by the Diamond into the principal token's own units. A loan the
preview rules out, a chain whose gas the keeper cannot value, or a trade
whose simulation reverts is skipped with its reason logged. The fee
measurement the auto-roll pass already used moved into one shared module so
both passes price gas by the same rule. The FlashLoanLiquidator's entry
points changed shape; it is deployed nowhere, so nothing needs migrating.
Closes #2697.

_Committed 2026-10-25 19:28 UTC (4d4defc22)._
<!-- assembled-fragment: 2697-discount-path-measured-figures.md sha256=a84ca6a319ac8957ee12c8ea26c5d5924a5f65f1b1236655a53ab83e50c31431 -->

## Thread — Deploy scripts create facets from their built artifacts (PR #2793)

The Diamond build and refresh scripts (the fresh deploy, the all-facets
refresh, the curated refreshes, the oracle upgrade, the risk-terms migration
and the slippage census) now create every facet, the Diamond itself and the
three cross-chain implementations the refresh replaces from the creation code
Foundry already wrote for them, instead of compiling that code into the
script. What goes on chain does not change: the same code, from the same
sender, at the same address, broadcast as the same contract-creation
transaction with the contract's name attached for verification.

The reason is build cost. Compiling every facet into the deploy script also
compiled it into each deploy-sanity test and probe that builds or inherits
the script, and the compiler optimized all of it again for each one. One
suite and its probe took nearly eight minutes of compiler time on a warm
cache, and the deploy-sanity step of the per-PR contracts job had grown to
about an hour. Each facet is now compiled once per build. The artifact stays
current because each script names the facet through its type, which only
compiles when the script imports the facet's source, so a changed facet is
rebuilt before the script or test runs.

The shared test setup and the individual test suites still compile their
facets in; moving them onto the same helper is #2789. Closes #2718.

_Committed 2026-10-25 01:15 UTC (12f374bc3)._
<!-- assembled-fragment: 2718-deploy-scripts-deploy-from-artifacts.md sha256=2b8f0488a3388735da3325a0dc0f0a031c971506d64e9e0cdaabccd068311ec6 -->

## Paid Push alerts — the billing consent on the alerts page (PR #2820)

The alerts card in Settings now shows the on-chain consent a wallet gives to be charged for paid Push alerts. For the network it is on, it states the fee per loan side in VPFI as the contract currently configures it, that the fee is paid from the free VPFI in the wallet's vault, at most once for each loan the wallet is on, and that Telegram alerts stay free. It states the most the wallet has agreed to pay and whether that covers the current fee, using the contract's own answer. If a later refresh from the chain fails, the card keeps the last figures it read but labels them as possibly out of date and pauses agreeing until a read succeeds. Withdrawing the consent is always offered while one is stored. That holds whatever the alert service says about billing, even when no alert service is configured. Withdrawal passes the Terms gate as an exit, and the contract keeps it open while the protocol is paused.

Agreeing to pay is offered only where something actually charges the fee. Whether Push is billed is now the alert service's own answer: its Push status lists the networks it bills on. Today that list is empty, because no service calls the billing entry point yet, so the card says paid Push isn't billed and offers no agreement. When a biller ships, it lists the networks it bills on, and the card then offers agreement at the current fee. It also warns when the vault's free VPFI is below the fee. The functional spec now records what that biller must do: skip a payer whose consent does not cover the fee, or whose loan is no longer active, and report a skip as a skip.

Building this surfaced a divergence, recorded in the code-versus-spec audit for an owner decision. The spec describes a numeraire-priced fee sent straight to the treasury. The contract charges a flat VPFI amount through Diamond custody into the recycle bucket. The card states the fee exactly as the contract charges it. Closes #2723. The per-event paid Push toggles in the spec are not built, because there are no paid event alerts to toggle yet.

_Committed 2026-10-25 08:30 UTC (cdaf281c0)._
<!-- assembled-fragment: 2723-paid-push-billing-consent.md sha256=032f1de311255b70fb4825663d5d5dde721f433547541d798fb5560ddd8388d6 -->

## Paid Push alerts — honest on networks whose contracts predate the consent

The paid Push section of the alerts card used to show only "We couldn't read your paid Push agreement" on a network whose contracts are older than the consent record, and suggested trying again later. Base Sepolia and Arbitrum Sepolia are in that state today, so retrying would never help. On such a network the card now says the contracts are an older version without the agreement, so agreeing and withdrawing aren't available there. It still shows the fee and whether the alert service bills on that network.

It also states whether that older version can still charge the fee, read from the contract's own routing. On both testnets the billing call is still routed and predates the consent check, so the card says the fee may be charged without an agreement, and no longer suggests the wallet can't be charged. Nothing calls that billing route today. The card names an older version only when the contract itself answers that the consent function doesn't exist. Any other failure is still a failed read.

The two lines are worded so they can't be read as contradicting each other. The billing line attributes its answer to the alert service ("The alert service doesn't charge this fee on …"). The older-contract line says the contract version would let the billing role charge the fee directly, separately from the alert service.

_Committed 2026-10-25 09:29 UTC (a00666e5a)._
<!-- assembled-fragment: 2723-paid-push-older-contracts.md sha256=7d03f3ac8309500f1fd6aa408bdf4a493f24ccfdf7d7b49ad4c83d516e7ca35e -->

## Keeper — partial liquidations sized from the loan's own threshold (PR #2800)

The keeper's partial-liquidation sizer was reading the wrong number. It took the
liquidation threshold from the oracle's asset risk profile by position, but that
profile stopped carrying a per-asset threshold when thresholds moved to per-tier
values, so the position it read had become the liquidation bonus — a few hundred
basis points where the sizer expected a threshold near 80%. Partials came out
mis-sized, the contract refused them, and the keeper moved on towards a full
liquidation, selling more of the borrower's collateral than the lender needed.

The keeper now reads the threshold from the loan itself: the per-tier threshold
stamped on the loan when it opened, which is the exact figure the contract
computes the loan's health factor with. It arrives on the loan read the keeper
already makes, so the separate oracle read is gone. Every loan field the keeper
uses is read by name and checked against the compiled contract interface in a
test, so a future change to the loan's shape fails that test instead of quietly
shifting what the keeper is fed. A loan whose fields do not decode as expected is
left alone rather than acted on.

The re-sizing loop also gave up too early, and in one case never at all. It
allowed three submissions, so a slice refused as over-liquidating could be shrunk
once more and then escalated to a full liquidation without the smaller size ever
being sent. And a slice refused as too small to restore the health factor was
simply left for the next tick, which recomputed the same size and was refused the
same way, so such a loan was never liquidated. The keeper now searches: every
refusal says which side of the allowed band the slice fell on, the keeper keeps
the largest size known too small and the smallest known too big, and it tries
sizes between them. It falls back to a full liquidation only when no partial size
within bounds is left, which is when a full liquidation is the lender's way out.

Closes #2733.

_Committed 2026-10-25 03:12 UTC (f829d04a5)._
<!-- assembled-fragment: 2733-keeper-partial-sizing.md sha256=f68adf46b5074e4f9c072db0a9e58826854efd4e156591b1c68b063a9e331e56 -->

## Thread — The handover moves every owned contract, and Diamond ownership needs the owner (PR #2844)

Two gaps in the governance handover are closed. First, the all-in-one
admin transfer could move the Diamond's ownership for any holder of the
role root, even one that was not the owner. Ownership carries the right to
replace facets, so the transfer now also requires the caller to be the
current owner, as every other ownership change does. After the handover
both are the Timelock, so nothing changes for a correctly handed-over
chain; the check keeps the two authorities from being taken with one of
them.

Second, the 0x and 1inch swap adapters stayed owned by the key that
deployed them, and nothing in the handover or its exit gate looked at them.
Their owner edits the list of addresses a liquidation swap may call, so a
leaked deploy key could have added a hostile one. Adapters are now created
owned by whoever governs the Diamond at the time (the admin before the
handover, the Timelock after), never by the deploying key. And the
handover no longer works from a hand-kept list of owned contracts: it finds
them, from the chain's deployment record and from what the Diamond itself
names (its registered swap adapters, its rate model, its satellite
contracts), and moves every one whose owner is not the Diamond to the
Timelock. That brings the sanctions-list contracts along too. The exit gate
checks the same found set, so a contract still on the deploy or admin key
fails it, and on a production chain the handover refuses to start while any
owned contract sits on a key it cannot move. The scripts that record a
chain's storage layout now share the same walk over the chain's contracts,
so there is one list of what a chain consists of, not two.

One consequence is deliberate and stated: rotating 0x's Settler addresses
on an adapter is a governance action after the handover and waits out the
Timelock delay. Until it lands, a 0x quote naming the new Settler fails
that route and the swap failover tries the next adapter. Closes #2743.

_Committed 2026-10-25 14:33 UTC (a3d1f12c6)._
<!-- assembled-fragment: 2743-handover-owned-contracts.md sha256=93aa2e2af8cbd474171efb693e69b16437aad5ff66c214b3fa42a2c6a9a52dfd -->

## Thread — A watcher key can no longer chain auto-pauses (PR #2837)

The anomaly watcher's auto-pause freezes the protocol for a bounded window (30 minutes by default, at most 2 hours), and a running window was never extended. But nothing stopped the same watcher key opening the next window the moment the last one lapsed, so a compromised key could keep the protocol frozen for as long as nobody revoked its role. Since the D2 loan clock, every paused second also moves every open loan's due date and grace end later, so a chained freeze delays every exit as well.

An auto-pause that would freeze a live protocol now has to wait out a cooldown after the end of the last such window: 24 hours by default, settable by the admin role (the Timelock after handover) between 1 hour and 7 days, never to zero. On its own, a watcher key can now freeze the protocol for at most one window in every window plus cooldown, which is 2 hours in 26 at the longest settings. The cooldown runs from the window's scheduled end, so an unpause that cuts a false positive short does not reset it. A refused call reverts with the time the next window may open, so the watcher learns it did not pause anything, and the Diamond reports that time and the cooldown in force. A window recorded while the manual pause is in force freezes nothing more, so it neither waits for a cooldown nor starts one. Anything longer than a window is the manual pause, which only the pauser can set and only the Timelock can lift.

The cooldown lives in the pause library's storage, appended at its tail. The knob reference documents it. The Protocol Console does not show it yet, and the coverage map says so. Closes #2744.

_Committed 2026-10-25 13:40 UTC (dac87c8de)._
<!-- assembled-fragment: 2744-auto-pause-cooldown.md sha256=9e0311f2500cc6abb855731937afd59fe4adcfe0f4927ce69a28bf1c5982d944 -->

## Keeper — Tier 3 needs evidence the asset is used as collateral elsewhere (PR #2806)

Before the keeper's liquidity relay promotes an asset to the deepest tier, an
off-chain advisory checks that the asset is "battle-tested elsewhere". It used
to pass on any two of three signals, and two of those, market cap and trading
volume, come from the same CoinGecko response. So a popular, volatile token with
no lending-market footprint could pass on CoinGecko alone, which the advisory's
own description said must not happen. Its lending-market signal also counted any
pool that held the token, including supply-only pools and markets on a venue
where anyone can list any collateral.

The lending-market signal is now required, and it now means collateral. The
asset must be enabled as collateral, with a loan-to-value above zero as DeFiLlama
reports it, on an Aave v3 or Compound v3 pool with at least the configured TVL on
that chain. Market cap or trading volume must back it, but neither can stand in
for it. Morpho Blue no longer counts: its markets are permissionless, so a listing
there says nothing about a curator's decision. Aave's zero loan-to-value is
ambiguous (not collateral, frozen, or e-mode only) and is read as no evidence.
An operator who turns the lending-market signal off now gets no Tier 3
promotions at all, since market presence cannot stand in for collateral evidence.
The keeper also keeps only the rows it needs from the two DeFiLlama responses
instead of the whole pool list.

Closes #2746.

_Committed 2026-10-25 03:32 UTC (b136f3728)._
<!-- assembled-fragment: 2746-tier3-collateral-evidence.md sha256=3311bc28a405ce23e8c1961df92654f6cf9cb9b15432c38cdaca0c42bf0ad060 -->

## Lender intents: priced assets and a minimum fill value (#2760, PR #2815)

A standing lender intent could be registered on any pair of tokens with a smallest fill of one unit. Funding it with that one unit put it in the discovery feed the keeper reads every run, so junk-token intents could be added at almost no cost.

Registering an intent now needs two more things. Both of its assets must be priced by the platform's own value rule; every fill is sized from the lender's loan-to-value ceiling, so an unpriced leg could never fill anyway. And its smallest fill must be worth at least a governance-set minimum, 100 numeraire units by default. Governance can set the minimum between 1 and 1,000,000, and it goes back to the default when the numeraire changes.

The rule is checked when the intent is set. A later price move, or a raised minimum, does not remove an intent that was already admitted; setting it again applies the rule again. The feed lists an intent only once its funded capital covers one smallest fill, so the minimum is also the least capital each listed intent commits.

The Protocol Console shows the minimum beside the standing-intent fill switch, and the admin parameter reference documents it. Each setting the console publishes now names the events that announce its change, and the indexer's snapshot refreshes on exactly those, so a changed minimum shows within one scan. Writing that list down found the ETH reference feed can also be changed by a setter that announces nothing, so the console now says its snapshot can lag, as it already did for the sequencer uptime feed.

The rule applies to every intent, including the backstop vault's and the aggregator adapter's. Fresh deploy only: no live chain carries it until the post-waves testnet refresh. (Owner decision 2026-10-25.)

_Committed 2026-10-25 07:50 UTC (2ab8e6095)._
<!-- assembled-fragment: 2760-intent-admission-rule.md sha256=5590d84034f26e45df546b0112d707203f636248930cb931f829a11fa618b019 -->

## Keeper matcher: each pair considered once, a dust refusal no longer ends the fill search, and dust rolls are left to their owners (#2760, PR #2807)

The keeper's offer matcher now reads each live offer once per run. The order book is read page by page and can change while it is read, so an offer could appear twice; it is now dropped the second time. That lets the matcher visit each lender and borrower pair at most once without keeping a list of every pair it tried, which grew with the size of the book.

A party holding offers on both sides of a market can never be matched against themselves. The matcher used to compare every such pair one by one, for free, which let one party make it do work in proportion to the product of their offers. It now groups each market's borrower offers by who created them and passes over the lender's own group in one step.

When the keeper sizes an auto-lend fill and the borrower's collateral cannot cover it, it searches for a smaller fill. It used to give up if the smallest legal fill was refused for any reason. A refusal that only a too-small fill can meet (below the intent's minimum fill, below the borrower's minimum amount, below the collateral floor, or collateral that rounds to zero) does not prove anything about larger fills, so the search now continues above it, within the same small number of previews. Every other refusal, such as collateral, the risk check, the borrower's verification tier or the keeper's capacity, still moves the search to smaller fills, because each of those refuses larger fills too.

Anyone can delegate auto-roll to the keeper, and the keeper pays each roll's gas with nothing back. It now rolls a repaid intent loan only when the amount re-lent (the lender's proceeds, principal plus interest) is worth at least 100 times the roll's whole fee, both valued by the Diamond's own pricing rule, with the fee valued through the chain's wrapped native token. On Base and the other OP-stack chains the fee includes the L1 data fee and the operator fee charged on top of the gas, and a part the keeper cannot read means no roll, never a part taken as zero. Smaller loans are left for their owners to roll or claim themselves, and each run logs how many were declined. Where the keeper cannot value the fee, because it knows no wrapped native token or fee model for the chain, it rolls nothing there and says why. That is the case today on BNB Testnet, whose deployment carries a mock WETH, not wrapped BNB. (Owner decision 2026-10-25.)

The matcher's failure lines no longer print the RPC address, which carries the provider's API key. They now name the contract's revert reason where there is one. The same rule is shared with the delivery-proof and reward-horizon passes.

No contract change. The admission rule for lender intents (#2760 item 2) is a contract change and ships separately.

_Committed 2026-10-25 04:48 UTC (ce99e2210)._
<!-- assembled-fragment: 2760-matcher-walk-bounds.md sha256=3fe87026487b64cc6419b720227bee36d99b0e30c33ddb7a973f6be6ad710ca8 -->

## Reward remittance: each day says why it does or does not close (#2760, PR #2826)

The keeper's reward-remittance pass warned, every run, about each finalized day that was neither remitted nor closed. It could not tell a day still owed but gated (waiting on its commitment report, or short of recycled backing) from a day that owed the mirror nothing, so on a quiet mirror the warning repeated for every zero-budget day in the scan window, and the operator had to check each one by hand.

Base now states, for each day it is asked about, the send's own verdict: already remitted, already closed, nothing owed to that mirror, remit-ineligible (funded through the manual budget path), awaiting its commitment report, short of recycled backing, or closeable now. It is a read-only view over the same plan the send applies, so it cannot disagree with a send. Nothing about funding changes.

The keeper now names only the days still owed and not closeable, each with its reason, and counts that mirror as not yet settled until they close. A day that owed the mirror nothing is no longer reported. Against a Diamond without the new view, the keeper keeps its earlier warning. The incident runbook's stand-down rule is updated to match. (Owner decision 2026-10-25.)

_Committed 2026-10-25 11:10 UTC (0b69c65a2)._
<!-- assembled-fragment: 2760-remit-day-status.md sha256=2076d833a21f1a7b5fad609fe73b0a4a42c5b0a3d4140ffdda7631e557d92a88 -->

## Keeper — the "delivery not whole" alert counts from when the keeper found it (PR #2797)

The keeper warns the operators when a reward-budget delivery that has reached a mirror is still not fully indexed or proven. It allowed ten minutes from the delivery's arrival. On Arbitrum Sepolia the first two batch deliveries were indexed 8.8 and 9.4 minutes after they arrived, one slow scan away from a false alarm. BNB Testnet's took 4.4 minutes.

The cause is where the keeper learns about a delivery. It reads the indexer's record, and the indexer records a block only once the chain calls it settled. Arbitrum declares blocks settled minutes after they are made, because that waits on its posting to Ethereum; BNB does so almost at once. So on Arbitrum the keeper first saw each delivery one scan later, and most of its ten minutes had gone before it could act. This is inferred from the indexer's settled-block rule and the scan times; the settled-head lag itself was not measured here.

The allowance now starts when the keeper first finds the delivery, measured on the keeper's own clock: a delivery is reported only if the scan that found it and the next full scan both leave it incomplete. The bound sits half a scan away from the scans on either side of it, so a late or early scan cannot tip a normal delivery into an alert. The alert names when each delivery arrived and when it was found. A delivery the indexer has not recorded yet raises nothing from this alert, as before. The keeper's scheduled passes whose alerts are measured in scans are now scheduled from their own cadence, so the two can no longer disagree. Nothing on chain changes.

Closes #2775.

_Committed 2026-10-25 01:59 UTC (262d7d6f1)._
<!-- assembled-fragment: 2775-delivery-alert-from-discovery.md sha256=35643cdef7fe77ee4666de0fec04e8f06e48534f1ad334eac1bc2e09502c32e2 -->

## Thread — the full regression is green again (PR #2785)

The first full pre-deploy regression run since several reward changes landed found two failures that the per-PR lane cannot see.

**The reward remittance's destination gas is re-derived.** Each reward budget Base sends to a mirror asks the mirror to run its receiver with a fixed amount of gas. That figure is derived from the mirror's measured cost of taking in a delivery, plus a reserve for the receiver's own work, plus a quarter's margin. The intake has grown since the figure was last measured (from 685,689 gas to 710,205), so 1,000,000 no longer left the full quarter's margin. A test exists to catch exactly that, and it failed. Deliveries on the testnets were not failing: the gas still fit, only with less margin than the rule requires. The figure is now 1,050,000, derived by the same rule. The only effect on funds is a slightly higher cross-chain fee on each remittance, for the extra destination gas. Base quotes that fee on-chain from the same figure, so the sender is never short. No amount delivered changes.

**A reward test suite no longer crashes the compiler.** One test suite for the closed-day proof could not be compiled: the pinned Solidity compiler stopped with an internal error, and every other suite compiled alongside it went unrun. The suite is now two test contracts over one shared setup, one for days that prove closed and one for walks that refuse or keep a day open. The tests themselves are unchanged. The compiler defect is noted on the issue; a compiler upgrade would be a separate decision.

Closes #2777.

_Committed 2026-10-25 00:38 UTC (9b3fe1450)._
<!-- assembled-fragment: 2777-full-regression-red-on-main.md sha256=3f2383a77017e2a97f7a857890d5e49bd733361857937498e994883cba8cd1d9 -->

## Thread — Test suites create facets from their built artifacts (PR #2798)

The shared test setup, the invariant base and the individual test suites now
create every Diamond facet from the creation code Foundry already wrote for
it, through the same helper the deploy scripts adopted in #2718, instead of
compiling each facet into every test contract. The Diamonds the tests build
are unchanged: the same facets, the same code and the same addresses.

Most test suites inherit the shared setup, and that setup deployed every
facet, so each suite carried a full copy of all of them for the compiler to
optimize again. A regression chunk of twenty-five suites took six to
seventeen minutes, nearly all of it compiling. Each facet is now compiled
once per build. Run on the forty-five suites this change touches, in four
groups of about twelve, the groups took two and a half to five minutes each,
compile included, and every test passed.

One suite keeps compiling two facets in on purpose: it compares refreshed
code against a fresh copy as an independent check that the artifact in use
is this tree's build. Closes #2789.

_Committed 2026-10-25 04:39 UTC (93b64463e)._
<!-- assembled-fragment: 2789-test-suites-deploy-from-artifacts.md sha256=5b52534e1dfd3082eebb6e83aaeb7ac85268af15fcb32f8c3fe6759dd7cd8a2a -->

## Thread — periodic auto-liquidation sells only what the missed interest needs (PR #2811)

When a periodic-interest payment is missed and the protocol sells collateral
to cover it, the sale is now sized to what is owed: the missed interest plus
the handling charge and the caller's incentive, both taken on that debt (2%
and up to 3% of it), at the worst price the slippage limit allows. The lender
is paid at most what was owed. Whatever the sale raises beyond that belongs to
the borrower: it goes to the borrower-position holder's wallet in the same
transaction, or, when that holder is flagged or the wallet payment cannot be
completed, it is held in the borrower's vault and paid with the borrower's
claim when the loan ends. If the borrower position is handed over to a
replacement borrower first, the held amount is paid to the exiting holder
along with their released collateral. Before this change the sale used a fixed
buffer and the lender was credited with everything above the charges.

The borrower's claim now pays each of its parts on its own flag (remaining
collateral, held proceeds, a pending fee rebate) and refuses only when all of
them are paid or empty, so an extra held earlier in the loan is still paid
when the loan later ends with nothing of the collateral left for the
borrower; the lender's claim no longer settles the loan while it is unpaid.
The app's claim list follows the same rule. When an obligation handover moves
VPFI out of the exiting borrower's vault, their VPFI standing is refreshed.

The rule lives in one place, a new forced-sale facet that sizes the sale,
sells it through the usual swap failover and splits the proceeds lender first.
Every figure of each sale is published in one new event (debt, the amount the
sale had to raise, collateral sold and left, proceeds, and each share), and the
periodic auto-liquidation event now names the borrower's share and whether it
was held. The old slippage notice is gone, since the lender is no longer
credited with a shortfall the sale did not cover. The other forced sales
(Health-Factor liquidation, the time-based default and partial liquidation)
move onto the same facet in follow-up work (#2796).

Deployment note: the new facet is refreshed together with RepayPeriodicFacet,
PrecloseFacet, EncumbranceMutateFacet and the facets that consolidate a
position. Closes #2795.

_Committed 2026-10-25 09:28 UTC (fa0bb44a7)._
<!-- assembled-fragment: 2795-periodic-forced-sale-sized-to-debt.md sha256=78b22f6f29a73086f85f2eca0f3b267c7f3b12f0b472c01c9ab5c71535fc44ce -->

## Keeper — a periodic-interest settler pass (PR #2833)

Nothing settled an overdue periodic-interest period unless someone called the settlement by hand, so a lender on a cadence loan whose borrower missed a period was not paid until a person noticed. The keeper now has a pass that does it. Every 15 minutes, one chain at a time, it reads the contract's settlement preview for a window of the active loans and picks a loan whose period's grace is over. If the borrower already paid the period, it sends the settlement that only moves the checkpoint forward. If interest is short, it quotes the sale for exactly the collateral the contract sizes to the shortfall (the sell-to-need rule from #2795), never the whole collateral, since an aggregator quote encodes its sell amount and a quote for any other amount fails every route.

The pass leaves a loan below the liquidation line to the liquidator and a loan past its maturity grace to the grace-default pass, because each of those closes the whole loan and two passes deciding about one loan would race. At one fresh block it re-reads both, re-reads the contract's sale size, and simulates the exact call. It sends only when the size is unchanged and the simulation succeeds. A periodic settlement whose every route fails reverts rather than falling back, so the simulation is a true test of the sale at that block. The one gap no read closes is between that block and inclusion: if a price moves enough to change the size, the settlement reverts, the keeper pays the gas, and nothing moves.

The pass ships switched off. It needs its own `PERIODIC_SETTLE_ENABLED` flag on top of `KEEPER_ENABLED`, and arming it is an owner decision. The grace-default pass's active-list window and batch rotation moved into shared helpers so both passes read the list the same way.

_Committed 2026-10-25 11:46 UTC (314ac2a1d)._
<!-- assembled-fragment: 2795-periodic-settler-pass.md sha256=f8210344c53828eddab1849f071b7745b47c1dd4095a55dffb817e828ff860fc -->

## Thread — liquidations and defaults sell only what the debt needs (PR #2834)

A Health-Factor liquidation (single route and split route) and the liquid
branch of a time-based default now sell only as much collateral as settling
the loan needs, the same rule the periodic auto-liquidation adopted in #2795.
The sale offers the least collateral whose worst-case proceeds cover what the
borrower owes plus the 2% handling charge and the largest caller incentive,
both now taken on that debt rather than on the proceeds. The lender is paid
first and in full whenever the sale covers the debt; the handling charge comes
only after the lender. The collateral that was not sold stays pledged in the
borrower's vault and is taken with the borrower's claim, and any proceeds
beyond the debt and the charges are held there with it. When even all the
collateral cannot cover the debt, the sale sells all of it, pays the lender
first, and says so in its settlement event. When every route fails, the whole
collateral still goes into the in-kind fallback exactly as before.

Whoever triggers a forced sale now names the amount of collateral it is
selling, because every route is an exact-input swap. The protocol publishes
the plan first: the least covering amount and the most it accepts, which is
up to 2% above that amount while the debt can be covered (the debt accrues
and prices move between the quote and the block), or exactly all the
collateral when it cannot. Any other amount is refused before anything moves.
The liquidation, default and periodic-settlement calls each gained that one
argument; on the split route the amount is the sum of the legs. Keepers must
read the plan and quote within it before these contracts reach a chain.

A time-based default that will not sell publishes no plan. When the loan's
prices are missing (it enters the fallback without a sale), when its
collateral moves to the lender in kind, or when the default is refused, the
plan is empty and needs no price, and the default is sent with no amount.
The default and the plan read the same route rule, so a plan exists exactly
when the default sells.

Partial liquidation keeps the keeper's choice of how much to sell, but its
incentive and handling charge are now shares of the amount repaid rather than
of the proceeds taken alongside it, so the lender receives every unit the
charges do not. A sanctioned caller of a time-based default still triggers it
but earns no incentive. All forced sales now publish the same settlement event
with every figure. Fresh deploys only; nothing reaches a testnet until the
remaining work waves are done. The 2% quote margin is the owner's decision.
Closes #2796.

_Committed 2026-10-25 16:20 UTC (4a788f7dc)._
<!-- assembled-fragment: 2796-liquidations-and-default-sized-to-debt.md sha256=bb1678e475388ed488a062ee205f56035784971fd5bed7fd6f76b815e7ec97f8 -->

## Thread — The app states loan due dates on the loan clock (PR #2830)

Since the D2 pause change (#668 / #935), a pause moves every open loan's due
date and grace end later by the time the protocol spent paused since the loan
started. The contracts and, since the previous change, the indexer and the
reminders work from the moved dates. The app still showed and checked the
original ones, so after a pause it would have shown a borrower a due date
earlier than the one the chain holds them to, warned of a late fee that is not
charged, and refused some sales, offsets and handovers as too long for a loan
that in fact had the time.

The app now reads the protocol's pause record with every live loan read and
works from the moved dates everywhere a deadline matters: the loan page, the
positions list, the late-fee and grace checks before a repayment, cure,
preclose or refinance, the term a sale, offset or obligation handover must fit
inside, and the remaining interest a sale or transfer is priced over. Where a
pause moved a loan's due date, the loan page says so in its own row: the
original date, how far the pause moved it, and why. While a pause is in force
the page and the list say the date is still moving rather than naming one, and
a loan the app cannot date says the due date is unknown rather than showing
the original date as current. When the list reads a wallet's loans from the
chain, it dates them from one read of the pause record and the grace schedule
at a single block. A rental's paid-use end date is not moved, because a pause
does not extend paid use; only its late-fee and default deadlines move.

The new wording is translated into the nine translated languages. Contracts
deployed before the loan clock have never moved a date, so on those chains
(the current testnets until their next refresh) nothing visible changes.
Refs #2808.

_Committed 2026-10-25 11:32 UTC (a105d85a2)._
<!-- assembled-fragment: 2808-app-loan-clock.md sha256=f5a86e234613fb4c7f1c597b31c5a2f9d6872b6d097ed9dde4038dc7e7e0a8f4 -->

## Thread — Off-chain deadlines follow the loan clock (PR #2822)

Since the D2 pause change (#668 / #935), a pause moves every open loan's due
date and grace end later by the time the protocol spent paused since the loan
started. The contracts enforce the moved dates, but the indexer and the agent
still worked from the original ones, so after a pause they would have
reminded people too early and shown dates the chain no longer applies. This
change moves both onto the same rule the contracts use, written once in the
shared library and fed by one copy of the protocol's pause record.

The indexer now keeps the pause record beside the grace schedule it already
stored, refreshes it on every pause, and serves each active loan's original
due date, the pause credit, the moved due date and grace end. When it cannot
establish the pause record it says the dates are unknown and why, instead of
serving the original ones. Calendar reminders use the moved due date and are
held while a pause is in force, since the date is still moving; a pause that
moves a loan's due date re-arms its reminders for the new date. The
periodic-interest reminders work from the moved payment deadline, and a
reminder whose deadline a pause moved says by how much and why. Contracts
deployed before the loan clock have never moved a deadline, so on those
chains (the current testnets until their next refresh) nothing changes.

Dating a loan from its own start also needed the indexer's copy of that start
to be right. When a borrower hands an obligation to a replacement borrower,
the loan stays open but starts a new term: new collateral, rate, duration and
start time. The indexer used to record only the new borrower and keep the old
term, so it would have dated the loan from the exiting borrower's term. It now
reads the new term from the chain at the handover and records it.

The periodic-interest reminders now spend one more request per chain per
run, so a run reaches one loan fewer before its allowance runs out. The
reminder window is days wide, so a loan left for a later run is still
reached in time.

The keeper works from the moved due date too. Its liquidation pass decides
whether a partial liquidation is still allowed against the moved date, which
is what the contract checks, so a loan a pause kept in term is no longer sent
straight to a full liquidation. Its auto-refinance warning before grace counts
the time left to the moved date, and is held while a pause is in force. When
the keeper cannot read the pause record it skips the loan, or the chain's
warnings, for that run and says why, rather than acting on the original date.
The app's loan pages follow in their own change. Refs #2808.

_Committed 2026-10-25 10:01 UTC (78d04c292)._
<!-- assembled-fragment: 2808-off-chain-loan-clock.md sha256=6b0810f22d842d5197347715ba7bcd187b6f073bb1e3947f7445a8df13682b29 -->

## Thread — Configuration reads by name, at their own shape (PR #2839)

The app, its protocol console and the indexer now read the protocol
configuration bundle field by field, by name, and only when the chain's
answer has the shape they were built for. Retiring the range flags took two
values out of the middle of that bundle, which moved every value after them.
Until now the app took the offer-duration cap from a fixed position. On a
Diamond still running the older configuration facet, that position would
have held a different number, on the screen and in the check made before
signing. The same was true of the indexer's snapshot and the console's
labels.

Every reader now checks the length of the answer first. If the length is
not the one its own build describes, the answer comes from a facet it was
not built against, so the reader reports the figures as unknown and gives
the reason instead of decoding them. A signing step refuses, as it would
on any failed read. A display keeps its stated default and stays marked as
not ready. The indexer's snapshot records why it holds no figures for the
bundle, while the grace schedule, the pause log and the other settings are
still captured. The snapshot endpoint no longer serves the retired
three-flag list. The matching switch is now one of its named values, and
the app reads it from its own getter, which answers the same on every build.
The protocol console shows that switch as the one remaining feature flag
and says what it does.

Until the testnets get the next fresh deploy, they still run the older
facet. In that window the indexer stores their bundle as unknown, and the
app deployed there today, which still expects the retired list, falls back
to its own chain reads. Dropping the two unused snapshot columns
(#2840) and bringing the same shape check into the live test drives (#2841)
are follow-ups. Refs #2812.

_Committed 2026-10-25 17:41 UTC (b67d7e5d7)._
<!-- assembled-fragment: 2812-config-reads-by-name.md sha256=c42294b462e07a6797364d7ab9deef896ef1750b346a0f63de416ad15f5781e9 -->

## Thread — Retire the dead range flags (PR #2839)

Ranged offers are now always on, and the three flags that claimed to switch
them off are gone. The two range master flags (one for ranged amounts, one for
ranged rates) and the borrower-side collateral range flag had not been read by
any contract path for some time: an offer's range was accepted or refused by
its own bounds, never by these flags. They still had admin setters, getters and
configuration events, so an operator could "turn ranges off" and nothing would
happen. The owner decided on 2026-10-25 to remove them rather than leave a
switch that does nothing.

Their setters, their getters and the three-flag status read are removed from
the configuration facet, and the protocol configuration bundle no longer
carries the two range fields. The storage slots stay where they are, marked
retired, so the layout is unchanged. The matching kill-switch (partial fill)
stays: while it is off the order matchers refuse and an accepted offer fills
once, and while it is on a ranged offer can be filled across several matches.
The match preview now reports
that switch too: before this change it did not check it, so with matching off
it could say a match would succeed when the match itself would be refused. It
now reports the matcher as disabled, and a paused protocol or a sanctioned
matcher, the other two checks the match makes first, are reported the same
way. The deploy scripts now turn on only that switch. A curated in-place refresh
removes the six retired entry points from a Diamond that still routes them, so
the old build cannot keep answering for them.

This reaches a chain with the next fresh deploy. Until then the live testnets
still run the old configuration facet, whose bundle carries the two retired
fields. The app, indexer and e2e tooling move with this change (they read the
matching switch from its own getter). Refs #2812.

_Committed 2026-10-25 17:41 UTC (b67d7e5d7)._
<!-- assembled-fragment: 2812-retire-range-flags.md sha256=5a139717db9e48d6545e56121591308823f38f7a47f793ea06d99bce87c5cd7b -->

## Thread — Reward remittances fund one day per send (PR #2832)

A reward remittance from Base to a mirror now funds exactly one day. Before,
one send could fund several days, and the mirror received them as one shared
batch whose balance paid all of those days at once. The mirror held such a
batch back while more than one of its days was still open, and a day closes
only once every reward entry covering it has claimed past it. A loan open
across those days therefore waited on itself: its claim needed the batch,
and the batch needed its claim to have paid. The new two-chain Anvil suite
found this (#848), and it meant any backlog remitted in one send stranded the
mirror rewards of every loan open across it.

Base now refuses a remittance that funds more than one day, on the send and
on its fee quote alike, naming the bound. A day that only closes, moving no
tokens, can still travel with the one funded day. The keeper already sends
one funded day per remittance (PR #2823), so a backlog drains one day per
send per mirror, at one cross-chain fee per day. On the mirror, the old rules
that sometimes drew from a shared batch are removed, because they can no
longer be reached: a batch listing more than one day, which only a Base
breaking the new rule could send, is admitted, reported as withheld for
listing several days, and never paid out from. The coverage view reports it
under that name. The view of the retired priority tiers is removed.

No funds move differently for a single-day remittance, which is every
remittance a current Base sends. This needs a fresh deploy, like the rest of
the current reward work; no live chain is changed. Closes #2821. Refs #848.

_Committed 2026-10-25 12:13 UTC (ce2f35432)._
<!-- assembled-fragment: 2821-one-funded-day-per-remittance.md sha256=c303e60fd4ee1014b0ef574169231d88fb4d47e7fd13c1e314db2e2c9ceb861d -->

## Keeper — reward remittances fund one day per send (PR #2823)

After any delay the keeper's reward-remittance pass used to fund every owed day for a mirror in a single send. A multi-day send lands on the mirror as one delivery listing all of those days, and the mirror holds that delivery back while more than one of its days is still open. A day closes only once every reward entry covering it has claimed past it. So an entry covering two of the delivery's days needs the delivery to claim the first day, and needs that claim to free the delivery. It can never be paid on the mirror, and any loan open across the batch has such an entry. The backlog cases (a late commitment report, a paused keeper, the delivery gate opening) are exactly the ones that built such batches.

Each send now funds one day. A backlog drains one funded day per mirror per run, oldest first, and the days still owed keep being reported as owed. A day that only closes, moving no tokens, still travels with it. The cost is one cross-chain fee per day, which is already the steady-state cost. The keeper applies this whatever its configuration. Whether the contracts should also refuse or split a multi-day send is still an open owner decision on #2821.

Refs #2821.

_Committed 2026-10-25 08:21 UTC (7237ddd2a)._
<!-- assembled-fragment: 2821-remit-one-day-per-send.md sha256=00597a11d56273f7ea8b9452bb05ee5c93eab609a6b9280572d1f4b630fbb035 -->

## Thread — the indexer's configuration snapshot drops the retired master-flags columns (#2840)

The configuration snapshot table kept two columns for the master-flags read that #2812 retired with the range flags. The indexer stopped reading them in #2839, but it still had to write a placeholder into one of them, because that column was declared as never empty and the database cannot relax that in place. A new shared migration drops both columns, and the snapshot refresh no longer names them.

The migration applies while the previous indexer is still serving. In that short window, the old build's snapshot refresh fails on the missing column. That failure is already handled. It is logged, and the stored snapshot keeps its previous values. If the scan had seen a governance or pause event, the snapshot is also marked out of date, so the app reads the contracts directly until the new build's next scan refreshes it. Nothing else reads or writes these columns.

Closes #2840.

_Committed 2026-10-25 19:55 UTC (e30eb5010)._
<!-- assembled-fragment: 2840-drop-master-flags-columns.md sha256=502fcdabd4d51c5c3ef22840d710c42144d7d81c4d53348adb3e7f050d06e80e -->

## Thread — the live testnet drives read the chain through the app's answer-shape rule (#2841)

Since #2812 the app, its protocol console and the indexer decode a configuration answer only when its length matches the build's ABI, because the usual decoder reads a static answer by position and silently ignores anything extra. The live testnet drives still used that decoder for their own chain reads, so against a Diamond whose facet was not the build under review a drive could read a neighbouring field (for example, as the offer duration cap) and use it in a pass-or-fail check. That was contained only by the rule that the drives run after a deploy, against a chain refreshed to the build.

Every drive now makes its chain client through one driver function that applies the same shared rule to contract reads, batched reads and the raw reads the write confirmations decode themselves. An answer to a fixed-shape getter of any other length is not decoded, and the reason names the getter, the two lengths, the contract and the block. The driver applies the outcome when the process exits: a pass the drive reaches after such an answer, or a run the mismatch itself ended, is reported as BLOCKED with the reason. A failure stands, with the reason added, because a drive can fail on evidence the answer does not touch, such as a malformed request from the page, and reporting that as BLOCKED would hide a defect; blocked and undetermined outcomes stand likewise. Reads whose length is not fixed, simulations of writes, and the page's own traffic that a drive observes are unchanged. Wherever the shape matches, the drives get exactly the values and errors they got before.

This changes test tooling only; no user-facing page or contract changes. Closes #2841.

_Committed 2026-10-25 20:34 UTC (0a2247df7)._
<!-- assembled-fragment: 2841-live-drive-answer-shape.md sha256=84727fefb09a0f50d8a921fcf16a8cdba7a272edf592579effed6eb1aedb03fb -->

## Thread — the protocol console shows the auto-pause cooldown and when the next automatic pause may start (#2843)

The cooldown between automatic pauses (#2744) was enforced on chain but shown nowhere. The protocol console now shows it beside the automatic pause's length, together with the earliest time the incident monitor may pause the protocol automatically again. That time is shown as a date with its time zone, followed by either "now", once it has passed, or how long remains. When no automatic pause has ever stopped the protocol, the row says so in words instead of showing a date. Each row also says what the cooldown does not cover. An automatic pause that starts while the protocol is already paused by hand neither waits for the cooldown nor starts it, and changing the cooldown moves the time at once.

Both values go through the same shared reader as every other single-value setting. So the indexer publishes them in its configuration snapshot, and the console reads them from the contracts whenever that snapshot falls short. The next-pause time is not a setting. It is a time the protocol records, so the reader's rule now admits recorded facts that only an announced transaction moves. The snapshot refreshes that time on an automatic pause as well as on a change to the cooldown. A Diamond that predates #2744 reports both values as not reported. The parameter reference's cooldown entry is now marked as shown, and all nine translated languages carry the new wording.

Closes #2843.

_Committed 2026-10-25 19:25 UTC (ff95edfaf)._
<!-- assembled-fragment: 2843-auto-pause-cooldown-console.md sha256=3d0490cb5a4db85551071af1ac0eaf7b3ecbeb59543672bea8aba06c0cc51f8d -->

## Thread — the marketing site may connect only to itself and its indexer (#43)

The public website's content policy used to allow network requests and images from any secure host. Network requests now reach only the site's own address and the one indexer whose published protocol figures the pages quote, and images only the site itself, since every image it shows is its own file. So every kind of request the policy governs (data requests, live connections, beacons, images, fonts, media; it embeds no frames at all) is limited to those two places, and a script that got onto a page cannot use any of them to send what it reads to another host. Two channels are outside what a content policy can govern and stay open: a script could still send the page itself to another address, or trigger a name lookup. The indexer's address is build configuration, so the build writes it into the policy itself, from the same setting and through the same rule the pages use to fetch from it. That rule now lives in one place, shared by the pages, the build script that writes the machine-readable exports and the policy. A build whose configured address is not a plain secure origin stops instead of shipping a policy that would block the site's own data.

The policy check that runs with the site's typecheck now also refuses any connect policy other than "own address plus the build's indexer", and any other directive that names a destination beyond the site itself. The same build step is in the shared library, ready for the connected app; locking the app's connect policy is still open on #43, because the wallet connectors reach hosts that only appear while a real wallet connects.

Part of #43.

_Committed 2026-10-25 21:20 UTC (7b93eb16e)._
<!-- assembled-fragment: 43-www-connect-policy.md sha256=15c0aa96cc01ac258b92ce607653e90c0ecd030b479fe8f7214bb4cceca7c0ce -->

## Thread — the marketing site refuses inline and evaluated script (PR #2846)

The marketing site's content policy allowed any inline script and any text evaluated as code, and it named an analytics loader, a web-font host and a wallet-verification frame. It had been copied from the retired connected app. This site uses none of those, and the two script keywords would let an injected script run with the page's full authority (#43).

The site's `script-src` is now its own origin plus the SHA-256 of its one inline boot script, which sets the theme and the reading direction before first paint. The build computes that hash from the page it actually wrote, the same way the connected app has done since #2694, and fails rather than ship a policy it could not complete. The hashing now lives in the shared library, so both sites use one implementation. It hashes only scripts a browser runs, so the site's structured data, which a browser never runs, needs no allowance. The pre-render step checks every page it writes, for each route and each language, against the completed policy. It stops the deploy if any page carries an inline script the policy does not allow, so a page never ships with a script its own policy blocks.

The policy also drops what the site never loads: Google's tag loader and runtime, Google Fonts, the WalletConnect verify frame and WebSockets. The site now embeds no frame and may not be framed itself. If analytics is added, it comes through the consent pipeline and is added to the policy as a deliberate entry. The `typecheck` step checks the committed policy, so a later edit cannot quietly put an unsafe keyword back.

Still open on #43: locking `connect-src` on both sites to the origins each actually reads, and the deploy-pipeline hygiene, which is account work rather than code.

_Committed 2026-10-25 16:06 UTC (2660695ed)._
<!-- assembled-fragment: 43-www-script-policy.md sha256=7bbd0b35b1e77e5a2ffb34ab307c858b5b6183c08a8a8b4cfe5cec6499714848 -->

## Thread — Global pause keeps repay open and credits every open loan

A global pause used to freeze everything, repay and add-collateral
included, while every loan's due date and grace window kept running. The
unpause sits behind the 48-hour Timelock, so a pause that outlasted a
grace window let anyone default the loan the moment it was lifted, and a
borrower could not repay or top up collateral to avoid it. This change
implements owner decision D2 (2026-10-20). Full repayment, partial
repayment and adding collateral now stay open under a global pause.
Everything else stays paused: offers, accepts, matches, claims,
withdrawals, liquidations, defaults, swap-to-repay and the keeper-driven
settlement steps.

The protocol now keeps a record of every paused interval. The paused time
since a loan started is added to that loan's due date and grace end. The
late fee runs from the moved due date, and periodic-interest checkpoints
move the same way. Every part of the protocol that reads a loan deadline
now reads it from one place. A pause that came after a loan was already
defaultable puts the loan back inside its grace window for as long as the
pause lasted. That is deliberate: the alternative would favour whoever
defaults fastest after the unpause. Interest still accrues by elapsed
time, and a borrower who does not want it can repay during the pause.

Two new reads disclose this. One returns an open loan's original due
date, its pause credit, and its effective due date and grace end. The
other pages the pause record. A new event marks each closed manual pause
interval. The due date announced when a loan starts is the original one,
and after a pause the new read is the source of truth. The indexer,
keeper and app changes that consume the new read are tracked as a
follow-up. A sale listing's price floor still hedges interest only to the
original grace end. After a long pause, a fill late in the extended window
can therefore be refused as short. The borrower can still repay, or post
the listing again. Whether a loan may still be listed for sale, and the
remaining term the listing carries, follow the moved due date.

The remaining term a sale or an early close prices a rate difference over
also runs to the moved due date, so a buyer who takes on the days a pause
added is compensated for them, and a partial repayment after a pause no
longer counts the paused days against that term. A periodic settlement
after a pause pays one period's interest, so it marks the lender paid only
through the unmoved end of that period: the interest for the paused
stretch is still owed, and a later sale still accounts for it. A rental's
use is not extended: rent is charged by the day, pause included, so the
renter's use ends when the prepaid days do, on the original schedule. The
pause only protects the renter from a late fee or a default.

A chain upgraded in place while paused, or during an auto-pause window,
counts that pause from the upgrade on, before anyone lifts it, rather
than only once it ends, so repayment stays open against the moved
deadlines during it. A later pause never drops it from the record.

The change reaches a chain only by a fresh deploy or the all-facets
in-place refresh. The two curated refresh scripts refuse a Diamond from
before it. Closes #668 and #935.

_Committed 2026-10-25 05:43 UTC (a390425cd)._
<!-- assembled-fragment: 668-935-global-pause-loan-clock.md sha256=2a65461f1a7191413ee1233b570b6d5c0bd9ad6499c2dfacd5b929b3d4b4fd5a -->

## Thread — Protocol two-chain reward and VPFI scenarios (PR #2825)

A new test suite, `packages/protocol-e2e`, drives the protocol's
cross-chain positive flows on two local Anvil chains, a canonical Base and a
mirror, built from the repository's current contracts on the shared harness.
It covers a full reward day on both chains: each chain reports, Base
finalizes the global figures from both reports and broadcasts them, and
lender and borrower claim on Base. The mirror's budget is remitted over the
real VPFI token pools, indexed on the mirror and claimed there. The suite
also sends VPFI from Base to the mirror and back, checking that the mirror's
supply always equals what Base holds locked. It covers the tier push to the
mirror and the guardian pause on the mirror's reward receiver. Every claim
is checked against the claim's own simulation. Every call is one a user or
operator makes, so the suite proves the protocol underneath the keeper
rather than the keeper.

The suite found a defect, recorded as #2821. When Base remits several days in
one send, the mirror receives one shared batch and holds it back while more
than one of its days is open. A loan's reward entry covering those days
keeps them open until its own claim pays, so that claim is refused for
good. Remitting one day per send pays in full, and the suite does that. The
fix is a contract change left to #2821.

The day-list wire rules the keeper's delivery-proof pass used moved into the
shared library, so the keeper and the new suite rebuild a remittance's day
list with one implementation. The keeper's behaviour is unchanged. A new CI
workflow runs the suite; it is not a required check yet. The positive-flow
catalog marks the rows these scenarios cover, and names the parts they do
not. Test tooling only; no contract, deployment or user-facing behaviour
changed. Refs #848.

_Committed 2026-10-25 08:44 UTC (d30246114)._
<!-- assembled-fragment: 848-protocol-two-chain-scenarios.md sha256=f02e6933bffb22090272fbd9aa653459ec3c4de0fbe6a51099ef95246b7c5d56 -->

## Thread — Shared two-chain Anvil harness (PR #2818)

The two-chain Anvil setup the keeper's reward scenarios use (#2516) moved
out of the keeper app and into the shared Anvil harness package, together
with the scenario chain client, the loan helpers and the reward-day
helpers. Nothing about what the keeper scenarios build or check changed:
they now open the same two chains through the shared package, under their
own state directory, artifact folder and ports, so no other suite ever
reads the keeper's build.

This is the first step of the protocol positive-flow work in #848. The
reward claim on Base and on a mirror, VPFI moving out and back over the
real CCIP token pools, the tier push to a mirror and the guardian pause
all need two chains and moving time, which a forge script cannot give
them. The next change adds a protocol scenario suite on this harness
instead of building a second copy of the two-chain setup.

The forge fixture script that seeds the two chains was renamed from the
keeper-specific name to a shared one, because the reward remitter it
authorizes is now whatever address the calling suite names (the keeper
suite still names its own development key). Test tooling only; no
contract, deployment or user-facing behaviour changed. Refs #848.

_Committed 2026-10-25 07:35 UTC (38cff1447)._
<!-- assembled-fragment: 848-shared-two-chain-anvil-harness.md sha256=8f8a89b028a284bf86d343fc2fc9fe93b397a86442598ead2a12387ff103e8a2 -->

## Governance gates — the canonical VPFI token gets the fast guardian pause (#937)

The canonical VPFI token on Base can now be frozen by the Pauser Safe straight away, the same way every cross-chain contract already could. Before this change only the token's owner could pause it. Once ownership moves to the governance Timelock, that would have meant waiting out the Timelock's 48-hour delay, so a minter-key compromise or a mint bug could keep running for two days with nothing able to stop it. The guardian can only freeze. Unfreezing stays with the owner, so a compromised or hasty guardian cannot switch the token back on.

A freeze stops every VPFI movement on the canonical chain: transfers, mints, burns, the cross-chain pool's lock and release, and the platform's own VPFI flows. A cross-chain delivery refused during a freeze is recorded by CCIP as failed and can be re-executed once the freeze is lifted, so nothing is lost. The guardian is installed during cross-chain configuration, while the deploying admin still owns the token. If a reused token already belongs to someone else, the configuration says that it could not set the guardian and names who must. The live handover check now also reads the canonical token's guardian and fails the chain unless it is the Pauser Safe.

The guardian is stored in its own namespaced slot, so the token's existing storage is untouched and an in-place token upgrade needs no migration. It still needs the owner to set the guardian afterwards. No testnet has been changed yet.

Closes #937.

_Committed 2026-10-25 03:04 UTC (196fc6e81)._
<!-- assembled-fragment: 937-canonical-vpfi-guardian-pause.md sha256=d16691f851fd61f488c32b0d8e9af8d480d30fa7e895d22b174af9713a851a4f -->
