# Release Notes — 2026-08-12

**This is a catch-up file.** It folds the 153 release-note fragments that
accumulated between 2026-07-14 and 2026-08-12 into a single dated file
rather than reconstructing one file per merge day. Everything below
landed on `main` inside that window. Threads appear in task-id order,
not merge order, so read this as a map of the month rather than a
timeline — and note that where a thread says "now" it means "as of its
own merge", which a later thread in the same file sometimes revises.

*Later addition:* the catch-up above was assembled part-way through
2026-08-12, and eight further threads merged the same day. They are
appended at the end of this file rather than woven into the arcs below,
so the five-arc summary describes the catch-up window only.

Five arcs account for most of it.

**The VPFI recycling programme went from a ratified design to a working,
observable, cross-chain system.** The governor landed in three on-chain
stages — a recycle-bucket ledger with forfeits re-routed into it,
absorption-coupled day-pool stamps, and the dual accumulator that makes
claims actually pay from the budget those stamps size (#1217). On top of
it, the #1222 mesh taught the canonical chain to fund reward days on
mirror chains and prove the books across all three: a per-chain recycled
ledger, two-pass funding, a per-destination broadcast, the
commitment/delivered-backing lifecycle with its remit gate, source-scoped
netting, property-based invariants, a three-chain end-to-end harness, and
an operator watcher for the ledgers no test can span. #1434 then closed
the zeroed-day hole — a frozen lapse clock in the broadcast, mirror-side
classification and quarantine of compensation, self-quoted repricing,
lapse terminals with a one-in-flight gate, and a return path for
stranded compensation — and #1568 shipped planned-surplus repatriation,
books first and transport second. Distribution grew the limits it was
missing: a per-participant daily share cap (#1351), a bounded
post-claimability claim horizon (RL-3), a dormant allocation register
(RL-4), and one shared definition of how much VPFI is genuinely free to
pay out (#1460, #1498), so a reward claim can no longer spend the
recycle pool's backing. The account of all this is now public (M5,
#1218/#1349) — including the deliberate refusals to publish a figure the
platform cannot stand behind, the retained reserve shown only beside its
actual backing (#1525), and a slot for the days that predate the
announcement (#1504).

**The M2 fee package replaced the peg-custody borrower path.** The spec
supersession (#1350) settled the shape; #1352 froze the defaults at 0.2%
loan-initiation and 2% treasury and moved the borrower's hold-tier
discount to a direct reduction of the lending-asset fee at acceptance —
no VPFI custody, no settlement rebate, for new loans. #1347 added the
opt-in Full tariff beside it, #1353 capped the loan-side reward it can
arm, and #1354 taught the settlement sweep to honour a lender's Full
stamp. The #1383 family then walked every remaining settlement route —
swap-to-repay, the repay family, the preclose family, the offset
close-out, in-place extension repricing, and automated extensions on a
sold lender position — so the discount a party paid for is honoured
wherever their loan ends, not just on the primary path. #1356 asserts
the new defaults at deploy time.

**Borrower exits and lender-position sales grew a lifecycle.** Sale
listings became finite: a seller-chosen window, permissionless teardown
at expiry, a relist cooldown (#1503 PR-A), a borrower-side view of the
hold it puts on their loan, an admission floor that refuses to sell an
unhealthy position (PR-E), and net settlement out of escrowed proceeds
so a seller is no longer asked for wallet liquidity nobody told them to
hold (#1659). The obligation handover stopped leaving a spending
approval behind (#1514), and the connected app now exposes all six
borrower early-exit routes rather than two.

**The connected app became genuinely multilingual, and its review tier
learned to tell "no defect" from "could not look".** String extraction
went from ad-hoc to enforced — an AST detector that also walks `.ts`
helpers, a guard against entries that exist but still read in English,
and burndowns across the Basic surface, the Rate Desk, recovery, risk
access and the early-repayment surfaces, in all nine offered languages.
Two whole pages were rebuilt on alpha02 (stuck-token recovery,
self-sovereign risk access). The live review tier gained three-verdict
drivers, a testnet-behind banner, route-load failures that actually fail
the sweep, and committed drives for the two borrower settlement paths
nobody was exercising.

**Off-chain, the platform's own bookkeeping got the treatment it gives
users'.** The indexer capped its last unbounded routes, put every big
list on a page, drains deep backlogs in hours, fails loudly on a
mis-pointed RPC, and reports its own deploy provenance; the notification
centre shipped end to end (indexer backbone, in-app inbox, due-date and
grace reminders, loan-health warnings). The keeper now says which switch
stopped it, and the master switch's real scope is written down — it
stops six jobs and leaves four running, notifications included. The
backup service was renamed "warm", its healthcheck stopped looking at
only a third of the archives, its restore converter is committed, every
written table needs an explicit restore classification, and the
LayerZero-era binding it still exported is gone. A provenance stamp that
always said "dirty" now says something.

Alongside this file, the operator runbooks in [`../ops/`](../ops/) were
reconciled against what actually shipped — see the closing thread.

## Thread — Activity now sees your whole loan history, not just held positions (PR #TBD)

The Activity feed keeps an event when the connected wallet is a
participant — the recorded actor, a wallet mentioned in the event, or
an event belonging to one of the wallet's own loans. That last check
used to build its loan list from sources that only know about
positions the wallet currently holds: once a claim burned a position
NFT or the position was transferred away, the loan vanished from the
list, and system events tied to it by loan id alone (a settlement, a
keeper-triggered default) silently disappeared from the feed while it
rendered as complete.

The feed now also consults the wallet's permanent participation
history — every loan the wallet ever entered or held a position in,
kept by the indexer since the Rate Desk's History tab shipped — so
those events stay in the feed after the position is long gone. The
history read covers all loan shapes (a new "all" scope on the
history route includes NFT-collateral loans and internal sale
vehicles that the desk-focused view deliberately filters out), and it
is bounded like every other walk in the app: the five hundred most
recent participations, with anything deeper folded into the page's
existing "recent activity only" disclosure.

If the participation history can't be read, the feed shows its
unavailable state rather than quietly reverting to the old, narrower
filter — a feed that silently dropped events again would be worse
than one that says it can't load.

Closes #1023.

## Thread — NFT-rental buffer is now fixed when the offer is posted, not re-derived from live config (PR #1193)

An NFT-rental offer locks a prepayment equal to the rental fee plus a safety
buffer (5% by default). Until now every place that touched that buffer — the
prepay pulled when an offer is accepted, the refund paid when an offer is
cancelled, the delta settled when an offer is modified, the buffer recorded on
the loan at origination, and the buffer reset when a rental obligation is
transferred to a new borrower — re-computed it from the *current* governance
config rather than the value in force when the offer was created. That was safe
only as long as the buffer percentage never changed. If governance retuned it
between an offer's creation and one of those later steps, the numbers no longer
matched what was actually vaulted: a raise could make a cancel try to refund
more than the vault held (bricking the cancel) or record a loan buffer larger
than the borrower ever funded (defeating the guarantee that a rental's late fee
can always be covered by its buffer, which had previously caused close-out
failures); a cut could strand part of the prepay in the vault.

This change snapshots the buffer percentage on the offer at creation and reads
that snapshot everywhere downstream. Accept, cancel, modify, loan origination,
and the Option-2 obligation transfer all now fund, refund, and record the exact
buffer the offer committed to when it was posted, regardless of any later
governance change. The rate is fixed at create; modifying an offer's amount
re-scales the buffer at that same fixed rate, so the vaulted total always stays
consistent for a later refund. Offers created before this change carry no
snapshot and transparently fall back to the live config, exactly as before.

This mirrors the snapshot-at-origination discipline the protocol already applies
to interest-rate terms, fee percentages, and liquidation thresholds: an offer's
economics are set when it is posted and a governance retune only affects offers
created after it. No behaviour changes when the buffer config is left untouched.
Closes #1193 (Pass-2 conformance umbrella #1196).

## Thread — Transferring a rental obligation now settles the rent owed up to the transfer (PR #1194)

The protocol lets a borrower hand a live loan's obligation to a new borrower
(Option 2 / obligation transfer). For an ordinary interest-bearing loan the
exiting borrower must first pay the interest accrued up to the moment of
transfer, so the original lender is made whole for the time they were exposed.
That settlement was computed with the standard interest formula (rate × time),
which is correct for a lending loan but returns **zero for an NFT rental**: a
rental carries no interest rate — its economic payment is a fixed per-day fee
that is deducted from the borrower's prepayment each day. So when a rental
obligation was transferred, the rent that had accrued since the last daily
deduction was never settled to the lender. The transfer then reset the rental's
prepayment accounting to the incoming borrower's terms, quietly discarding that
undeducted rent, which simply stayed in the exiting borrower's (un-liened)
prepayment balance for them to withdraw. The original lender was left short the
rent they had earned right up to the handover.

This change settles that rent as part of the transfer. Before the loan is
rewritten to the new borrower, the protocol now forwards to the current
lender-position holder — funded from the exiting borrower's prepayment, exactly
as the normal daily deduction does — two amounts: the rent accrued between the
last daily deduction and the transfer (minus the usual treasury cut), and, when
the incoming borrower's term is shorter than the exiting borrower's remaining
term, the rent for the pre-paid days the new borrower won't cover (the "term
shortfall", which goes to the lender in full, matching how the interest-loan
path already compensates the lender for a shorter replacement term). Only
in-term rent is settled (rent past the agreed maturity is a late-fee matter
handled elsewhere), and the total is bounded by the prepayment actually on hand.
Everything left in the exiting borrower's prepayment after that — their
genuinely unused prepay and buffer — remains theirs to withdraw. The incoming
borrower's own prepayment and buffer take over the loan from the transfer
forward.

The rent settlement is chosen by asset type (rental vs interest loan), not by
the stored rate, and the interest calculation is switched off for rentals — so
the two never overlap and a rental that happens to carry an interest rate (which
can occur after a prior transfer) is still settled as rent, never billed twice.
Several clock edge cases are handled explicitly: the shortfall counts only the
rental days that remain unpaid after the catch-up, so days already paid ahead by
an earlier prepayment aren't charged again; a deduction clock pushed into the
future by such a prepayment doesn't break the elapsed-rent calculation; and a
legacy loan whose deduction clock was never set starts counting from the loan's
start date rather than treating its whole term as already elapsed.

The result: the original lender is no longer economically disadvantaged by an
obligation transfer on a rental, matching the protection the platform already
gives lenders on interest-bearing loans and the intended behaviour that the
exiting party pays all rent accrued up to the transfer. Interest-bearing
transfers are unchanged. Closes #1194 (Pass-2 conformance umbrella #1196).

## Thread — Six low-severity spec-conformance fixes (PR #1195)

This change lands six small, independent conformance fixes surfaced by the
Pass-2 review, each a "do exactly what the spec says" correction:

- **Signed-offer single-value shorthand on the direct fill path.** A signed
  offer can be authored with its upper amount left as zero, meaning "fill at the
  single stated amount". The order-matching path already understood that
  shorthand, but the direct-accept path did not and rejected such an offer. Both
  paths now honor it, so an offer that fills through matching also fills through
  a direct accept.
- **Expired offers are now reported as expired.** The authoritative offer-state
  read had no "expired" value, so an offer whose good-till time had passed still
  read as "open" (even though fills correctly refused it). It now reports a
  distinct expired state once its deadline is reached.
- **Good-till-time boundary.** A signed offer is now treated as expired at its
  deadline second, not only strictly after it, matching the rest of the
  protocol's expiry checks.
- **Treasury analytics on time-based defaults.** When a liquid asset is
  liquidated on a time-based default, the treasury's cut is now recorded in the
  revenue analytics counter, matching the health-factor liquidation paths; the
  figure was previously under-counted for this path.
- **Late cross-chain reward self-report is now rejected.** On the home chain,
  submitting a day's reward self-report after that day has already been
  finalized is now refused, matching the guard the incoming (mirror-chain) path
  already had. Storing a late report was harmless to payouts but corrupted the
  day-completeness bookkeeping and the audit trail.
- **Mainnet timelock minimum-delay floor.** The governance timelock deploy now
  refuses a minimum delay below 48 hours on a Phase-1 mainnet, so the delay
  can't be floored to the 1-hour development minimum without a gate. Testnets
  keep the 1-hour floor for iteration speed.

None of these change the ABI. The offer-state addition appends a new value to an
enum (keeping the existing values and wire encoding unchanged); consumer apps
that display offer state will gain a new "expired" case to surface, tracked
separately. Closes #1195 (Pass-2 conformance umbrella #1196).

## Thread — Pass-2 documentation and code-comment corrections (spec-doc PR)

This is a documentation-and-comments-only change: it corrects stale spec text and
stale code comments that the Pass-2 conformance review flagged as lagging the
ratified code. There is no behaviour change and no ABI change.

Functional-spec corrections: the refinance payoff description is now
mode-aware (a full-term-interest loan preserves full-term interest, a
pro-rata-opted loan settles only the accrued amount); a refinance-tagged offer's
principal is described as frozen (not adjustable); the retired `setStakingApr`
and `updateRiskParams.liqThresholdBps` governance knobs are removed/replaced with
the current per-tier liquidation-threshold setter; the position-NFT
transfer-lock exception for a live prepay-sale listing is acknowledged; the
oracle-unavailable sanctions posture is corrected to note that never-flagged
wallets keep the liveness (fail-open) behaviour; the flash-loan liquidator's
profit-headroom is clarified as off-chain keeper policy rather than an on-chain
revert condition. (The proposed fee-discount-consent carve-out for an
already-prepaid borrower rebate was NOT made: review found the ratified code
does not preserve it — a consent-off settlement zeros the rebate and forfeits
the prepaid VPFI to treasury — so it was re-opened as a code-vs-spec decision
rather than a spec edit.)

Code-comment corrections: a partial-liquidation docstring now describes the
current interest-clock-only re-stamp (maturity is immutable); the tier
liquidation-threshold comments are de-inverted (Tier 1 is the conservative low);
a sequencer-outage comment is corrected (time-based defaults revert, they don't
transfer collateral); and a rental-NFT comment is corrected to the vault-custody
model. A residual retired-terminology comment sweep is tracked separately.

Closes the Pass-2 spec/comment cluster (umbrella #1196). Related follow-ups:
#1253 (terminology sweep), #1251 (alpha02 consumers).

## Lender fee discount now works without a VPFI price (E-1, direct-reduction)

The lender yield-fee discount previously required the VPFI pricing peg to be
configured: the discounted treasury cut was paid *in VPFI* out of the lender's
vault, and with the peg intentionally left unset at launch, a consenting,
VPFI-holding lender simply paid the **full** fee — vaulted VPFI carried no
day-one fee utility.

E-1 adds a second, peg-free delivery: when no VPFI price source is configured,
the same tier discount is delivered as a **direct reduction of the
lending-asset treasury fee**. A consenting lender who holds a discount tier now
pays a smaller fee in the loan's own asset — "hold VPFI, pay lower fees" — with
no token conversion and no VPFI moving. When a price source *is* configured,
the existing VPFI-payment mode remains authoritative and this fallback stays
inert; the mode is chosen from the price-source configuration directly, so a
transient oracle gap can't flip it.

The reduction applies across the terminal lender-yield settlement paths that
already carried the VPFI-payment discount — ordinary repayment, preclose,
refinance, and the keeper auto-lifecycle servicing — and is exact: treasury
receives `fee × (1 − tierDiscount)` and the lender keeps the difference.
Lenders without discount consent, or at tier 0, pay the full fee unchanged.

Not in this slice (tracked as follow-ups on #1203): extending the discount to
the periodic-interest and swap-to-repay servicing sites (which apply no lender
discount today), an analytics event distinguishing the delivery mode, and the
tariff-priced discount-entitlement route (deferred with the parked VPFI
recycling work). Part of #1221 (E-1). Closes the peg-free half of #1203.

## One-transaction "Claim All" batching foundation (E-10, #1212)

Every payout on Vaipakam is pull-based — resolved-loan proceeds (lender and
borrower), interaction rewards, vaulted VPFI, un-lent lender-intent capital and
payroll each need their own claim transaction. A user with several eligible
payouts had to sign one transaction per claim.

This change adds the on-chain foundation for a one-click "Claim All": a generic
batching entry point that executes several Diamond calls in a single
transaction while preserving the caller's identity, so every batched action is
authorized exactly as if the user had called it directly — a keeper or a
stranger cannot claim on someone else's behalf through the batch.

The batch is **best-effort per item**: each item can be marked to tolerate
failure. For "Claim All" the interface marks every item that way, so if one
loan is not yet claimable — or was finalized by another party between the
preview and the transaction — that item is skipped and the rest still succeed,
rather than the whole batch reverting. An item can instead be marked
must-succeed, in which case its revert aborts the entire batch. The batch
reports, per item, whether it succeeded.

Safety: the batcher grants no capability a user does not already have on their
own — each batched call still runs its own reentrancy, pause, and
authorization checks against the real caller. It is non-payable (no value
re-use), rejects an empty batch, caps the number of items per call, and refuses
to nest inside itself. Note that the interaction-rewards claim remains bounded
to a fixed number of finalized days per call, so a single batch may not fully
drain a long-dormant user's rewards — the interface surfaces any residual.

This is the contract half of E-10. The Claim Center "Claim all eligible" UI —
the eligibility scan, per-item preview, and residual handling — is tracked
separately (#1268). Part of #1221; base for the opt-in keeper-swept-claims
follow-up.

## Notification center — due-date and grace reminders (PR #<n>)

The notification center now reminds people about time, not just events
(#1213 PR 2). No contract event fires when a due date quietly approaches,
so the indexer runs a calendar sweep on its ingest tick and materializes
three reminder rows from its own loan table:

- **Due within a week** and **due within a day** — to the borrower, the
  party who can act (repay, extend, or list collateral).
- **Past due, grace window running** — to both parties: the borrower can
  still repay with the late fee, and the current lender-position holder
  learns a default (and their claim) may be near.

Because the sweep is pure calendar math over the indexed loans — no
oracle, no price feed — these reminders cover **illiquid loans too**,
which is exactly the gap the design called out (health-factor alerts can
only ever cover liquid loans).

Each reminder fires once per loan per due date: extending a loan pushes
the due date out and re-arms the reminders for the new date, and repeated
sweep ticks never duplicate a row. Reminders are stamped at the current
chain position so they sort as fresh items in the inbox, and the
past-due reminder is only ever created while the grace window is still
running — its wording states the past-due fact and points at the
position page (the authority for whether the repay window is still
open), so it stays truthful as inbox history. The grace length follows
the protocol's configured schedule — the governance tiers when set,
snapshotted alongside the protocol config, the default table otherwise.
The sweep runs only when the index is consistent with the chain (every
caught-up tick — including quiet ones with no new blocks — and scans
near the head; never mid-catch-up, where stale rows could mint wrong
reminders), serves the soonest-due loans first, skips loans whose
current reminder already exists (so a busy chain's backlog can never
crowd out the not-yet-reminded tail), and skips bookkeeping rows (sale
vehicles, unhealed stubs) the same way the market views do. If the
protocol's grace schedule has not been read successfully yet, the sweep
waits rather than guessing — a reminder minted off the wrong schedule
could never be retracted.

The app renders the three new reminder kinds with their own icons and
plain-English copy; an older app build shows them as a generic loan
update (the safe fallback that already existed).

Part of #1213 (the calendar half of PR 2; the liquid-only HF-band rows
follow separately).

## Notification center — the in-app inbox (PR #<n>)

The user-facing half of the in-app notification center (#1213 / E-11):
a bell in the connected-app header with an unread count and a dropdown of
your newest loan updates. It reads the per-wallet feed the indexer
materialized in PR 1, so it's free and needs no setup — the same
loan-lifecycle events the paid Telegram / Push channels deliver, shown
right in the app.

Each row is written as an outcome, not an event name ("A loan was fully
repaid — see what you can claim"), with an icon per kind, and deep-links
to the position, which re-verifies the exact state on chain — the feed is
a convenience hint, never the source of truth. A row with no loan id (a
future calendar row) renders as a plain line rather than a dead link.

Read/unread is tracked entirely on the device: a per-wallet "last-seen"
cursor keyed on the same chain-order position `(block, log index)` the
feed sorts by. Opening the panel marks everything currently loaded as
read and clears the badge; the cleared state is scoped per wallet and per
chain and survives a reload. There is no server mark-read call, so
there's nothing for a stranger to clear on your behalf. The badge caps at
"9+" so a first-connect backlog reads calmly. The bell shows only for a
connected wallet, and if the indexer is briefly unreachable the panel
says so honestly rather than showing a fake-empty inbox.

Part of #1213. Closes the E-11 frontend slice.

## Notification center — loan-health warnings (PR #<n>)

The in-app inbox now warns borrowers when a loan's health worsens
(#1213 PR 2b, the final piece of the notification center). The
platform's autonomous monitor already checks every active loan's
health factor each minute as part of its liquidation watch; it now
also files a free inbox row when a loan's health CROSSES DOWN through
a protocol-level line:

- **below 1.5** — the level loans must start above; worth a look.
- **below 1.2** — the cushion is getting thin.
- **below 1.05** — close to the 1.0 line where liquidation becomes
  possible; time to act.

These fire only on the way down — a recovering loan is not an alert —
at most once per line per day, and they follow the borrower position
to its current holder. Like every inbox entry, the wording states the
dip as of the notice and defers the live number to the position page,
so an old entry stays truthful after the loan recovers or closes.

This is deliberately the borrower's lane: health is the borrower's
actionable number (top up collateral, repay). Lenders learn about
trouble through the grace and outcome entries. Loans whose collateral
has no price feed have no health number — their risk reminders are the
due-date and grace entries that shipped in the calendar half of this
work — so between the two halves, every loan has a risk lane.

Unlike the optional Telegram/Push alerts (which are instant and use
each user's own thresholds), these inbox rows use one fixed protocol
schedule, need no setup, and arrive on the inbox's normal refresh
cadence. They are produced by the autonomous monitor, so they only
mint while that monitor is enabled.

Part of #1213 — this completes the notification center (events,
calendar reminders, and health warnings).

## Notification center — indexer materialization backbone (PR #<n>)

The first slice of the in-app notification center (#1213 / E-11): the
indexer now materializes a per-wallet inbox from the loan lifecycle it
already ingests, so the connected app can eventually render a free,
wallet-native notification feed (bell + unread count + panel) instead of
relying only on the off-chain paid channels (Telegram / Push / SMS /
Email). This PR is the backend backbone — the user-facing surface is a
follow-up frontend PR.

A new `notifications` table (migration 0038) holds one row per
(recipient wallet, notification). On every ingest scan the indexer
derives inbox rows for the loan-lifecycle events that concern a wallet —
loan matched, partial repayment, every repayment close-out (ordinary
repay, swap-to-repay, swap-to-repay-intent fill, direct preclose, offset,
and refinance), every default/liquidation close-out (time-based default,
backstop absorption, and HF-based liquidation), and the internal-match
close (which fans out to each of the matched loan legs). Several of these
the contracts emit under their own terminal event with no generic
LoanRepaid/LoanDefaulted companion, so each is mapped explicitly rather
than assumed covered.

A row that asserts a loan has *closed* is gated on the indexer's own
projected loan state, so the inbox can never disagree with what the loan
detail page shows: a "closed — check the Claim Center" row is only
materialized once the indexer has actually flipped that loan to a
terminal status. This suppresses two false-positive cases — a *partial*
internal-match leg (principal reduced but the loan still open) and a
lender-sale *vehicle*'s temporary bookkeeping loan (excluded from every
market surface) never generate a row. It also defers HF-based liquidation
rows: the indexer does not yet project HF-liquidation terminal status
onto the loan table (a pre-existing gap tracked separately), so those
rows stay dormant until that projection lands, at which point they
activate automatically. The recipient resolves
to the CURRENT position-NFT holder at materialization time (the design's
ownership discipline): a secondary-market buyer who now holds the claim
is notified, while an exited seller and a burned/cash-satisfied side
(e.g. the cashed-out lender on a backstop absorption) are not.
Materialization is idempotent:
each row carries a deterministic dedup key, so a re-scan or catch-up
never duplicates an inbox row; the per-loan party lookup is chunked so a
large catch-up scan can't exceed the database's bind-parameter limit; and
a hiccup here never fails a scan (the rows are derived convenience data
on top of the authoritative event ledger).

A single route serves the inbox: a feed ordered newest-first by chain
order (block, log index) rather than a block timestamp — the timestamp
can fall back to wall-clock on a mid-catch-up read failure and mis-sort a
historical row — with a keyset cursor, served no-store as a per-wallet
surface. Read/unread state is
tracked CLIENT-side (a per-wallet last-seen cursor in the frontend)
rather than as a server column — an unauthenticated server mark-read
mutation would be griefable (anyone could clear a victim's badge) and a
per-action signature is poor UX, so the launch keeps read-state local
(a deliberate refinement of the design doc's "read-state in D1" line; a
future SIWE-session server-side version can revisit). The chain stays
authoritative for any action — rows carry a loan id and deep-link to
Loan Details / the Claim Center, which re-verify there.

A coverage guardrail (`check-notification-coverage.mjs`, wired into the
indexer typecheck) mirrors the existing event-coverage guard: every
loan/offer state-change event must either map to a notification or be
consciously allowlisted with a reason, so a new lifecycle event can't
silently go un-notified. The richer lifecycle rows (offer matched,
periodic interest, sale/refinance/offset terminals), the time-based
calendar rows (maturity approaching, grace entered — which cover
illiquid loans too), and the liquid-only HF-band rows are queued
follow-ups, each already accounted for in that allowlist.

Part of #1213.

## Thread — Recycling governor PR-3a: recycle-bucket ledger + forfeit re-route (PR #TBD)

First on-chain stage of the ratified VPFI recycling balance governor
(#1217/#1222, design ratified 2026-07-15). The Diamond now carries a
protocol-owned **recycle bucket** — a ledger slice of its own VPFI
balance, never a separate pocket — with one credit chokepoint that keeps
three things in lockstep: the bucket balance, the per-day credited series
the governor's trailing absorption average will read, and a public
per-credit event carrying the receipt class, reference, amount, and
schedule day.

The first live receipt class is **forfeited interaction rewards**: both
the claim-path forfeit and the permissionless per-loan sweep now keep the
forfeited VPFI in Diamond custody and credit the bucket instead of
transferring to the treasury (owner directive: recycle absorbed VPFI into
the reward stream — never burn, and the platform's take is the governor's
retained margin, not forfeit capture). Pool-cap accounting is unchanged —
forfeits still consume the 69M interaction pool exactly as before; only
the destination ledger moved. The former forfeit-to-treasury event is
retired (no off-chain consumer read it); the recycle event replaces it
and is the designated feed for the #1218 self-funding ratio and the RL-2
loop-closure ratio's absorption term.

Two transparency reads expose the bucket balance and the per-day credited
series. Consumption of the bucket (the absorption-coupled reward budget)
arrives with the governor's later stages (PR-3b/3c) and is zero until
then — absorption without distribution coupling is the accepted launch
posture. Functional spec §9 gains the "Recycle bucket" rules and §4's
forfeit-routing bullets now state the recycle destination. Part of the
#1217 Phase A′ stack; RL-3's expired-reward sweep (#1305) will credit
through the same chokepoint.

## Thread — Recycling governor PR-3b: absorption-coupled day-pool stamps (PR #TBD)

Second on-chain stage of the ratified recycling balance governor
(#1217/#1222 §3.1), on top of PR-3a's bucket ledger. Every day
finalization now computes and stamps, write-once, the day's intended
pool composition: the pre-funded schedule floor (capped by remaining
fresh availability) plus the absorption-coupled recycled budget — the
trailing seven-day average of bucket credits, less the retained margin,
capped by what the bucket can actually fund. The trailing average always
divides by the full window (zero-padded, never by elapsed days) so a
launch spike can't contribute more than once; the margin is read once at
finalization and stamped with the day, so a governance retune never
rewrites finalized economics; and a day with no emission schedule stamps
a zero recycled budget too — recycling never makes otherwise-unrewarded
activity rewardable. When the fresh pre-fund exhausts, the floor goes to
zero and the recycled term carries the pool alone: the promised steady
state, now visible per-day on-chain.

Commitment reservation ships dark by design: the stamps are records (two
new transparency reads expose them and the outstanding-commitment state)
until the next stage's distribution-coupling cutover arms reservation
atomically with consume-at-claim — reserving without a consumption path
would silently collapse future availability, so the arming day is a
single storage field the cutover sets. Seven new tests pin the ratified
formula on the real finalization path, the zero-padding rule, both
clamps, the stamp's immutability under a margin retune, exhaustion
steady-state, and the arming gate in both directions. Functional spec §9
gains the day-pool stamp rules. Part of the #1217 Phase A′ stack.

## Thread — Recycling governor PR-3c: distribution coupling — dual accumulator + consume-at-claim (PR #TBD)

The stage that closes the governor's loop end-to-end: claims now actually
pay from the absorption-coupled budgets the day-pool stamps size. From an
admin-armed cutover day forward (one-shot, strictly future, and shipped
in-band with every day broadcast so mirrors arm on the identical day with
zero operator drift), each finalized day's claim math prices against the
stamped schedule floor plus recycled budget instead of the raw emission
schedule. Claims spanning the cutover slice exactly — pre-cutover days
pay schedule-only — and the per-user daily cap applies to the combined
value first with the trim apportioned pro-rata across sources, so capping
never changes a user's total.

Consumption is source-split everywhere the pool pays out. A claim's fresh
component consumes the 69M pre-fund and retires its day's fresh
commitment; its recycled component debits the recycle bucket at claim
time and retires the recycled commitment — and at fresh exhaustion the
recycled term keeps paying, the design's promised steady state. A
forfeited reward splits the same way: the fresh share credits the bucket
as genuine absorption while the recycled share is released with zero new
credit (it never left the bucket, and crediting it would inflate the
absorption average while absorbing nothing). Cross-chain remittances
decompose identically, with the per-chain funding split mirroring the
claim-side split so funding and claims cannot diverge.

The day broadcast grows from five to eight words, carrying the pool
composition halves and the arming day; mirrors store them verbatim and a
post-cutover day whose composition hasn't arrived halts claims for that
day fail-closed rather than pricing from the wrong pool. The retired
four-parameter broadcast ingress selector is wired for removal on the
next facet redeploy. Six new end-to-end tests pin the split, the
forfeit-release rule, the exhaustion steady state, cutover slicing, the
mirror composition store, and the arming guards. Functional spec §9 gains
the distribution-coupling rules. Part of #1217; unblocks RL-3 (#1305)
and RL-4 (#1306).

## VPFI recycling governor — bounded configuration knobs (Phase A1a)

The first slice of the VPFI recycling balance governor (design
`VpfiRecyclingBalanceGovernorDesign.md`) lands as pure configuration
plumbing: two new admin-tunable, bounded knobs that later phases read,
with no behaviour change yet.

- **Recycling margin** (`setRecycleMarginBps`): the slight platform-favouring
  share the governor will retain from absorption before sizing the
  usage-reward budget. Default 5%, bounded to at most 25%; setting it to zero
  resets to the default, so an (almost) zero margin is expressed as the
  smallest non-zero step. This is the single lever that keeps VPFI absorption
  and distribution in balance with a small edge to the protocol.
- **Discount-entitlement tariff `k`** (`setRecycleTariffKPer1e18EthDay`): the
  quantity of VPFI a borrower/lender will pay at loan initiation to buy a
  loan's fee-discount entitlement, sized purely by the loan's ETH volume and
  duration — never by converting a fee value at a token price. Bounded to a
  wide governance range with a conservative default.

Both follow the house pattern for governed parameters (ADMIN-role setters
behind the timelock, compile-time bounds, a zero-sentinel that resolves to a
library default, and a one-call `getRecycleConfig` read). They ship dormant:
nothing consumes them until the governor and the tariff mechanism land in the
following phases. Storage was appended at the end of the layout, so an
in-place facet refresh needs no migration.

Part of #1217 (Phase A of #1222). No user-facing behaviour changes in this
slice.

## Thread — the day-finalisation notice now carries the emission figure (#1218 M5 step 3a)

When a reward day closes, the platform publishes a notice describing that day's pool: how much was budgeted from the fixed schedule, how much came from recycled value, and the absorption average that sized it. The notice now also carries **how much of the schedule was actually drawn** — the day's net emission, and the single number the transparency dashboard is built around.

**Why it belongs in the notice rather than being looked up afterwards** is worth explaining, because it is the kind of decision that is invisible once made and expensive to reverse.

The component that turns on-chain activity into the fast queryable history behind the dashboard reads *only* published notices. It never asks the contracts a question. That is deliberate: a process whose output depends solely on a replayable stream of notices can be re-run from scratch and produce the same answer, and it cannot race with itself. Everything it stores is reconstructible.

The per-day figures the transparency design calls for were, on the whole, already available that way — with one exception, and with one figure that is not a per-day figure at all. The retained-reserve number is a running position rather than something a day produces, so it is read on request and no announcement carries it; an earlier draft of this note counted it among the ones the stream supplies, which it never did. Absorption is announced per day as it happens, and each reward chain's contribution is announced as it is accepted, so both halves of the global figure fall out of the stream — **with one exclusion that has to be respected or the total is wrong in the flattering direction**. The platform's own chain also announces a contribution for itself, and that same value is already counted through the per-day absorption announcement, so anything adding up every chain's contribution must skip the platform's own or it double-counts and reports the programme as more self-funding than it is. The on-chain accumulator has always made that exclusion; anything rebuilding the figure from announcements has to make it too. The day's budget and its recycled share were already in the closing notice. Only the drawn figure was missing — and it was the headline one.

Closing that gap by having the history component ask the contracts would have ended the property that makes it trustworthy, for exactly one number. Fetching it later, when someone opens the dashboard, would mean one lookup per day displayed, or a cache that has to be written from the read path — and it would leave the most prominent number on the page as the only one that disappears when the network is slow, while everything beside it loads from the local store. Putting it in the notice removes both problems and costs a two extra fields — the figure itself, and a flag saying whether that day counted. Getting that count wrong in either direction matters more than it sounds: anyone matching these notices computes an identifier from the exact field list, so a description that is one field short matches nothing at all rather than matching imperfectly.

The figure was already being computed at that exact moment; it simply sat inside a branch that skipped it before the programme is switched on, so it was not visible where the notice is written. Moving that calculation outside the branch changes no behaviour — it is a read-only computation, and the branch still guards the only thing that writes state. On a day before the programme is armed it now runs one extra read during a once-a-day close.

**Two things are asserted so they cannot quietly come apart.** The value in the notice must equal what the on-chain view reports for the same day — they are computed independently, so nothing but a test would catch them diverging, and publishing two different answers to the same question is worse than publishing none. And a day before the programme is armed must still reserve nothing: had the moved calculation dragged the reservation out of the branch with it, unarmed days would have begun quietly consuming the programme's commitment headroom, which is a far worse fault than the one being fixed.

**The notice also says whether the day counted.** Before the programme is switched on, the calculation still runs and the figure is still published — but nothing reserves it, and rewards are priced a different way in that period. So the figure is an *estimate* of what such a day would have committed, not a record of what it did. The notice carries a flag saying which it is, and **only days marked as counting should be read as net emission**; anyone accumulating a history from these notices must check that flag rather than summing every value. It is carried in the notice itself precisely so nobody has to look it up separately and nobody can forget to.

**Two limits, stated here rather than discovered later.**

Widening a notice changes its identifier, so days that closed *before* this change were announced in the old shape and cannot carry the new figure. The stream of notices therefore describes the series from this point forward, not for all history. The on-chain view reconstructs earlier days on request, so the two surfaces cover different halves of the same question — the notice pins each day as it closes, the view rebuilds what predates the change. Anyone who wants the older days in their stored history fills them in once from the view — **and must work out separately, for each of those days, whether the programme was switched on yet**. The view returns the figure but not that flag, and the days most likely to need filling in are precisely the early ones from before it was switched on. Storing those figures plainly would reintroduce the very confusion the flag exists to prevent, in the direction that flatters: estimates recorded as emission. The arming date is readable on its own, so a backfill marks or omits those days rather than storing bare numbers.

**With one caveat that turns a convenience into an ordering requirement.** The view is the *only* source for those earlier days, and it recalculates from a stored input that a later message can overwrite during a role handover. If that overwrite happens before the older days have been filled in, the view will rebuild them differently and — having never been announced in the new shape — the original figures are gone. So the fill-in must happen **before** any such handover, not after. Days from the change onward are unaffected, because the announcement is immutable and survives it.

And where the notice and the view ever disagree, **the notice is the one to trust**. The view recalculates from a stored input which, in one supported recovery scenario, a later message can overwrite for a day that already closed. The recalculation can move; the announcement cannot. That asymmetry is an argument for carrying the figure in the notice rather than a caveat against it.

Nothing outside the contracts was reading this notice yet, so widening it broke no consumer. The figure carries the same caveats as the view it mirrors — it is what the day *committed*, not what was ultimately paid, and those limits are documented on the view itself.

## Thread — the recycling dashboard's missing numbers, and one that was wrong (PR #1487)

The recycling programme has been publishing nothing about itself. The design settled a year's worth of argument about *which* numbers the platform should show — seven of them, ratified in the balance-governor design — and then the surface to show them was never built. This adds the two reads that were genuinely missing, and it turns out that is the whole contract-side gap: every one of the seven figures is derivable from state the protocol already keeps, so nothing new is stored. A follow-up widens the existing day-finalisation notice by two fields rather than adding a new notice, for the reason set out in its own note.

**The formula the tracking card asked for would have been wrong.** It called for "fresh issuance minus recycled value", which is the right question under a design where recycled tokens displace fresh issuance one for one. That design was considered and explicitly rejected — it optimises how long the programme lasts rather than whether it balances. What shipped instead is additive: a day's reward pool is the fresh floor **plus** the recycled budget. Under that shape the two terms add rather than cancel, and subtracting one from the other measures nothing at all. This is not a coefficient that drifted; it is a quantity that stopped existing. Net emission is now the fresh floor actually drawn, and the card has been corrected to say so.

**One of the two new reads closes a gap that would have published a wrong number rather than a missing one.** Absorption is credited per day from two places: the canonical chain's own activity, and the mirror chains' accepted reports. The day-finalisation path sums both when it sizes the programme's coupled budget — but only the first was readable as a single figure. A dashboard built on the obvious getter would have shown canonical-chain-only absorption while labelling it global, understating exactly the cross-chain activity the recycling programme exists to capture, and it would have looked entirely plausible while doing it. Both terms are now published together, so the split is visible and a reader summing them cannot get it wrong.

To be precise about what was missing, because an earlier draft of this note overstated it: the mirror contribution was not unreachable. It could be reconstructed by reading each chain's per-day credit individually and adding them up — which requires knowing the full list of participating chains and making one call per chain, and silently returns a short answer if that list is stale. What was absent was the single aggregate the protocol itself uses. The improvement is that the figure a reader sees is now the same one the budget was sized from, rather than one they assembled and hoped matched.

**The other was thought to need new storage, and did not.** The fresh drawdown genuinely cannot be reconstructed from the claim side: the counter that tracks fresh payout has no day dimension, the claim event covers a range of days with a single combined total, and a whole-claim truncation against the lifetime cap rescales things after the per-day walk has already happened. The first read of this concluded a per-day accumulator was needed. That was looking in the wrong place. The figure is available from the *finalisation* side, where the day's committed fresh amount is a pure function of aggregates the protocol already persists — so it is recomputable by anyone, at any later time, from the same inputs, and the published value is produced by the very call finalisation makes to size its own reservation. The test asserts it against that reservation's real movement rather than against a second copy of the formula, since a test that re-derives the same arithmetic would agree with a wrong implementation just as readily as a right one.

**Five bounds on that figure are documented on the surface itself rather than left to be discovered.** It is exact for the armed-day reservation. It is an approximation before the governor is armed, where claim pricing reads an uncapped half while the day's record keeps a capped one. It sits above the real figure near the lifetime issuance cap, where truncation pays out less than was committed. And it sits *below* the real figure on a day whose chain contribution was zeroed: the recovery path for such a day can later send an operator-sized amount of fresh value, and because no commitment was ever made at finalisation there is nothing for the recomputation to find — that drawdown is real and simply invisible here.

And it sits below the real figure again when a cross-chain payment gets stuck and is released and re-sent: the allocation counter is charged for both attempts while this figure reports the single original commitment, so the two legitimately disagree. Both readings are defensible — the stranded first attempt reaches no user, so the day's emission is the commitment while its consumption of the lifetime allowance is larger — but anyone reconciling the two needs to expect the gap rather than read it as corruption.

These matter together, because they point in opposite directions: the figure is **not** a pure upper bound, and an earlier draft of this note and of the code comment both said it was. Review caught it. Anyone building an alert on "reported drawdown exceeds X" needs to know the number can also under-report.

Value that is drawn and then forfeited stays counted as drawn and reappears as absorption — the two figures describe opposite legs of one movement, and netting them here would double-count in the other direction.

**A figure outside the ratified seven has been added deliberately, and it needs stating plainly.** Every other number on this surface is computed from internal counters, and a counter cannot notice that the tokens behind it have left. That is not hypothetical: a fresh-only reward claim can currently spend tokens backing the recycle bucket, after which the retained-reserve figure keeps reporting a reserve that is no longer there. The defect needs three things at once — a non-zero bucket, a schedule-only claim, and the unearmarked balance falling short of the payout. The first two are each a single read. The third — the one that decides whether a deployment is actually corrupted or merely eligible to become so — was reachable too, but only by chaining three calls: resolve the token's address, read its balance on the protocol, subtract the labelled amount, all at the same moment or the answer means nothing. What the new figure adds is that the subtraction is atomic and takes one call, not that the quantity was previously unknowable. An earlier draft of this note claimed it was observable nowhere, which is the same overstatement corrected two paragraphs above about the mirror term — worth getting right, because exaggerating a gap is how people stop looking for the real one. It is now published next to the reserve it can falsify.

To be unambiguous about what that does: **it measures the defect, it does not fix it.** Closing it remains a prerequisite for arming the governor, on its own change, and that change is where proof that a real claim can reach the bad state belongs. What this buys is that a dashboard reporting a healthy reserve can be checked against backing that actually exists, instead of asserting it from bookkeeping.

The read that reports backing deliberately saturates rather than reverting when backing has gone short. A view that fails precisely when the condition it exists to detect has occurred would blind every monitor at the one moment they need to read, and would turn a detectable breach into an opaque error. A zero there is ambiguous by construction — fully consumed and in breach look the same — so the balance and the bucket are both returned and the reader can tell them apart.

**The day series answers for the days it actually finalised, and refuses the rest — which is not the same as "only on the canonical chain".** Review caught the first version answering on a mirror, with numbers. The pool figures are global and only the chain that finalises a day computes them; a mirror holds a different set of records. Under one broadcast shape it would have reported a globally finalised day as having no pool at all, and under the other a real budget beside a drawn figure of zero. The second is the dangerous one, because that zero is indistinguishable from a genuine zero — the very failure this change fixes for the absorption figure, so shipping it in the same breath would have been self-defeating.

The first fix for that was too blunt and review caught it too. Keying on whether a deployment is *currently* the canonical chain meant that demoting one — a role migration, a failover — would have made every day it had already finalised unreadable, while its replacement could not serve them either. An indexer following a failover would have discarded the old endpoint and lost the entire history. The rule is now about the day, not the deployment: each finalised day carries a permanent mark that it was finalised *here*, and any day carrying that mark is served regardless of what role the deployment holds today. Only days without it are refused, and only when the deployment is not currently canonical — because those are precisely the days it has no way to compute.

Nothing is lost either way: a mirror's own absorption and per-chain ledger were already readable elsewhere, and the backing figures — which are genuinely local — keep working everywhere.

Two smaller corrections in the same pass, both cases of a claim being truer in the comment than in the code. A counter documented as the bucket's lifetime outflow is neither monotonic nor a lifetime figure: a cross-chain send advances it before anyone is paid, and releasing a stuck send reverses it, leaving tokens that really did depart uncounted. And the retained-reserve figure was justified only against overstating, when it can understate too — releasing a stuck remittance restores the liability without restoring the tokens, so the reserve can floor to zero while value genuinely remains. Both now say what they are, and point at the counter that lets a reader reconstruct the difference.

Follow-up: the day series still needs a public display surface. The indexer consumer landed alongside this change, so the day-finalisation event that carries the composition — emitted since the governor shipped and, until now, read by nothing — is recorded into a queryable history.

## Delegated-keeper action bitmask widened to make room for future actions (#1221)

The per-user delegated-keeper authorization bitmask — the mask that records
which actions a lender or borrower has authorized a keeper address to drive on
their behalf — was widened from an 8-bit to a 16-bit container.

The eight action bits defined today (complete-loan-sale, complete-offset,
init-early-withdraw, init-preclose, refinance, extend, signed-fill, auto-roll)
had completely filled the original 8-bit byte, so adding a ninth action would
have forced a storage-layout and interface change. Widening the container now
means each future keeper action — the auto-protect and keeper-sweep actions
planned for later user-value work — is a pure additive change: define the new
bit, add it to the "grant everything" set, and add the executor's authorization
check, with no storage migration.

Note this does not silently extend any keeper's authority. Authorization is
still an exact per-action bit check, so a user who previously granted "everything"
under the 8-action regime does **not** automatically authorize a future ninth
action — they must deliberately re-grant to include the new bit. That is the
desired safety property: the container growing can never widen what an existing
keeper is allowed to do; a newly-defined action reaches a keeper only by the
user's explicit new grant.

There is no behaviour change in this release. The same eight actions are the
only ones that exist, the same "grant everything" convenience value is
unchanged, and the authorization rules are identical. An attempt to grant an
undefined action (a bit outside the current action set) is still refused — the
validation now explicitly rejects the newly-expressible high bits, so the type
growth can never be used to grant an action the protocol has not defined.

Existing keeper approvals are unaffected: a value stored under the old 8-bit
container reads back identically under the widened one. Part of #1221;
prerequisite for the auto-protect (E-4) and keeper-sweep (E-10) work.

## Thread — Per-chain recycled ledger + widened day-close report (PR #TBD)

The cross-chain recycling mesh (#1222, completion-plan §M3) begins with
its accounting foundation: the canonical chain now learns, per chain,
how much recycled VPFI exists and which day it was absorbed on. Every
chain — Base included — keeps a monotonic lifetime total of its
recycle-bucket credits, and each day-close report to the canonical
aggregator now carries two recycled figures alongside the interest
denominators: that lifetime total (availability accounting that
self-heals across missed or re-ordered reports, because the next report
always carries the full total) and the closing day's credited amount
(the per-day attribution the absorption average will draw on).

The canonical side records both into a per-chain ledger with an
aggregate integrity clamp: the running sum of a chain's accepted day
credits can never exceed its reported lifetime total, so a reporting
bug or replay can never feed the absorption accounting credit the
availability ledger does not back. Because the clamp's baseline
advances only by accepted credit — never to the reported total —
attribution is order-independent for an honest chain: a delayed
earlier day arriving after a later one, a report jumping over
unreported days, a delayed first day, and the late close of a quiet
day (whose report necessarily pairs the live lifetime total with an
empty old-day amount) all attribute exactly. The last two shapes were
review findings: the review's alternative baseline rule was adopted
outright because the originally drafted per-report clamp could not
survive the quiet-day late close without corrupting a later day's
attribution.

The report widening ships receiver-first: the canonical transport
accepts both the old and the new report shapes (nothing else), so a
not-yet-upgraded mirror or a delayed in-flight report keeps landing —
its recycled figures simply read as absent. The rollout is also
non-atomic per chain: the old sending, fee-quoting, and canonical
receiving surfaces all remain callable, so a chain's diamond and its
transport messenger can upgrade in separate steps in either direction
without a window where the permissionless day-close reverts. This
stage is records-only — public transparency reads expose the per-chain
ledger, but nothing funds, pays, or nets from it until the next mesh
stages size per-chain budgets against it.

Part of #1222.

## Thread — Two-pass per-chain recycled funding resolution (PR #TBD)

The mesh's funding brain lands (#1222 M3 B2-a, records-only): on
post-cutover days, the canonical chain no longer sizes the recycled
reward budget against its own bucket alone. The absorption average
still sizes the day's coupled target, but funding now resolves per
chain: each chain's share of the target follows its finalized demand
weights, each chain funds its slice from its own recycled availability
first (the per-chain ledger the previous stage built), and the
canonical chain tops up shortfalls pro-rata from whatever remains of
its own availability after reserving its own slice — never
double-committing the same bucket. When a chain's availability can't
cover both sides of its target, the split happens at one allocation
point, pro-rata to the two side targets, so the same balance is never
spent twice. The day's stamped recycled budget becomes the sum of the
funded slices — identical to the previous single-pool sizing on a
single-chain deployment.

Each chain's funded figures are stamped per day: the per-side funded
budgets (the binding caps once consumed), the side-specific
global-equivalent numerators that make the existing claim math pay
exactly the funded amount on that chain, and the slice the chain will
be instructed to consume from its own bucket. The intended reservation
split — mirror-locally-funded slices against that chain's
availability, canonical-funded shares (own slice plus every top-up)
against the global ledger, both at capped committable amounts with
rounding dust trimmed — is computed and published per chain alongside
the stamp. The absorption average now folds in every mirror's accepted
day credits alongside the canonical chain's own series, accumulated at
report-acceptance time so a later change to the configured chain set
can never rewrite an already-accepted day (a review finding).

Deliberately, this stage changes NO live figure: the day's stamped
recycled budget, both outstanding-commitment ledgers, and every
claim/remittance consumer keep the previous single-pool values
byte-for-byte — a review round established that publishing the summed
per-chain figure while consumers still distribute it pro-rata would
move armed-day rewards and bucket consumption to the wrong chains, so
the resolution rides as pure records until the next stage flips the
consumers and arms the per-chain reservation ledger together.
Part of #1222.

## Thread — Per-destination day broadcast + canonical consumer pricing (PR #TBD)

The recycling mesh's day broadcast evolves — once — into a per-destination
shape, and the canonical chain begins pricing its own rewards and
remittances from per-chain funding stamps (#1222 M3 B2-b).

Each post-cutover day's broadcast now carries, per mirror, that chain's
OWN funded figures: its per-side fresh floors, its side-specific recycled
equivalents (the numerators that make the existing claim arithmetic pay
exactly that chain's funded budget), a reserved consume-instruction field,
and a reserved keeper-allocation field. Every packet embeds its
destination chain identity and a mirror rejects packets not addressed to
it, so a delayed delivery or replay can never apply another chain's
figures. The same evolution folds in the long-planned cap-family fields:
pre-cutover days ship the legacy threshold, post-cutover days ship
per-side daily user ceilings computed once on the canonical chain —
closing the documented gap where mirrors had no cap family for
post-cutover days.

The canonical chain's finalization now runs the per-chain funding
resolution live: each chain gets its own funded per-day stamp, the
canonical chain prices its own claims and remittances from its stamp
(never the summed aggregate, which stays a metric), and per-side daily
ceilings replace the former single shared value. On a single-chain
deployment every figure equals the previous single-pool behaviour exactly.

**Scope boundary (deliberate).** The mirror-side half of the mesh — a
mirror consuming its own recycled bucket to fund its slice, and the
two-sided netting that pairs it with the canonical ledger — is **not**
turned on here. Making that safe requires tracking each mirror's actually
delivered recycled backing (its own surrendered slice plus received
cross-chain remittances); enabling mirror consumption before that backing
is tracked would let a mirror pay rewards from value still in transit and
report availability it does not yet hold. So until the delivered-backing
ledger lands in the next mesh stage, the canonical chain funds the whole
mesh budget: mirrors receive their funding entirely by remittance, the
per-destination stamp + cap family ride the wire ready for the next stage
to arm against, and no mirror is instructed to consume its bucket. The
distribution-coupling cutover remains gated on the full mesh being
deployed, so none of this is reachable on the current single-chain
testnet.

Rollout keeps every upgrade-order combination live: mirrors still accept
the legacy shared broadcast, the canonical trigger falls back to the
legacy send when its transport predates the evolution, and a
per-destination packet to a not-yet-upgraded chain stays a failed,
re-executable delivery. Part of #1222; carries the #1351 cap-family (2g)
tail.

## Thread — Commitment-gate plumbing for ShareOfPool finalization (PR #TBD)

The recycling mesh gains the Base-side half of safe ShareOfPool
finalization: the day-close readiness gate now knows about mirror
reward-headroom **commitments**, so a mirror can be funded only once its
commitments for the day are known — never from a partial or absent set
(#1222 M3 B2-c; completion-plan §M3 hardening rule 1).

Concretely, this stage lands the **gate plumbing** on the canonical chain
and defers the mirror→Base **report** that fills it to the next mesh
stage:

- On a post-cutover (armed) day, the fast full-coverage close additionally
  waits for every expected **mirror** chain's commitments to be complete.
  The canonical chain is exempt (it is never remitted to), which also keeps
  the gate inert on a single-chain deployment. The grace window stays the
  backstop that still closes a stuck day.
- **Any** close of an armed day without a mirror's complete commitments —
  the ordinary **grace-window** close as well as an operator **force-close**
  — marks that mirror **remit-ineligible-pending-reconciliation**: its
  ShareOfPool remittance is blocked (never sized from a partial set), so
  after such a close its quotes return zero and the remittance path skips
  that chain-day until an operator reconciles the true headroom off-chain,
  clears the flag, and remits that day explicitly. Only the fast
  full-coverage close (which requires completeness) leaves a mirror
  eligible.

**Scope boundary (deliberate) — the report moves to the next stage.** An
earlier draft of this stage also carried the mirror→Base commitment
report itself (a paged, per-loan message assembled from the mirror's live
active-loan list). Review established that this is the wrong mechanism for
capturing a mirror's *day-D claimable liabilities*: the active-loan list
is the wrong set (it omits closed-but-still-claimable loans and includes
loans opened after the day), it drifts when loans open/close between the
report's page messages, and a permissionless report is grief-able. Those
liabilities are, moreover, bounded by the per-day share cap — machinery
that lives in the delivered-backing stage. So the report is designed once,
correctly, in that next stage, alongside the mirror consumption and the
delivery-acknowledged remitted clamp it is coupled to; until then the gate
here is dormant (nothing sets a mirror complete), inert on the current
single-chain testnet, and fail-safe on any armed multi-chain day. Part of
#1222.

## Thread — Mirror→Base commitment report + remit-gate retiming (PR #TBD)

The recycling mesh gains the mirror→Base **commitment report** — the piece
the B2-c gate was waiting for — and, in building it, corrects where that
gate belongs (#1222 M3 B2-d1; completion-plan §M3; design record
Vpfi1222B2dDeliveredBackingDesign.md, esp. §2b).

**What a mirror now reports.** For every armed day, a mirror computes its
per-side *day-D claimable liability*: each day-covering reward entry's
day-D demand, individually clamped by the per-day share cap, summed per
side. The unit is the *entry*, deliberately not the user (review round 1):
position transfers can regroup entries across owners after the once-only
report, and the per-entry figure is invariant under any regrouping while
never under-stating the eventual per-user capped claims — a bounded
over-reservation is later swept back by the netting stage, whereas an
under-statement would permanently underfund the mirror. The operator's
keeper feeds the entries in batches, but the mirror recomputes every
figure from its own records — the keeper can delay a report, never
distort one. Completeness is proven by **demand conservation**: the
submitted entries must exactly exhaust the day's per-side interest
totals, so a missing entry keeps the day incomplete (delays, never
understates). Entries are accepted at most once per day and side, in
strictly ascending id order; submissions are restricted to the keeper so
a third party cannot wedge a day with a deliberate skip, and an operator
valve can wipe a day-side for full resubmission while the report is
unsent. Once both sides complete, the
report is dispatched to the canonical chain exactly once (a failed send
rolls back and stays retryable), where it is stored per chain-day —
idempotently against duplicate delivery — as the input the
delivered-backing remittance clamp will read.

**The retiming (supersedes part of B2-c's gate placement).** Building the
report surfaced a circular dependency in the planned wiring: a day's
liability prices from the per-side caps and funding composition that the
canonical chain computes *at that day's finalization* and then broadcasts
— so the report can only ever arrive **after** finalize, while the B2-c
gate had finalization *waiting for* the report. Left as-was, every armed
day would have stalled into the grace backstop with all mirrors marked
remit-ineligible, permanently. The plan's goals (never fund from a
partial set; a late report delays, never zeroes; no permanent
underfunding) are preserved at the only causally-possible site:

- Finalization readiness no longer consults commitments; an armed day
  fast-closes on full interest coverage, as before the gate.
- What waits for the report is the chain-day's **ShareOfPool remittance**
  (the next stage's gate + clamp consume the stored liabilities).
- **Remit-ineligible-pending-reconciliation** now marks the one genuinely
  poisoned case: an armed day finalized with a chain's interest
  contribution zeroed out of the denominator. That chain's late report is
  still accepted for bookkeeping — though it prices at the chain's
  deliberately-zero funding composition, so the operator sizes the
  compensation from the mirror's locally readable state. Clearing the
  flag records the reconciliation; the funding vehicle itself lands with
  the delivered-backing stage (a zeroed chain has no slice for the
  ordinary remittance call, and a manual send must reserve and
  acknowledge like any remittance) — until then, zeroed-chain
  compensation stays the pre-mesh out-of-band governance posture. Historical reports also survive later edits
  to the expected-chain list (membership checks the day's own finalized
  evidence). Chains whose interest reported normally are never marked.
- A mirror cannot dispatch before both the day's funding broadcast has
  landed AND its own interest close has run (the close finalizes the
  totals completeness is proven against), so a quiet-looking
  not-yet-closed day can never ship an irreversible zero report; unarmed
  days are not reportable at all.

**Keeper.** A new mirror-side pass drives the flow end to end: it walks
the chain's own sequential reward-entry ids from the on-chain cursor (no
indexer dependency — the sequence is the complete enumeration, and it is
creation-ordered so a day's scan has a natural stopping frontier),
submits ascending batches, dispatches the report when the day completes,
and keeps retrying unresolved days even past its normal lookback window. Dark until both the master
keeper switch and a dedicated flag are set, and the keeper account holds
the on-chain keeper role.

The mirror-side consumption, the delivered-backing ledger, and the
remittance clamp that reads these stored liabilities land in the next
slices. Part of #1222.

## #1222 M3 B2-d2 — delivered-backing remit ledger: reservation → ack lifecycle, the Σcommitments remit gate + clamp, and the zeroed-chain manual-budget path

Stage B2-d2 of the recycling completion programme (plan #1348 §M3; umbrella
#1349; design record `Vpfi1222B2dDeliveredBackingDesign.md` §2d/§3). B2-d1
gave Base each mirror's day-level claimable-liability report; this stage makes
that report actually govern the money, and closes the loop on whether a
remittance was ever *delivered*.

**The remit gate and clamp are live, identically at every remittance
surface.** On an armed day, Base remits to a chain only once that chain's
commitment report is complete (a late report delays the day, never zeroes
it), and the amount is the uncapped slice bounded by the chain's reported
liability — Base never sends a mirror more than the mirror itself attested it
can pay out. The send and both planning quotes share one computation, so a
quoted batch is exactly what the send moves. The withheld surplus stays where
it was (fresh in the emission pool, recycled in the bucket), and the day's
finalization-time funding commitments are retired in full at terminal close —
including an explicit release of the withheld residual's reservation, so a
clamped day can never leave availability permanently encumbered. A day whose
whole slice clamps to zero still closes cleanly with nothing dispatched.
Pre-cutover days are untouched.

**Every remittance now reserves before it dispatches, and finalizes only on
delivery.** The send records a reservation (destination, amount, funding
decomposition, the days it closed) under a fresh reservation id that travels
in the message; the cross-chain transport's message id is bound to the
reservation at send time — the operator's entry point when reconciling from
observed delivery evidence. On delivery the mirror records a receipt and
anyone may trigger its acknowledgement (content comes from the mirror's own
receipt, the caller only pays the fee, and a lost ack is recovered by simply
re-sending). Base finalizes each reservation exactly once. Two evidenced
operator valves cover the terminal edge cases: force-finalize for a
delivered-but-ack-lost reservation, and release for a message that can
verifiably never execute — release re-opens the days and restores the
counters and commitments, but deliberately does not re-credit the recycle
bucket (the tokens sit in the transport's custody, not the platform's; a
late ack after a wrong release is loudly surfaced).

**The zeroed-chain manual-budget path exists now** (the B2-d1 review
deferral): a day force-finalized with a chain zeroed out of the interest
denominator can be funded by an operator-sized manual send that anchors on
the still-set remit-ineligible flag as its evidence, draws fresh under the
lifetime emission cap, and reserves + acknowledges through the same ledger
as any remittance.

Receipts are bound to the canonical deployment itself: the sending
deployment embeds its own identity in the remittance message (immutable,
transport-authenticated data — never delivery-time configuration), the
mirror keys each receipt by that identity plus the reservation number so
different deployments' same-numbered receipts co-exist, and the
acknowledgement echoes the recorded identity, accepted only when it names
the receiving deployment itself. Even a same-chain canonical redeployment
can therefore never let stale-era receipts finalize the new deployment's
reservations, and nothing is ever wedged or overwritten by pre-rotation
state. Releases keep every value counter reserved (the sent tokens sit in
the transport's custody) — re-funding consumes new headroom and backing,
and physical recovery restores the counters through governance.

**Keeper + indexer.** A new keeper pass scans Base's dense reservation
sequence (terminal-prefix frontier plus a rotating cursor, so one stuck
delivery can never hide later reservations) and drives each landed
delivery's ack (rate-limited per reservation); the remittance pass now
plans through a batch view that also surfaces clamped-to-zero days needing
closure, and extends its window over the armed range so late-completing
reports are still funded; the indexer persists operator reconcile events so
the mirror commitment-report pass re-surfaces reconciled old days outside
its normal scan window. Operator note: apply D1 migration
`0044_keeper_remit_ack.sql` before enabling the passes (same
`REWARD_REMIT_ENABLED` / `REWARD_COMMIT_ENABLED` arming as before — nothing
new to flip).

Everything ships dark until the governor arming ceremony; on a single-chain
deployment the entire surface is inert.

## #1222 M3 B2-d3 — mirror chains fund their own share, and the platform stops shipping tokens a chain already holds

Stage B2-d3 of the recycling completion programme (plan #1348 §M3; umbrella
#1349; design record `Vpfi1222B2dDeliveredBackingDesign.md` §2e). The previous
stages let the canonical chain fund the entire multi-chain reward budget by
itself, because a mirror chain funding its own share was only safe once the
delivered-backing ledger existed. It does now, so this stage turns local
funding on and closes the round-trip waste the cross-chain design exists to
remove.

**Each chain now funds its reward share from its own recycled balance first.**
When the platform sizes a day's reward budget across chains, a mirror chain's
share is covered from the recycled VPFI that chain has already absorbed
locally, and the canonical chain tops up only the shortfall. What a chain can
fund locally is bounded by what it has actually reported absorbing, less
everything the platform has already instructed it to fund — so the same
tokens can never be committed twice across days, and the standing invariant
that a chain is never instructed to fund more than it has reported now binds
in practice rather than vacuously.

**The daily broadcast commits; it does not spend.** When a chain receives its
day's funding instruction, it encumbers that amount of its own recycled
balance — reserving it for the day's payouts. The balance itself is drawn down
later, as users actually claim, and an unclaimed or forfeited remainder is
released back to availability. That is the same reserve-then-spend-then-release
lifecycle the canonical chain has always run for its own commitments, so a
chain's books stay honest without any new machinery. (Debiting at instruction
time instead would have charged the same tokens twice, since claims already
debit as they pay — the review record documents that finding.)

**Remittances now carry only the top-up.** Because a chain funds part of its
own share, the platform sends only the remainder it actually funded — the two
sides sum exactly to that chain's funded budget, with nothing shipped
round-trip and nothing double-funded. The netting applies identically to the
send and to every planning quote, so what a quote reports is what a send
moves.

Everything remains dark until the governor arming ceremony, and on a
single-chain deployment the entire surface is inert.

## #1222 M3 B2-d4 — multi-chain reward claims stay paused, and now it is written down why

Stage B2-d4 of the recycling completion programme (plan #1348 §M3; umbrella
#1349; design record `Vpfi1222B2dDeliveredBackingDesign.md` §2g) set out to let
chains other than the canonical one price their own reward claims. **The change
was withdrawn during review.** Those claims remain paused, exactly as before, and
this note records what has to be true before they can resume.

**No behaviour changes.** Reward claims on a receiving chain were already paused
for post-cutover days and still are. Nothing regresses, and none of this surface
is reachable until the operator arming ceremony in any case.

**Why the pause was expected to lift.** It existed because such a chain's reward
funding arrives by remittance, and nothing recorded those arriving tokens against
the chain's own recycled balance — so paying from that balance would have spent
value absorbed for other purposes. The previous stage fixed exactly that, and the
recycled side has a second protection besides: a claim budgets the recycled
portion against the chain's live balance and defers any day it cannot cover.

**Why it did not lift.** Review found the pause was doing two further jobs that
the previous stage never addressed:

1. *The freshly-issued side has no equivalent limit on a receiving chain.* That
   side is funded entirely by the canonical chain and arrives with the
   remittance, but a claim there limits it only against the programme's global
   lifetime ceiling less that chain's own past payouts — not against what has
   actually been received. Resuming claims would have let a chain pay out before
   its funding arrived, drawing on tokens the platform holds for unrelated
   obligations.
2. *Days that were deliberately zeroed would consume themselves.* When a chain's
   activity report is missing at day-close, the platform deliberately records
   that chain's funding for the day as zero and flags the day for separate,
   operator-sized compensation. With claims resumed, such a day would be walked
   as an ordinary zero-value day: it would count as settled and the rewards
   attached to it would be closed out — before the compensation could reach
   them.

Both are now tracked as explicit prerequisites, and the pause is covered by a
test so it cannot be removed inadvertently.

**One durable rule came out of this**, recorded alongside the code. When a chain
cannot pay a day for want of funding, the claim stops at that day and resumes
from it on a later attempt — days are settled oldest-first, so later days do
wait behind it. That is acceptable only because the wait can always end: a day
the platform actually funds becomes payable as soon as its funding lands.

The rule is therefore about what the wait is keyed on. A wait keyed on the
*amount* of funding present always clears. A wait keyed on the *arrival of a
message* may never clear — and some days are deliberately never funded from the
canonical chain, either because the receiving chain covers them entirely from
its own balance or because the day's liability rounds to nothing. Keying on
arrival would strand that chain's rewards permanently, which is the trap the
first attempt at this stage fell into.

## #1222 M3 B2-d5 — a chain's own absorption stops being confused with tokens the platform sent it

Stage B2-d5 of the recycling completion programme (plan #1348 §M3; umbrella
#1349; design record `Vpfi1222B2dDeliveredBackingDesign.md` §2f). It closes the
last accounting gap between a mirror chain's recycled balance and what that
chain truthfully reports about itself, and it is the stage that makes mirror
reward claims safe to switch on.

**The problem it fixes.** When the canonical chain tops up a mirror chain's
reward budget, real tokens arrive on that chain. Until now nothing recorded
them against that chain's recycled balance — the balance was only ever credited
by the chain's own absorption. But when users on that chain claim their
rewards, the payout is drawn down against that same balance in full, without
distinguishing which part the chain funded itself and which part arrived from
the canonical chain. A chain that funded 40 of a 63-token day and received the
other 23 would draw 63 against a balance that only ever recorded 40. The
shortfall did not lose anyone's tokens, but it corrupted the chain's own
bookkeeping — and that bookkeeping is exactly what the canonical chain reads to
decide how much that chain can fund next time.

**Arriving top-ups are now recorded as relocated custody.** A remittance now
states how much of it is recycled, and the receiving chain records that portion
against its recycled balance so the claim path has real backing. Critically,
this is recorded as a *relocation of custody*, not as absorption. Those tokens
were already counted once as absorbed on the canonical chain when they first
entered the recycled economy; counting them again on arrival would let a single
protocol receipt cycle round — balance, budget, expiry, balance — and
manufacture repeat reward budget with no user activity behind it.

**The exclusion had to be wider than it first looked.** Keeping relocated
custody out of the daily absorption figure is not enough on its own. Each chain
also reports a lifetime absorption total, and the canonical chain derives two
separate things from it: how much that chain may fund locally, and how much
day-by-day absorption it is allowed to claim. Letting relocated custody into
that lifetime total would have handed the canonical chain a phantom balance —
it would have read its own already-spent top-up back as the mirror's own money
and committed it a second time. So a relocated-custody total is tracked
separately and netted out of the figure each chain reports. The netting holds
even after the tokens are claimed, which is the case that matters, because
claiming moves value between the two quantities the reported figure is derived
from.

**Reporting keeps a separate channel.** The relocation is announced on its own
event rather than being folded into the existing absorption event with a new
label. Every existing reader of that event treats it as absorption, so reusing
it would have manufactured absorption in the reporting layer even while the
on-chain figures stayed correct — and silently, in any reader not updated at the
same time. A distinct channel makes an un-updated reader under-count, which is
visible and conservative, instead of over-count.

**Compatibility and safety.** Remittances sent before this change decode as
carrying no recycled portion, which reproduces exactly the previous behaviour —
no credit rather than a wrong credit. A remittance that claims more recycled
backing than it actually delivered is rejected outright, and a delivery that
arrives short (for tokens that charge on transfer) has its recycled portion
scaled down to what genuinely landed. As with every stage of this programme,
none of it is active until the operator arming ceremony; single-chain
deployments are unaffected.

**Upgrades cannot be applied half-way without noticing.** The chains in this
mesh are upgraded one at a time, and the canonical chain goes first — so there
is always a window where it has started stating the recycled portion while some
receiving chain has not yet learned to read it. The new message is deliberately
shaped so that an un-upgraded receiver cannot misread it: rather than looking
like a slightly longer version of the old message — which an old reader would
have accepted while quietly discarding the new fields, stranding the sender's
record and skipping the credit — it is marked such that an old reader rejects it
outright. The delivery then fails loudly and is re-delivered once that chain is
upgraded, so nothing is lost and nothing is silently mis-recorded. This makes
the upgrade order impossible to get wrong, rather than merely documented; it
needs no operator switch. The same reasoning applies to the operator's in-place
refresh tooling, which now upgrades the receiving component alongside the rest
and refuses to proceed on a receiving chain whose record of that component is
missing.

The off-chain indexer is deliberately left un-updated here: it records
absorption from the existing event, and relocated custody is correctly absent
from absorption, so its figures stay right. Surfacing the relocation itself
belongs with the transparency-metric milestone that consumes it.

Follow-up: with the backing now real, the next stage lifts the halt that
currently stops mirror chains from pricing reward claims on armed days.

## #1222 M3 B3 — a receiving chain's unspent reward commitments stop being lost

Stage B3 of the recycling completion programme (plan #1348 §M3; umbrella
#1349; design record `Vpfi1222B3SourceScopedNettingDesign.md`) closes the last
open half of the cross-chain reward books.

**The setup.** When the platform runs reward accounting across several chains,
one chain does the sizing and each other chain is told how much of a day's
reward budget to pay from its own recycled balance rather than waiting for a
transfer. The sizing chain records that instruction, and it models each other
chain's remaining balance as "everything that chain reported absorbing, less
everything it has been instructed to pay".

**What was wrong.** That model had no way to learn what a chain actually did
with an instruction. Two things followed.

First, the record of a chain's outstanding instructions only ever grew. It was
never reduced as those instructions were spent, so the figure operators and
monitoring read drifted further from reality every day.

Second — and this is the one that mattered — a reward can end without being
paid. A borrower or lender can forfeit their reward, or leave it unclaimed
past the claim horizon. When that happens the tokens set aside for it simply
stay in the chain's balance; nothing moves. But the sizing chain still counted
them as spent. Over a deploy's lifetime that gap widens without limit: a chain
with ordinary forfeit rates would eventually read as having no balance at all
while its balance was in fact full, and the platform would quietly go back to
funding every chain's rewards from the one sizing chain — exactly the
behaviour the multi-chain design exists to avoid.

**What changed.** Each chain now keeps two running totals — how much of its
reward commitments it has settled in total, and how much of that was settled
without any payout — and reports both on its daily close, alongside the
figures it already sends. The sizing chain uses the first to draw its
outstanding-instruction record down as those instructions are settled, and the
second to give the chain its balance back for commitments that ended without
paying anyone.

**Trust boundaries.** A reporting chain is believed about *when* things
happened, never about *how much*. Both totals are checked against what the
sizing chain itself instructed before they are accepted, and against each
other. The effect is a hard ceiling: a chain's available balance can never be
made to read higher than what that chain reported absorbing in the first
place — so this cannot be used to re-offer funding that was already sent to it
from elsewhere, which an earlier stage deliberately excluded.

**Rollout.** The daily report grows by two fields. The receiving side accepts
the new shape before any sender uses it, and both the sending and receiving
paths fall back one generation at a time if a component has not been upgraded
yet, so a partially-upgraded deployment keeps closing days normally and simply
omits the new figures until it catches up. Chains upgraded over existing state
start both totals at zero and recover forward as new settlements happen.

**No user-visible change.** Nothing here is reachable until the operator
arming ceremony, and no reward amount, claim, or fee changes. It is the
bookkeeping that decides which chain pays a reward from its own balance.

**Also in this change**, two operator read-outs about per-chain recycled
balances moved from the general configuration surface to the rewards surface,
alongside the rest of the per-chain reward records. Their content is
unchanged.

## #1222 M3 B4-a — the cross-chain reward books are now proved, not just tested

Stage B4-a of the recycling completion programme (plan #1348 §M3; umbrella
#1349) adds a property-based test suite for the multi-chain reward
bookkeeping. It changes no behaviour — it establishes that the behaviour
already shipped cannot be broken.

**What it proves.** Six standing rules about what the sizing chain believes of
every other chain, checked against tens of thousands of randomly generated
message sequences rather than a handful of hand-written scenarios:

- a chain is never asked to fund more than it has reported absorbing, once
  commitments it settled without paying anyone are credited back;
- the record of a chain's outstanding instructions always equals what it was
  instructed minus what it has settled — exactly, including while messages are
  still in flight;
- a chain's available funding can never read higher than what that chain
  reported absorbing in the first place;
- a reporting chain is believed about *when* things happened, never about *how
  much* — both settlement totals stay bounded by what the sizing chain itself
  instructed;
- a day can never be sized against funds another unsettled day already
  committed;
- the sizing chain's books about itself stay empty, so a single-chain
  deployment is untouched by any of this.

**Why generated sequences.** The generator is free to reorder, duplicate,
drop, and interleave reports with day closings, and to send deliberately
absurd figures — which is the honest way to check bounds that exist precisely
because a faulty or compromised chain might lie. A scripted test can only
demonstrate the cases its author thought of.

**What generated sequences cannot establish, and what covers it instead.**
The six rules above are all *upper bounds on final state*. Several further
guarantees are about a **transition** — a repeated message must change
nothing, a skipped report must be made whole by the next one, a settlement
total must never move backwards, and a commitment ended without payment must
actually give funding capacity back. A bound cannot prove any of those: a
ledger could mishandle every one of them and still finish inside every bound.
Those guarantees are therefore covered by deliberately scripted checks that
read the books, apply exactly one message, and read them again. The generated
campaign owns the bounds; the scripted checks own the transitions. Saying
otherwise would be the kind of assurance overclaim this note is at pains to
avoid.

**A note on how this suite was built, because it matters.** All six rules are
upper bounds, so all six hold trivially on an untouched ledger — a test driver
that quietly does nothing produces a completely green suite that proves
nothing at all. That happened twice while writing this, and both times the
output was indistinguishable from success. The suite therefore carries a guard
that fails the run outright if the generator never actually exercised the
machinery. Anyone extending it should keep that guard honest.

The rules were also checked in the other direction: with the protective bounds
deliberately removed, three of the six fail as they should. That exercise
confirmed something worth recording — the "available funding can never exceed
what was reported" rule now holds because of how the arithmetic is arranged,
not because of the bounds, so it survives even that mutation.

## Recycled reward funding — the three-chain mesh, proved end to end

The cross-chain recycled-funding mesh has been built in stages, and each
stage was checked against a test that stood in for the other chains.
Until now every one of those tests ran a single deployment playing the
canonical chain, with the other chains' numbers supplied by the test
itself. That is enough to check that the canonical chain does the right
arithmetic on the numbers it is given. It cannot check the thing the
mesh is actually for: that what one chain believes about another
matches what that other chain believes about itself.

This change adds a suite that runs three real deployments at once — one
canonical chain and two receiving chains — connected by a transport that
holds messages in a queue until the test chooses to deliver them. Every
figure the canonical chain takes in was produced by a real receiving
chain doing real work, and every figure a receiving chain applies came
out of a real finalization. Holding the messages in a queue also lets the
suite do what a live network does at its worst: deliver messages out of
order, deliver the same message twice, and never deliver some at all.

What the suite establishes:

- **What the canonical chain instructs a chain to fund is exactly what
  that chain sets aside** — checked separately on each of the two
  receiving chains, whose figures are deliberately made unequal so that a
  fan-out which mixed the two up would be caught rather than pass.
- **A duplicated instruction changes nothing.** Re-delivering the very
  same message to a receiving chain does not make it set aside the amount
  twice. Networks of this kind can legitimately re-run a delivery, so
  this is a real hazard rather than a theoretical one.
- **An instruction delivered to the wrong chain is refused outright.**
- **A lost day-close report heals itself.** When one chain's report never
  arrives, the next one carries the whole backlog and the canonical
  chain's picture catches up without anyone replaying the lost message.
- **Unspent commitments come back.** A receiving chain that releases a
  commitment without paying anyone reports it on its next day-close, and
  the canonical chain both closes the outstanding record and gives the
  funding capacity back — one for one.
- **Chains stay separate.** Activity on one receiving chain moves that
  chain's record and leaves the other's alone.

One test was found during review to be asserting more than it showed, and
is worth naming rather than quietly fixing: a check that a dropped report
stayed dropped was undone by a later delivery sweep picking the "lost"
message back up, so it would have passed even for an implementation that
required every missed report to be replayed. Dropped messages are now
dropped permanently and the test asserts that at the end.

The suite also surfaced an **activation ordering requirement that had not
been written down anywhere**. Turning on the coupling is a single,
irreversible switch, and it is what starts creating commitments on
receiving chains. But a receiving chain cannot yet settle those
commitments — paying, forfeiting and lapsing all run through a pricing
path that is deliberately still blocked there. So it can set commitments
aside and settle none of them: its settlement totals stay at zero and the
canonical chain's view of its spare capacity is left permanently lower
than it would otherwise be, while that chain's balance sits untouched.

Two details of that are easy to state wrongly, and both were corrected
during review. It is a shortfall rather than a falling number — a chain
that keeps absorbing can raise its reported total faster than the
instructions subtract from it. And the capacity that goes missing is
specifically the capacity that would have come back from commitments
ending WITHOUT a payout; a commitment that ends by paying restores
nothing, because those tokens genuinely left. So a chain settling
normally and a stuck one look alike on capacity alone.

Telling them apart needs a different measure again, and getting this
backwards would have produced an alarm that fires forever on a perfectly
healthy chain: what identifies a stuck chain is its outstanding
instructions — the ones it has neither paid nor written off — standing
still. Unpaid endings say how much capacity came back; outstanding
instructions say whether anything is happening at all. The result recovers once
the block lifts (the totals are cumulative, so the backlog closes), but
for the whole window the platform would fund from the canonical chain
what the receiving chain could have funded itself — exactly the waste the
mesh exists to remove. The requirement is now recorded in both the
activation runbook and the specification, and the decay itself is pinned
by a test — two coupled days, a steadily growing commitment, steadily
falling capacity, and nothing settled on either side.

What that test deliberately does not claim is that the block is the
*sole* cause, because that cannot be demonstrated today: the receiving
chain's coupled-day payment path has never been reachable, and the very
prerequisites tracked under the block are what would make it pay. The
reasoning for the cause is recorded alongside the requirement so the
distinction survives.

No production behaviour changes: this is test coverage plus two
documentation corrections.

## Recycling mesh — an operator watcher for the per-chain ledgers (#1222 M3 B4-c)

The cross-chain recycling ledger has one property no test can check: it
spans chains. Base decides how much recycled reward budget a mirror may
fund from its own bucket, using Base's *model* of that mirror's
availability; the mirror then reserves against its *actual* bucket. Those
two figures live on different chains, are written by different
transactions, and reconcile only through periodic day-close reports. Each
side can be proven correct in isolation — B4-a and B4-b did exactly that
— but only something reading both at once can show they still agree in
production. This release adds that observer: a small internal Cloudflare
Worker, `ops/mesh-watcher`, that every fifteen minutes reads the per-chain
recycled books from the canonical reward chain and each chain's own bucket
and reservation counters from that chain's own Diamond, then checks the
relations that hold the two views together.

Eight of those relations cannot legitimately break — they are maintained
by construction, so a violation means a bug, a spoofed report, or storage
corruption, never ordinary operation. They ship as real alerts: the
per-chain commit identity (outstanding plus retired always equals what
Base instructed); the clamp chain that keeps a mirror trusted for timing
but never for magnitude; the ceiling that stops day-credit attribution
exceeding what a chain reported absorbing; the availability formula
itself, re-derived off-chain so a drifted deployment is visible; the rule
that the canonical chain never books per-chain commitments against itself;
the rule that Base's accepted cumulatives never run ahead of the chain's
own; the bound that instructions to a chain never exceed what it reported
absorbing, net of what it released un-spent; and bucket coverage — that a chain's live bucket actually backs the
reservations made against it, which is the check that would catch Base's
model over-stating what a mirror holds. Bucket coverage allows a small,
documented tolerance rather than comparing exactly, because the payout
path deliberately floors the bucket at zero instead of reverting on
wei-scale rounding, and an exact comparison would page on healthy dust.

The ninth signal — a chain holding recycled commitments while retirement
stays flat — ships deliberately as an **advisory**, labelled as such in
every message. Its condition is necessary but not sufficient: a chain that
simply had no claims, forfeits or expiries fall due in the window
satisfies it perfectly legitimately, because commitments stay reserved
until a user or horizon event retires them. Choosing the
settlement-expected qualifier that would make it pageable is open design
work tracked on #1442. Shipping it as a pager today would have trained
whoever carries it to ignore the alert, which is worse than not having it.
Two further advisories cover a stalled report path and, always, any chain
the watcher could not read this tick — a watcher that quietly narrows its
scope would otherwise report "all clear" for chains it never looked at.

Review hardened several edges before this landed, two of which changed
behaviour rather than wording. Bucket coverage is CRITICAL on mirrors only:
on the canonical chain, releasing a permanently-failed remittance restores
the reservation while deliberately not re-crediting the bucket — those
tokens are locked in the bridge's custody, outside the platform's — so
paging there would have raised a false alarm on the contract's intended
recovery state. It is reported as an advisory naming that cause instead.
And every related read is now pinned to a single block per chain: those
fields are written together on-chain but read over several calls, so an
unpinned read could straddle a transaction and page a violation that never
existed — a false critical being the worst thing a watcher can produce.
The manual trigger is authenticated and fail-closed, because running a
tick is not a read-only probe and an unauthenticated caller could have
forged the very evidence the operator acts on. A second round tightened
what the alerts actually show — a report-lag message now names which of
the three reported cumulatives is behind, rather than always printing the
absorption pair and, when retirement was the trigger, a difference of
zero. A third round caught the report-lag threshold being far too tight:
those cumulatives travel only in a chain's day-close report, so between
reports the canonical side is legitimately behind and frozen for a whole
day, and the original hour-and-a-half window would have alarmed daily on
a perfectly healthy chain. It now spans more than a full report cycle
including the finalization grace. The same round added two things a first
deployment needs: the tick reports whether an alert destination is even
configured and fails if it is not — undeliverable alerts are not a
healthy state however clean the ledgers are — and a source set that omits
the canonical chain is now reported rather than silently papered over,
since the day's global totals are summed over exactly that set.

A fourth round found the one genuine security defect in the work. The
blockchain client library embeds the request URL in its error messages,
and RPC providers put the API key in that URL — so a provider having a
bad minute would have published a credential straight into the operator
chat and the logs. Every error string now passes through a redactor
before it can reach an alert: known secrets become named placeholders,
and any URL at all keeps its host and loses its path and query. The same
round added a missing ledger bound — that instructions to a chain never
exceed what it reported absorbing — which had been invisible because the
availability figure it would otherwise have shown up in saturates at
zero; corrected the stuck-settlement signal to read both of its inputs
from the same chain's books rather than one from each side, which would
have alarmed on chains that had already settled everything; and made the
manual verification actually send a test message, since a configured
pager and a working pager are not the same thing.

A fifth and sixth round were mostly about the hardening itself being
incomplete. Two fixes from an earlier round turned out not to hold: the
database-outage path that was supposed to preserve already-computed
findings still consulted the same unavailable database a moment later and
lost them anyway, and the credential scrubbing missed the one shape where
a secret lives entirely inside a URL's authority rather than its path.
Both are closed. Alongside them: the alert channel now delivers advisories
without notifying, so the non-paging tier is actually non-paging rather
than merely labelled; the manual verification endpoint no longer advances
the observation counters, which are denominated in scheduled runs; one
chain being unreadable no longer discards every other chain's evidence;
and a run that cannot see its whole mesh no longer reports itself healthy.
Verifying that each configured endpoint really is the chain it claims to
be is deferred to its own change.

A seventh round made clear that patching those storage-failure paths one
at a time was the wrong shape — the same defect had by then been found in
four different places, each time in whichever call site had not been
looked at yet. The delivery and bookkeeping half of a run is now one
piece of code stating one rule: findings are computed from chain reads
that already succeeded, so the bookkeeping database only decides whether
to suppress a repeat, and "could not check" has to mean "send it" rather
than "send nothing". A bookkeeping failure is now announced on the same
channel and makes the run report itself unhealthy, because it quietly
freezes the two windowed signals below their thresholds while everything
else looks fine. Each message also gets a deadline, so one request that
hangs cannot hold up the alerts behind it.

At that point the review had produced around fifty findings, and counting
where they landed was more useful than fixing the next one: about four
were in the ledger checks themselves and the rest were in operational
scaffolding, clustered into six recurring causes that kept reappearing in
whichever path had not yet been examined. Each is now closed at its
source rather than at its symptoms. Error text from outside the system is
classified into our own vocabulary instead of being passed along, so
there is no borrowed text in which a credential can hide. The storage
layer returns failures rather than raising them, so a bookkeeping problem
cannot discard evidence that was already gathered. The repeating-signal
logic, the identity of an alert, and the definition of a healthy run each
live in one place instead of being restated wherever they were needed.
And a chain snapshot now carries a marker that only the freshness check
can apply, so comparing against a stale reading is not something that can
be written by mistake.

Two design choices are worth recording. The chain set is not configured
anywhere in the Worker: it reads the expected source chains from the
canonical Diamond each tick, so a mirror wired on-chain is watched as soon
as it is wired, and a missing RPC endpoint surfaces as a reported coverage
gap instead of a silent skip. And the read shapes come from the compiled
facet ABI rather than hand-written signatures, with a startup assertion
that fails loudly if a re-export ever changes a watched view's shape —
the sibling LayerZero watcher could hand-write its signatures safely
because it read a third-party standard surface, but this Worker reads only
our own Diamond, where hand-typed tuples are precisely the drift that
caused the May 2026 decode incident. The check suite is mutation-verified:
every check was removed or subtly broken in turn and confirmed to turn its
own test red.

The Worker is code-complete and **undeployed**. Creating its database,
setting its secrets and the first deploy are documented operator steps in
its README; it runs on the cron slot freed by retiring the LayerZero
watcher, whose surfaces the CCIP migration and the securities-feature
excision had between them made entirely dead. Its typecheck and tests run
in CI as a non-blocking job — the Worker is detection-only, so a red there
should inform rather than block a contracts merge.

Part of #1222. Follow-ups: #1442 (the settlement-expected qualifier),
#1440 (removing the retired LayerZero watcher's source tree).

## Cross-chain reward funding — specification caught up, and the allocation ceiling tested where it actually bites

The specification of how a chain's daily reward budget gets funded still
described the shape the platform had before recycling went cross-chain: the
canonical chain works out every chain's share and sends it. That has not been
the whole picture for several releases.

What is true now is narrower than "each chain funds itself", and the
distinction matters. A day's budget has two portions:

- the **scheduled portion**, its share of the fixed allocation, is still
  funded by the canonical chain for every chain. Local recycled value never
  substitutes for it, because it comes from a different pot;
- the **recycled portion**, sized from what each chain has absorbed, resolves
  in two passes: a chain funds its own recycled share from value it has
  itself absorbed and not yet spent, and only the shortfall draws on the
  canonical chain.

Writing that down turned up one thing the specification had wrong, one the
platform has wrong, and one apparent contradiction that turned out to be
neither.

The apparent one is worth recording because it was nearly resolved the wrong
way, twice. Review reported that the specification's claim — an inactive day
already has a recycled portion measured against the central pool — is contradicted by the
platform, which appeared to give such a day none at all. Both observations were
accurate, and they were about **different stages of the same day**: when a day
is closed, its record does carry a recycled portion, measured against the
central pool. What an inactive day does not do is *pay* that portion out.
Until the programme is switched on the record is only a record, and claims are
paid from the scheduled portion — paying earlier would mean setting value aside
with nothing yet able to spend it, shrinking the very headroom the cap protects.

Resolving that then exposed a second, narrower error in the same sentence, and
this one was real: the specification said the portion was "remitted from" the
central pool. It is not. No RECYCLED value moves on an inactive day — the pool
is what that figure is *measured against*, not a source it is drawn from, and
no recycled transfer, reservation or payout occurs. (Scheduled value does move,
of course; the paragraph above says claims are paid from the scheduled portion.
An earlier draft of this sentence said "nothing moves", which contradicted its
own predecessor two sentences earlier.) Three different things had been
collapsed into one word, which is what made the whole sentence read as a
contradiction in the first place. It now states all three, including what does
not happen.

So nothing needed changing on either side. What did need changing was the
specification sentence, which never said which stage it described — and that
omission is what let a stage confusion look like a contradiction. It says so
now. And the rule that recycled
value must never stand in for the scheduled portion turns out to be intent
rather than enforcement: a payout reduces the recycled ledger by its recycled
part and then pays the whole amount out of one pooled balance, so a chain
holding recycled value whose scheduled portion has not arrived can pay a
scheduled-only claim out of the tokens backing the recycled pool. Nothing is
paid to the wrong person, but the books stop being true — the recycled pool
claims more than it holds, and a later recycled claim fails instead of the
scheduled one having failed for want of funding. That is filed as #1460 and
must be closed before the recycled programme is switched on; the
specification now records the rule as intended-but-unenforced rather than
implying it holds today.

Two further promises elsewhere in the same specification rested on that rule
without saying so, and both are now qualified in the same terms. One said a
recycled claim never fails while a recycled budget stands — true of the
recycled term itself, but a recycled claim can still fail *later* if a
scheduled payout has already spent the custody behind that budget without
reducing it. The other said the reward bucket is always covered by real
custody, which is what backs the bounded keeper-incentive share carved from
inside it; that share is unbacked by exactly the same shortfall. Neither
statement was wrong about intent, and both would have read to someone
relying on them as a property that already holds.

So a network where each chain roughly recycles what it pays out still
receives its scheduled portion centrally, while its recycled portion settles
locally and moves nothing across chains. The canonical chain is the top-up of
last resort for the recycled portion specifically — not for the whole share.

Two further behaviours were live but unstated at that level: **once the
programme is armed**, a chain's funding for a day waits on that chain's own
report of what it owes for the day, and is sized by it, so such a day is never
funded from a partial or missing picture — a late report delays funding rather
than zeroing it. The "once armed" is not decoration: a day from before the
programme was switched on carries no such report to be sized against, and is
funded the older way without one. Written without that qualifier, this would
have someone waiting for a report an unarmed day never produces. And the one deliberate
exception, a day closed while a chain's activity was missing entirely, is
excluded from automatic funding on purpose, because that day's share was sized
without knowing the chain's real demand; an operator funds it separately
against evidence.

The specification also now states what the lifetime ceiling actually limits:
**drawdown**, not issuance. Nothing is minted per claim, so calling it an
issuance ceiling would hand anyone reading downstream the wrong model of the
token supply. It is equally not a balance that exists by virtue of deploying —
deployment mints a smaller initial amount elsewhere, and the balance claims
are paid from has to be funded into the platform separately. The practical
consequence is worth stating plainly, because it is the kind of thing found
the hard way: the platform can report ample headroom while holding nothing to
pay it with. Value recycled back into the
reward bucket is value the platform already received and is re-spending, so it
is not drawn from that allocation at all — which is why a day whose fresh
headroom is exhausted can still pay from the recycled bucket, and must, or the
recycling programme would end the moment the allocation was fully committed
rather than fully paid. The headroom counts value already *committed*, and
value already sent to another chain, as well as value already paid out: each
has spent that room even though the tokens may not have reached a claimant
yet, so no later day can size against it twice.

One older rule had to be superseded to say that cleanly. The specification
still carried a line stating that rewards must simply stop once the allocation
is exhausted — correct when the allocation was the only source of funding, and
directly contradictory now that a day beyond it can be funded from recycled
value. Extending the programme past the fixed allocation is what recycling is
for, so the old sentence read literally forbade the mechanism's whole purpose.
Rewards now stop when the allocation is exhausted *and* no recycled value is
available.

That headroom rule is where the accompanying test work went. The existing
check on it was an upper bound, and an upper bound is satisfied for free by
any state that never comes near it. The random-sequence campaign that
exercises this ledger cannot reach even two percent of the ceiling, so the
check was green because the boundary was unapproachable rather than because it
was enforced.

Five deterministic tests now place the ledger at the boundary. Three of them
place a single term there directly:

- with a known amount of headroom left, the day's fresh funding must clamp to
  exactly that headroom instead of to its own schedule;
- with the allocation fully committed, the day must fund nothing fresh at all
  while still funding from the recycled bucket;
- and value already sent to another chain must reserve against the ceiling the
  same way — the one term no test could previously place at the boundary,
  since reaching it for real needs a chain to have been sent almost the whole
  allocation.

Two further tests place those terms at the boundary **together**, because
each of the first three leaves only one of them non-zero — and a version of
the platform that took the larger of two reservations instead of adding them
produces exactly the right headroom in all three, passing every check. Only
a state carrying both at once separates the two, and it is an ordinary state
rather than a contrived one: value sent to another chain earlier, while one
of the main chain's own days is still open. Without it the platform could
have over-committed by the smaller of the two amounts on every such day,
invisibly.

The fifth adds the third term — value already paid out to claimants — for
the same reason one level up: with only the two commitment-side terms
present, a version that ignored what had already been paid, or that took
the larger of the two sides, still produced the right answer everywhere.
That one is not an edge case at all: once any claim has been paid, the
paid-out figure is non-zero for the rest of the programme's life, so the
surviving version would have over-committed on every day after the first
payout.

Each was confirmed against the change that would break it. The per-mutation
detail now lives in one place — a table beside the tests themselves — rather
than being restated here.

That is a deliberate change, and the reason is worth recording: three
successive reviews caught this description claiming a mutation was caught by
one fixture "and only that one", each time because a fixture had since been
added and nothing ties prose to the fixture set. Exclusivity is also the
wrong property to have been claiming — and so was the ordering criterion that
briefly replaced it, since the measured sets are not nested and so "fails while
the others pass" establishes nothing either. What makes a fixture worth keeping
is that it pins a distinct behaviour at the boundary and documents it, whether
or not another fixture happens to catch the same regression. Review also caught that
checking the day's *published* figure was not enough — the platform could
publish the clamped number and still reserve against the unclamped one, on
either the fresh or the recycled side — so the tests read the reservations
themselves, and each of those two omissions now fails a test.

Finally, the specification's testing requirements record what a cross-chain
test has to establish that a single-deployment test cannot. The properties
this layer adds are all *disagreements* between two ledgers on different
chains, updated by different transactions — a harness where one deployment
stands in for three cannot express a disagreement, so it cannot fail for the
reason that matters. Alongside that: the ordering guarantees a message
transport does not make, the two properties that are statements about a single
transition rather than about final state, and the requirement that the
continuous relations be checkable from public reads on a live deployment
rather than by replaying history.

Part of #1222 (stage B4-d), under the #1349 umbrella. This also settles which
tests evidence the cross-chain labelling work tracked under the closed #1331:
the receive path is exercised by the remittance ledger's own tests and made
observable by the published-counter relations, with the case of an arrival
never labelled at all left open as #1452. These boundary tests do **not**
evidence it — they exercise allocation-ceiling behaviour and never deliver a
remittance. The half of that work concerning chains other than the canonical
one is only partly future: value arriving on such a chain is already labelled
and credited to its local pool today. What does not exist yet is that chain
pricing its own claims, and therefore settling or releasing what it has
committed — reachable only with #1434.

## Thread — alpha02 grace-window parity for close-early and refinance (PR #TBD)

The contracts (Pass-2 A1/D5, #1189) made closing a loan early and
refinancing it valid all the way through the grace window — both
charge the same late fee a normal late repayment does there, and only
a strictly-past-grace attempt is rejected. The alpha02 app still
gated both surfaces at the original due date, so a borrower inside
the grace window could not reach either door the protocol actually
holds open.

The position page now keeps the close-early card and the refinance
form available through the grace window, judged by chain time against
the live term fields and the live grace schedule. In grace, both
surfaces say plainly that the loan is past due and that the figures
include the growing late fee (the close-early quote comes from the
protocol's own settlement view, which already includes it). Strictly
past grace, both disappear and any attempt is stopped before a wallet
prompt with an honest "the default process applies now" message.

The refinance money-math is now time-aware end to end: the payoff
quote and the pending request's funding watch include the late fee
and the interest that keeps accruing past the due date as of now, and
the standing payoff approval (both at posting and from the restore
action) covers the full pull at the last moment the request could
still be accepted — its own expiry or the end of the grace window,
whichever comes first. Previously the approval was sized to
the fee-free payoff, so a request accepted inside the grace window
would pull more than the allowance and fail; the borrower had to
over-approve by hand. A pending request whose loan has gone strictly
past grace now reads as dead (like an expired one): funding warnings
stop and cancelling to unwind the approval is the remaining action.
The lender sale-listing flow keeps its at-maturity block (the
contract genuinely rejects listing a matured position) and got its
own accurately-worded error instead of borrowing the refinance one.

The new grace e2e scenario also exposed a latent Permit2 bug: the
signature deadline was computed from the device clock while the chain
judges it against block time, so a clock sitting more than thirty
minutes behind chain time (or a time-warped test fork) produced
already-expired permits. The deadline now comes from the chain's own
clock, matching how the accept-terms signature already works. The
same fix is tracked separately for the defi app, which shares the
ported signer.

Closes #1235. Closes #1236.

## Thread — push-hint sizing telemetry, ahead of the HINT_CAP retune (PR #TBD)

The scoped push-hint feature caps how many affected loan/offer ids one
indexer scan advertises in a refresh frame (`HINT_CAP`, currently 32) —
a conservative launch value chosen without traffic data. Retuning it
needs to know how big real scans actually get, which needs real load on
the testnet that doesn't exist yet.

This change adds the measurement rail so that data is captured the
moment load arrives: each indexer scan that touches anything now emits
one structured `hint-telemetry` log line with the true (pre-cap) id
counts and a breakdown of why a frame would truncate — by size versus
by the signed-order / ownership-transfer events that truncate for
reasons a bigger cap wouldn't fix. A short procedure doc explains how
to collect the stream during a rehearsal-load window and read the
distribution to pick the cap.

No client-visible behaviour changes and no cap change yet: the hint
payload, the truncation-honest contract, and the current cap are all
untouched. The actual number-pick is a one-line follow-up once
rehearsal load produces busy frames to measure.

Refs #1245.

## Thread — alpha02 list windows: every big list renders a page at a time (PR #TBD)

The #1247 pagination audit found two kinds of gap on the app side:
several surfaces rendered every row their capped fetch returned — up
to 500–2,000 row components on one navigation for a busy wallet or
market, each mounting its own token-metadata (and sometimes health or
claimability) reads — and two client reads had no data-layer ceiling
at all (the Claims position walk and the Rate Desk pair-book
hydration). This change applies the Activity feed's proven
window pattern everywhere: render the first twenty-five rows and a
"Show N more" button that grows the window a page at a time, so the
screen and the per-row reads scale with what the user asks to see.

Windowed surfaces: My positions (open offers plus the live and ended
loan groups — the needs-your-attention group deliberately stays whole,
since a hidden row there would be a hidden payout), the Offer Book
(whose per-row security screening now also grows with the window
instead of screening all fetched rows up front), the Claims list, NFT
rental listings, and the Rate Desk's open-orders and positions tabs.
The standing-approvals card is windowed one level deeper: its
per-token allowance lookups happen inside the fetch, so the window
bounds which tokens are checked, and "Check N more tokens" widens the
scan itself.

Two data-layer guards ride along: the Claims page's on-chain
position walk gains the same fail-loud two-thousand-position ceiling
the positions pages already had (it previously walked without limit),
and the Rate Desk order book's chain-first read now refuses to
hydrate a pair bucket past six hundred offers, failing over to the
market-scoped, capped indexer copy instead — so a spammed pair
degrades honestly rather than fetching without bound. The remaining
indexer-side caps from the audit (PAG-007/009/010/011) land in a
separate indexer PR.

Refs #1247.

## Thread — indexer: the last four unbounded routes get honest caps (PR #TBD)

The #1247 pagination audit's second batch closes the four indexer
routes that could still scan or return without bound. Each one now
serves a fixed ceiling and says so — every response carries a
truncation flag, so a client can tell "this is everything" from "depth
was dropped", the same shape the claim-candidates route shipped with.

What changed, per route: the legacy claimables read now serves the two
hundred newest terminal loans instead of a wallet's entire terminal
history (the defi Claim Center that consumes it layers its own
on-chain verification, so the cap only bounds discovery). Market
discovery serves the two hundred deepest markets, deepest first — the
distinct pair/tenor space is spammable with dust offers, so real
markets stay reachable while fabricated ones fall off the tail. The
executed-rate candle history, whose "all" range previously had no
bound at all, now scans the newest ten thousand fills — a truncated
chart loses its oldest candles, never recent ones. And the signed
order book, which already capped each side at its hundred best-priced
rows, now admits when it dropped depth instead of truncating silently.

The signed book also gains a wallet-scoped read, and the Rate Desk's
open-orders panel uses it: a maker's own resting orders are now
fetched scoped to their wallet, so an off-market order that better-
priced depth pushed out of the public window is still visible and
cancellable by its owner — previously it simply vanished from the
desk while remaining live and fillable.

Review hardening from the same change: the Rate Desk chart now shows
a "showing the most recent fills only" note when the server clipped a
long history, instead of rendering the chart as complete — and a
clipped series never draws a half-counted oldest candle (the boundary
candle the cut passed through is dropped, not shown with wrong
numbers). The claimables window ranks by when a loan actually went
terminal (a later ownership transfer can't shuffle it), its database
work is bounded to the requesting wallet's own rows, and the
already-claimed lookups are exact over the kept window. The
wallet-scoped book read is served by dedicated database indexes so it
never walks other makers' depth, and it carries a higher ceiling than
the public ladder (five hundred per side versus one hundred) so a
maker can always reach their own orders to cancel them — with the
clipped-set disclosure still shown in the rare case beyond that.
Bounding the market-discovery aggregation itself (not just its
response) is tracked separately.

Refs #1247.

## alpha02 Claim Center — "Claim everything at once" (PR #<n>)

The Claim Center gains a one-signature Claim-All CTA (#1268 / E-10), the
frontend half of the on-chain `MulticallFacet.multicall` batching shipped
in #1212. When two or more payouts are ready, the user can collect them
all in a single wallet signature instead of one transaction per claim.

The batch spans the four data-ready payout types: lender and borrower
loan/rental proceeds, pending interaction rewards, and free
(unencumbered) vault VPFI. Each payout is shown for individual
include/exclude before signing. Withdrawing parked vault VPFI is opt-in
and off by default — that balance backs the fee-discount tier, so pulling
it lowers the tier, and quietly draining it would be a footgun.

Honesty is preserved throughout: every batched item is best-effort
(`allowFailure`), so a payout another party finalizes between preview and
signing is skipped rather than aborting the batch, and the rest still
execute; the per-item outcome is surfaced by re-deriving eligibility
after the receipt, so claimed items drop off and skipped ones remain
listed to claim on their own. The selection is capped at the on-chain
batch bound (30). The batch can include the interaction-rewards claim, so
a live, fail-closed sanctions re-read gates submission — matching the
standalone rewards button. The card only appears once the claimables list
has settled and only for two or more batchable payouts, so it never
advertises a partial loan set that is still loading.

Lender-intent capital and payroll salary are a documented follow-up — no
alpha02 read surface exists for them yet.

Closes #1268.

## Thread — market discovery is now pre-computed, not aggregated per request (PR #TBD)

The market list behind the Rate Desk's pair and tenor picker used to
be computed from scratch on every request: the indexer grouped every
active offer and signed order on the chain into markets, ranked them,
and only then clipped to the two hundred deepest. The response was
already capped, but the work wasn't — a maker fabricating thousands
of dust markets could keep every discovery request expensive, the
resource-exhaustion path the pagination audit flagged and the
previous release consciously deferred.

Discovery now reads a summary table the indexer maintains as data
changes: each ingest pass recomputes the summary only for markets its
window actually touched — new or changed offers, signed-order
lifecycle flips, and orders whose time limits lapsed during the
window — and posting a gasless signed order updates its market's row
immediately, so a brand-new signed-only market is discoverable the
moment it's posted. Serving the list is a single indexed read with no
aggregation at all, and every number is recomputed exactly from the
source rows whenever a market is refreshed, so the summary can't
drift from reality through counting mistakes.

One freshness nuance: a market whose only order quietly expires by
clock (with no other activity anywhere) leaves the list on the next
ingest cycle for its chain rather than the very next request. The
indexer round-robins one chain per minute, so that lag is a few
minutes on today's multi-chain deploy — the same order of freshness
the desk's own polling already works at.

The deploy includes a one-time backfill so the list is fully
populated the moment the new code serves it.

Closes #1270.

## Indexer — project HF-liquidation terminal status (#1293)

Fixes a latent indexing bug: a loan closed by an HF-based liquidation was
left showing as **active** in the off-chain index forever, even though the
chain had defaulted it.

The two HF-liquidation close-outs (`HFLiquidationTriggered` — full and
split terminal — and the governance-gated `LiquidationDiscounted`) close a
loan to Defaulted on-chain but emit only their own event, with no generic
"defaulted" companion the indexer was watching for. The indexer had no
handler for them, so the indexed loan status never advanced — the
"every loan stuck active" class of bug. Any surface reading the indexed
status (active-loan counts, position lists) over-counted until a client
re-checked the chain.

The indexer now flips such a loan to defaulted the moment it sees the
liquidation event (idempotent on a re-scan, and it clears any stale
collateral-sale listing the same way the other terminal paths do). The
event-coverage guardrail is updated to treat these as handled rather than
relying on the incorrect "a companion event covers it" note.

This also switches on the in-app notification center's HF-liquidation
alerts: those rows were deliberately held back until the index reflected
the terminal state (so a "your loan was liquidated" notice could never
deep-link to a loan the app still showed as live) — with the projection in
place they now fire on a real HF liquidation, no notification-side change
needed.

Closes #1293.

## Thread — RL-3: post-claimability reward claim horizon (PR #TBD)

Third ratified delta of the recycling loop-closure design. Once
governance sets the bounded horizon knob (default 365 days, never below
180; dark until set), a reward that has stayed claimable for a full
horizon-plus-notice of accrued time becomes sweepable into the recycle
bucket by a permissionless keeper call — closing the unbounded liability
tail of dormant claimants the design flagged, with the dYdX epoch-sweep
precedent.

Expiry is measured in executable-elapsed time, never wall-clock. The
platform keeps, per reward entry, an accumulator of time during which
the reward was provably claimable. It starts on the first sweep touch
that observes the entry claim-executable, and each later interval
between two touches is credited only if the entry was claim-executable
at both ends and the gap is short enough to trust as continuous (a fixed
max-observation-gap bound). An entry can be removed only once its
accumulator reaches the full horizon + 90-day notice. "Claim-executable"
means the amount a claim would really pay (fresh capped to remaining
pool capacity, plus recycled) is non-zero, covered by local funding, and
the owner unsanctioned.

This is a genuine soundness guarantee up to the sampling resolution, not
best-effort: no outage longer than the max observation gap (observed or
not), and no observed outage of any length, is ever credited — the
earlier wall-clock design credited any outage the moment funding
returned, if no keeper touched the entry during it. The one residual is
a sub-max-gap unobserved outage that starts and ends between two
executable touches: the sweep sees both endpoints executable and credits
it, bounded by the max gap — so the max gap is the sampling resolution,
and a tighter gap tightens the guarantee at the cost of a denser
heartbeat. The cost is a keeper heartbeat: an entry only ever expires if
keepers observed it claim-executable throughout with no gap over the
bound; otherwise it simply never reaps, a safe failure mode that errs
toward not-reaping. A non-executable touch also RECORDS the block, so an
outage a keeper actually observed is dropped on recovery regardless of
length. A sanctioned owner cannot claim, so their entries
never accrue and can never be swept while flagged (a delist resumes
accrual — freeze, not seize). A horizon reconfiguration — dark reset or any retune — caps the
accumulator back to the horizon threshold on the next touch, so the full
90-day notice must be re-earned under the new configuration; an
already-due entry is never reaped without a fresh funded notice after
governance changes the rules. A claim landing any time before removal
always wins.

The lifecycle is fully observable: reward-entry ids are enumerable per
user, and the accumulator start, the entry into the final-notice window,
and the removal each emit a public per-entry signal (the notification
pipeline schedules the free pre-expiry notice from indexed events
alone). An entry whose fresh share cannot be credited at removal — the fresh
budget fully exhausted, or no recycle-bucket backing room — is deferred,
never processed with its value silently burned; a batch draws fresh
capacity (against both the pool cap and the bucket's backing room) per
entry, so it can never terminalise several entries against one remaining
sliver, and it can never revert on the bucket-backing invariant and
poison the whole permissionless batch. Every horizon reconfiguration
advances a strictly-monotonic epoch, so even two reconfigurations in the
same block are distinguishable and an entry is never measured against a
stale epoch that would skip its fresh notice. (The mirror-chain
remitted-recycled bucket-credit accounting is tracked separately as a
Phase-B′ follow-up, #1331 — it is a benign ledger-label gap, not a fund
movement, and RL-3 is dark by default.)

Removal uses the ratified split signals riding the governor's PR-3c
machinery: the fresh-funded share genuinely leaves the fresh budget
(consumes the pool cap) and credits the bucket as ExpiredReward
absorption; the recycled-funded share never left the bucket and releases
its commitment with zero new credit — dormant recycled rewards can never
inflate the absorption average. The claim-center countdown view exposes
each entry's accumulator start and a forward estimate of the earliest
removal (assuming continuous claimability from now). It is a
CONSERVATIVE estimate that errs optimistic — it never reports a removal
LATER than the contract enforces, so it only ever urges the claimant to
act sooner. It folds in the interval a sweep-now would credit, but only
while the entry is genuinely claim-executable, mirroring the sweep's
funding gate (owner unsanctioned, protocol unpaused, this entry's
post-cap share payable, and the balance covering the claimant's FULL
aggregate claim). It deliberately does NOT mirror the recycle-bucket
backing check that gates the final all-or-nothing reap: a backing
shortfall can defer the actual removal a little past the view's
estimate, which is safe UX (the claimant can still claim right up to the
reap). A processed (claimed/expired) entry carries no countdown.
The final-notice and reconfiguration re-notice signals are timed from
the true crossing, not the sweep timestamp; the pre-expiry notice rides
the
free in-app notification channel per the design (paid push may only be
additional). The governor design's "released only by forfeit — never by
time" sentence gains its ratified superseding note, and functional spec
§4 gains the claim-horizon rules. Closes #1305.

## Interaction-rewards read-only lens facet (EIP-170 headroom)

The read-only view/getter surface of the interaction-rewards system —
`previewInteractionRewards`, `getInteractionSnapshot`,
`getInteractionClaimability`, `getUserRewardEntries`, the pool/day/cap
getters, and the rest of the 14 pure/view functions — was carved out of
`InteractionRewardsFacet` into a new `InteractionRewardsLensFacet`.

No behaviour changes: the functions moved verbatim and route to the same
selectors from the same Diamond address, so every caller (frontend,
indexer, cross-facet reads) sees an identical surface. The split is
purely structural — it drops `InteractionRewardsFacet` from the EIP-170
ceiling (~24.6KB) back to ~17.2KB, restoring generous bytecode headroom
so the claim/sweep surface can keep growing (e.g. the recycling
loop-closure work) without being squeezed against the 24,576-byte limit.
The lens facet itself is ~5.3KB.

## RL-4 — Recycled-stream allocation register (dormant keeper carve)

The recycling governor gained its allocation register: at each day
finalization on the canonical chain, the platform can now carve a
bounded keeper-incentive share out of that day's recycled margin. The
register ships **dormant** — the keeper weight defaults to zero, and
until governance sets it, day finalization behaves exactly as before.

When armed, the split is doubly bounded. It never exceeds the day's
realized margin (the trailing absorption average times the margin
weight actually stamped for that day), and it never draws the recycle
bucket below a forward reserve of seven days of the trailing average —
so a register split can never defund near-term recycled reward budgets.
The keeper share is earmarked within the recycle bucket (a keeper-budget
ledger) rather than moved out of it: the bucket's custody total is
unchanged at split time, so the protocol's standing backing invariant
keeps the keeper budget fully backed, and the earmark is netted out of
the fundable balance so a carved share can never be re-sized into a later
day's reward budget (no token transfer at split time), the weight is
capped at
half, and every split emits a public event so indexers can replay the
register from events alone. Spend paths for the accumulated keeper
budget arrive with a later ratified stage.

## alpha02 — full UI-string extraction into the translatable catalog (#1329)

Switching the alpha02 display language used to leave large patches of
the interface in English even for a fully-translated locale. The cause
was not a translation gap but an extraction gap: 313 user-visible
strings across 34 components were hardcoded in JSX instead of routed
through the `copy.*` catalog, so they had no key in the English
template and no locale could ever translate them. A live walk only
surfaces the states you happen to click through; a static sweep of
`apps/alpha02/src` found all of them at once, including error
boundaries, empty states, and failure paths.

Every genuine UI literal — page titles and ledes, form labels and
hints, confirmation-receipt rows, the Help FAQ, filter controls,
flow step labels, empty/loading/error copy — now reads from
`content/copy.ts`, growing the catalog from 774 to 1,155 string
leaves. Strings that are deliberately English are left alone:
on-chain event names compared in logic, keyboard codes, the brand
name, console diagnostics, and parameterised templates that embed a
live value mid-sentence (those are recorded as follow-up work for the
catalog's interpolation support). Legal surfaces (terms, privacy,
whitepaper) stay English by design — that is the www surface and the
#1314 posture decision.

Because the same regression re-opens with every new component, a
guardrail — `scripts/check-hardcoded-strings.mjs`, wired into the
alpha02 `typecheck` lane — now fails CI when a user-visible string
bypasses the catalog, with a tight allowlist for the deliberate
English literals. The newly-extracted keys ship English-only for now
and fall back to English in every locale until translated (tracked in
#1323 alongside the remaining locale bundles).

Closes #1329.

## Thread — Notification tariff joins the recycle loop (Layer 0) (PR #<n>)

The per-loan-side notification fee — billed in VPFI when the off-chain
watcher fires the first paid-tier notification for a loan side — is now
the first live non-forfeit absorption channel of the VPFI recycling
loop. Two changes land together (recycling completion plan milestone M1,
governor design §4.1 "Layer 0"):

**Flat native-VPFI tariff.** The fee is now a flat quantity denominated
directly in VPFI, not a numeraire (USD-style) figure converted through
the ETH/numeraire oracle and the fixed VPFI-per-ETH peg. The stored
value IS the VPFI amount billed. The launch-era "convert a fiat price
into VPFI at a fixed peg" path is retired here (the conversion class the
tokenomics spec forbids at launch), replaced by a governance-tunable
flat tariff. The default is 0.5 VPFI, chosen to preserve the ≈0.5-VPFI
bill the old conversion produced at typical prices, so users see no
change in what they pay. Because the tariff is now a VPFI quantity with
no currency linkage, it is also removed from the atomic numeraire
rotation setter — a numeraire change (e.g. USD→EUR) would otherwise
overwrite the VPFI amount with a fiat-denominated value. The tariff is
tuned only through its own setter.

**Custody re-route into the recycle bucket.** Previously the tariff
moved straight from the user's vault to the treasury and left the
recycling loop entirely. It now moves into protocol (Diamond) custody
and credits the recycle bucket under the `NotificationFee` source —
extending the interaction-reward program's runway rather than being
skimmed to treasury. The same vault debit now also runs the mandatory
discount-tier restamp that every other VPFI-outflow path runs, closing a
long-standing gap where billing this fee left a stale fee-discount stamp
on VPFI that had already left the user's vault.

**Upgrade safety.** Because the stored notification-fee value changed
meaning (numeraire units → VPFI wei) and `setNumeraire` dropped an
argument (an 8→7-argument selector change), the testnet in-place refresh
script now runs a one-time migration on the first refresh that carries
this change: it removes the retired 8-argument `setNumeraire` selector
(so a stale, still-routed copy can't clobber the new flat tariff on a
numeraire rotation) and resets the stored notification fee to zero (so
any pre-existing numeraire-denominated override can't be silently
reinterpreted as a VPFI amount). Mainnet rollouts are always fresh
deploys, where neither artifact exists. The user-facing Push-billing fee
disclosure (app + website, all locales) is updated from the old
"$2 USD-equivalent" wording to the flat 0.5 VPFI tariff.

Everything ships dark alongside the rest of the recycling stack — the
credit is real bookkeeping, but no interaction-reward emissions are
running yet, so nothing is economically live until the activation
ceremonies (plan milestone M7). Closes #1346.

## Thread — Per-party Full VPFI fee-entitlement tariff (M2 PR-5a/5b) (PR #<n>)

Builds the second, opt-in half of the VPFI fee package the spec supersession
(#1350) described: the **Full tariff**. Where the HoldOnly path (#1352) simply
reduces a consenting tier-holder's Loan-Initiation Fee, Full lets a party
additionally *absorb* a fee-native VPFI tariff `C*` from their own vault into
the recycle bucket at loan origination, in exchange for a larger own-side fee
discount. It is **per-party and double-absorbing**: the borrower and the lender
each opt in independently, and each opting-in party pays one `C*`, so a loan
where both sides opt in sends `2 × C*` to the bucket.

`C*` is priced from the **list** Loan-Initiation Fee, not a token price:
`C* = baseLif_list_numeraire × (durationDays / 365) × K`, with `K` a governable
VPFI-per-list-LIF-year policy constant (default 5). It is never a
`feeUSD / vpfiPrice` conversion, so it carries no peg or market-price surface.

**Authorization is party-scoped and unforgeable.** The offer *creator* authorizes
their own Full opt-in before acceptance (a new creator-only, pre-acceptance
setter that writes the authorization onto the offer — the same shape as the
per-offer keeper-enable, deliberately kept off the ~60 offer-construction sites);
the *acceptor* authorizes theirs inside the signed accept terms. The accept path
then maps creator/acceptor to borrower/lender by offer side, so a borrower or a
matcher can never drain the counterparty's vault. Every Full authorization must
carry a mandatory absolute `maxCStar` ceiling: if the quoted tariff exceeds it
the accept reverts, unless the party also permitted a silent downgrade to the
non-Full path. A matcher/keeper fill (which carries no acceptor-signed terms)
always resolves the acceptor side as non-Full.

The whole feature ships **dark** behind a single master switch. While the switch
is off **and no party opted into Full**, the accept path skips the tariff
entirely — nothing is charged, nothing is stamped — which also keeps the tariff
facet off the routing surface of the many minimal-cut test/integration diamonds
that never enable it. A Full opt-in presented **while the switch is off** still
routes through the resolver so it **fails closed** (the accept reverts) — or
downgrades to non-Full if the party's signed terms permitted it — rather than
silently proceeding (the kill-switch-first rule). When the switch is
turned on, every subsequent reward-eligible ERC-20 origination stamps its
per-loan fee-entitlement record (the resolved per-party modes, each party's
absorbed tariff, and the notional `C*` a later loan-side reward cap is defined
from) — the "cStar-from-genesis" posture, where stamping begins the moment the
tariff goes live. Rentals and lender-sale-vehicle accepts bear no tariff (they
pay no Loan-Initiation Fee). A confirmed borrower Full opt-in additionally bumps
the borrower's own-side Loan-Initiation-Fee discount by 10% (clamped at the
uniform 50% ceiling), resolved in lockstep with the tariff charge so the
discount is never granted without the tariff being taken.

The frontend accept-signing hooks (defi + alpha02) were extended to sign the new
accept-terms fields (defaulted to the non-Full path — the Full-tariff accept UI
and tariff-quote surface ship in PR-8, #1355). The lender-side Full discount at
**settlement** (the yield-fee `+10%`) and the loan-side reward cap that consumes
the stamped `C*` are separate later cards (PR-6 #1354 / PR-5c #1353). Closes #1347.

## Thread — the days that predate the announcement (#1349 M5)

When the daily recycling account started announcing its full composition, the announcement's shape changed. Days finalised before that upgrade were announced under the older shape and simply cannot supply two of the figures — how much fresh issuance was actually drawn, and whether the platform had committed to the day at all. The consumer refuses those days rather than reading the absent figures as zero, which would invent finalised, uncommitted, zero-emission days that look exactly like real ones.

This adds **the place those days will be kept**, and everything needed to read, back up and restore it — the records themselves, their registration with the recovery tool, and the read surface that serves them. The pass that fills them is not here; it is described further down and lands separately.

**Keeping them apart from the announced days is the whole design, not tidiness.** Every other record in this area is a fold of the announcement stream, so rebuilding the platform's off-chain state from scratch reproduces it exactly. These are different: the recomputation reads a value that a role handover can legitimately overwrite for a day already closed. Once that happens, asking again returns a different answer and the original is gone — those days have no announcement to fall back on. So they are backed up and restored, never regenerated, and the restore runbook now says so explicitly next to the list of records it rebuilds instead.

A record cannot be half-rebuilt, and the treatment is decided per record, so keeping both kinds in one place would have guaranteed one of them the wrong handling during exactly the incident the distinction exists for.

A second benefit falls out of the separation. Where a day is described by both sources, the announcement wins — it is immutable, while the recomputation can drift. With two separate records that preference is a property of **how the read looks things up**, which nothing can violate. Had they shared one record it would have been a rule about which write happened last, which is the kind of guarantee that holds until it doesn't.

**Every recomputed day carries whether the platform had committed to it.** The recomputation returns figures and no such marker, and the days it covers are mostly from the period before any commitment was made — so storing the figures bare would republish estimates as though they were emissions, in the flattering direction. That is precisely what the marker on the announcement exists to prevent. The pass resolves the commitment start once and stamps every row, and it **refuses to write anything at all** if it cannot establish that — a backfill that guesses is worse than no backfill. There is a documented trap here that it honours: the "not yet committed" state is recorded as a zero, and reading that as "everything is committed" would mark the entire pre-commitment history as real emission.

Two figures are stored as *unknown* rather than zero, because the recomputation genuinely does not return them. A zero margin is a real and different thing, and this surface has been caught by that ambiguity twice already.

**The pass that fills these records is deliberately not here.** It was written, reviewed across three rounds, and then split out — because each round fixed one symptom of the same underlying choice. To protect a capture taken while its inputs were still intact, the pass refused to overwrite an existing one; that made every capture permanent, and therefore made every *wrong* capture permanent too. Taking the newest chain state records data a reorganisation can take back; taking only settled state records a total that a just-delivered cross-chain report is about to raise. Pointing it at the wrong deployment succeeds quietly and writes rows that then block the right one. Three hazards, one cause, and moving between them is not progress.

That needs captures that can be superseded — a candidate, and an explicit step that makes one the record — rather than more guards around an immutable write. It is designed as a whole in its own change.

**What ships here is useful and honest without it.** The records exist, they are declared for backup and registered with the recovery tool, and the read surface serves an empty pre-cutover history — which is exactly the truthful answer until a capture exists. Nothing publishes invented days: the coverage boundary begins where observation began. The check that requires every stored record to declare who writes it now accepts an explicitly *pending* writer naming its tracking item, and fails if that stops pointing at something real — so "nothing writes this yet" stays a decision rather than becoming an oversight.

One consequence carried over unfixed and recorded on that item: the confirmation an operator gives before capturing only proves a backup ran *beforehand*, when the table was empty. A second backup after the rows land must be required before any role handover, or their only copy sits in one database through the gap until the next nightly run.

**One check had to learn a new shape.** The repository requires every stored record to declare how it should be treated on restore, and it finds them by looking for writes inside the services. This one is written by an operator pass, so it would have been flagged as orphaned forever — and a check that always warns is a check people stop reading. It now accepts an explicit declaration naming the writer and why it is not a service, and fails if that declaration points at a script that does not exist.

## Thread — the recycling programme's account, in public (#1349 M5)

The platform has been keeping a daily account of where each reward pool came from and how much of it was drawn. Until now it kept it privately: the contracts announced it, and a recent change recorded it into a queryable history, but nobody outside could look. This puts it on the public analytics page.

**The interesting work was not displaying the numbers — it was not displaying the ones the platform cannot stand behind.** The read surface underneath spends considerable effort refusing to publish figures it cannot justify, and all of that is undone if a page renders a refusal as a zero or a dash. So:

A day that has not closed yet has no pool, and shows as not-yet-closed rather than as a pool of nothing. A day the programme had scheduled but not committed to is marked an estimate, and its drawn column stays **empty** — printing a zero there would assert a commitment that was never made. A cross-chain total still collecting reports likewise stays blank rather than showing a partial sum as if it were final. When the longevity estimate cannot be calculated honestly, the page prints **why** — because a dash reads as *zero runway*, which is the opposite of *we cannot say*. And when the whole account is unreachable, nothing is shown at all, since a zeroed account looks exactly like a quiet programme.

The subtlest of these is a figure the platform *does* publish but the page must still not state. For a day in progress, absorption on the platform's own chain is known the moment it happens, while absorption on other reward chains is not and cannot be — another chain only reports a day once its own clock has passed it. The underlying account publishes both, because anything reading it programmatically can also see whether the day has closed and knows what it is holding. A person reading a table cannot, and to them a zero in that column says no other chain absorbed anything. So the page shows the live figure and leaves the other blank until the day closes. Where what is safe to publish and what is safe to display come apart, the page takes the stricter of the two.

The same reasoning applies to the page's own explanatory notes. A note reconciling two figures is shown only when those figures actually differ, rather than standing permanently on the page — a caveat pointing at a discrepancy the reader cannot find is one that teaches them to discount the caveats that matter.

Two smaller versions of the same mistake were fixed alongside. An amount too small to survive the page's chosen precision used to print as **0**; on an accounting page that is not a rounding artefact but a false statement, so it now says it is below that precision instead. And the self-funded share used to round to the nearest tenth, which let a day that still drew a fresh floor display as **100% self-funded** — while the longevity figure beside it, computed from the exact value, disagreed. It now rounds down, so the error can only ever understate how self-funding the programme was.

The page also fails narrowly. If the underlying account returns something that is not a number at all — a corrupt record, a tampered cache — the page shows its own "cannot say" state rather than letting the failure take down the rest of the analytics screen with it, and it does not quietly substitute a zero for the value it rejected. A detected corruption turned into a confident figure is worse than an admitted gap.

Each of those is pinned by a test, and each test was checked by making the page do the wrong thing and confirming the test noticed — in both directions, so a rule cannot pass by being applied too broadly either. One check that *survived* being broken turned out to be guarding a condition that cannot occur, and was removed rather than left to look like protection.

**The wording was written against the release checklist rather than tidied afterwards.** That checklist exists because, under the interpretive release governing this area, what the issuer says is the dominant factor — so the constraint is on vocabulary, not just on substance. The page describes programme longevity, which the checklist expressly permits, and never a yield, a rate, a return, or a price. It makes no claim about what any holder receives, because it is a programme-level account and says nothing about individuals. It offers nothing to buy and implies no market. And it describes what happened rather than what anyone decided — no "we allocate", no "the team determines".

One deliberate omission: the page does not compute anything of its own from the published figures. Where the underlying account declines to state a total, the page declines too, rather than adding up the parts itself and presenting the result as though it were the same thing.

## Thread — the recycling day series gets a reader (M5, #1218 / #1349)

The contracts have been announcing the recycling programme's daily accounts for a while now, and nothing has been listening. Two changes shipped the announcement itself — the reads that expose each day's composition, and the widening of the day-close signal so the fresh drawdown and the arming status travel with it. This adds the consumer: the platform now records that stream into its own history and serves it back as a per-day series, which is what a public dashboard will read.

**Three things it deliberately refuses to do, each of which would have produced a wrong number rather than a missing one.**

A day that has not been finalised yet has no pool. It can still have absorption — value gets credited to a day long before the day closes — so the natural shape is a row with real absorption figures and nothing else. Reporting the missing pool as zero would make it indistinguishable from a genuine zero, which is the exact defect the earlier reads were changed to fix for the absorption term. Shipping it here in the same breath would have undone that, so an unfinalised day reports the pool as absent and reports the absorption it does have.

A day before the governor is armed is not a record of anything the platform committed to. Nothing reserves against those figures — they describe the schedule the programme is running, and the arming status was added to the day-close signal precisely so that a reader could tell the difference. The series keeps them, marks them estimates, and withholds the net-emission reading entirely. They are also kept out of the lifetime totals, which is the less obvious half: a running total has nowhere to carry a per-day qualifier, so an estimate folded into one stops being distinguishable from a commitment, and it overstates in the flattering direction.

And the cross-chain absorption figure is assembled with one term deliberately dropped. The day-close report fires for every chain that reports, **including the canonical chain reporting itself** — but the contracts fold that report into the cross-chain total only for other chains, because the canonical chain's own credit already sits in its local series. Summing every report and adding the local series counts the canonical chain twice. It is worth being precise about the direction: it inflates exactly the cross-chain activity the recycling programme exists to demonstrate, on the surface built to demonstrate it. The two terms are therefore stored separately rather than pre-summed, so the exclusion is visible at rest instead of buried in the arithmetic that produced a single number.

**Review found three more ways the surface could have published a plausible wrong number, and all three shared a shape.** Each was a figure that was *true of part of the picture* being labelled as though it described the whole.

The cross-chain reports for a day arrive one at a time, so before a day is finalised the combined absorption is whatever happens to have landed — a partial figure under a global label. The combined figure is now withheld until the day is final, with both components published throughout. That single rule turned out to make the surface correct on a mirror deployment too, without asking which chain currently holds the coordinating role: a mirror never finalises a day, so it never publishes a global figure and simply reports the local absorption it genuinely sees. Asking about the role instead would have erased a deployment's history the moment it handed that role over — a mistake corrected once already in the reads this consumes.

The dense day-by-day window started wherever the requested range began, inventing quiet days in front of the first day ever observed. On a consumer deployed after the programme has been running, that is most of the chart. It now starts at real coverage and reports where that boundary is.

And a lifetime figure — the runway estimate — was derived from a window that shrank with whatever range the caller asked to see, so the same underlying state answered differently depending on the shape of the question. A cumulative that moves with the query is reporting the query.

**One gap was invisible from inside the change.** The chain scan shares a single cursor across every handler, so on a deployment that has been running, that cursor is already past every block this series cares about — wiring the ingest in would have started the history at "whenever this shipped" while looking complete. The events had announced themselves; nobody was listening yet. The platform's unified activity feed already holds every decoded event, so the series is now rebuilt from it once per chain, and that replay is what sets the honest coverage boundary above.

**The fix for that gap was itself incomplete, and the way it failed is worth recording.** The rebuild was placed inside the ingest step and described as running on every tick. It does — but the caller returns early when there is nothing to scan, and that early return happens before the ingest step is reached. So on precisely the deployment the rebuild exists for, one already caught up, it never ran. The claim was true of the function and false of the path to it.

The repair is not a second call on the other branch. Two call sites that have to be kept in step is the defect itself — the older loop-closure rebuild had exactly that shape, which is why adding a sibling next to it looked right. Both now run at a single point ahead of every exit, so the next one added inherits the property instead of having to remember it.

A behavioural test could not have caught this: the tests invoke the ingest step directly and so skip the caller's control flow entirely. What guards it now is an assertion about the call graph — that every one-time rebuild is invoked before the first exit — which fails if either is moved back down, and which also checks that it is still looking at the right region of the file rather than passing against the whole function.

**One published figure was quietly a different metric from the protocol's own.** The runway estimate is defined against the recycling programme's smoothing window, which is a fixed seven days and deliberately not adjustable. The first version of this surface used thirty — a number I chose rather than looked up. Same name, different denominator, and it would also have delayed the point at which the programme reports itself self-funded. A dashboard figure that disagrees with the protocol's own is worse than no figure, because the disagreement is invisible to the reader.

The same window was also anchored on the newest row of any kind rather than the newest finalised day, so the moment the next day's first credit arrived the window slid forward and dropped its oldest day — a lifetime figure changing because a day *began*. It now anchors on the last finalised day.

**And the historical rebuild would have manufactured history for days it cannot account for.** Days finalised before the day-close signal was widened were announced under the older shape and simply have no fresh-drawdown or arming status to give. Reading the absent fields as zero and false would have stored them as finalised, unarmed days that drew nothing — fabricated history in the shape of real history, and it would have dragged the coverage boundary back over days this consumer genuinely cannot speak for. Those days are refused rather than coerced, which leaves them where the ratified cutover puts them: on the separate recomputing backfill. The test detects the old shape by which fields are present rather than by a block height, so it needs no operator-supplied cutover point.

**Two of the tests written for these fixes did not test what they claimed, and only a deliberate check caught it.** After each fix, the fix was reverted to confirm the new test failed for the right reason. Two survived their reverts. One used two identical days to prove a window-size rule — with identical days the mean is the same at any size, so it could never have failed. The other claimed to prove a one-time replay runs once, when the duplicate-suppression underneath made a repeated replay harmless either way; it now checks the behaviour that actually differs, which is that the replay does not go back for rows that arrive after it finishes. A test that passes for the wrong reason is worse than no test, because it stops anyone looking.

**A second notion of "day" now exists in the platform's own records, and the two must never be joined.** The loop-closure metric buckets by the calendar day value moved on — a deliberate choice, recorded when it shipped, because that metric wants the day tokens left custody on both sides of its ratio. This series buckets by the day a reward was *earned*, whose boundaries are set by the emissions launch and do not fall at midnight. Both are right for what they measure, and their indices are not comparable in either value or boundary; aligning them would pair unrelated buckets and produce a chart that looks entirely reasonable. The new records say so at the top, and the read surface publishes the programme's own day index without converting it to a calendar date — a conversion would make that surface a second authority on where a day begins.

**One structural decision worth recording, because it came from a guardrail rather than from design.** A check in this repository requires every stored table to declare how it should be treated if the platform's off-chain records ever have to be rebuilt, and the two classes get opposite treatment: rebuilt-from-scratch, or restored from backup. The new tables are purely derived from the chain, so they are rebuilt. But the days that predate the widened signal are not: they can only be recovered by asking the contracts to recompute them, and that recomputation reads a value a later role handover can legitimately overwrite. Those rows are, in restore terms, born off-chain — they must be preserved, never regenerated. A table cannot be half-rebuilt and the declaration is per-table, so keeping both kinds in one place would have guaranteed one of them the wrong treatment during exactly the incident the declaration exists for. The historical backfill therefore lands as its own records in its own change, and this one stays purely rebuildable. A pleasant side effect: "prefer the announced value where the two disagree" stops being a rule about write ordering and becomes a matter of which record is read first.

**The backfill is not shipped here, and its ordering requirement still stands.** Days finalised before the widened signal can only be recovered from the recomputing read, and that read can be invalidated by a role handover — so backfilling has to happen before any such handover, not whenever convenient. That constraint was already recorded when the signal was widened; it is repeated here so that "the consumer shipped" is not mistaken for "history is covered."

Follow-up: the public display surface.

## Thread — Fee-package spec supersession (M2 PR-1, docs-only) (PR #<n>)

Documents-only PR-1 of the M2 absorption-formula milestone (recycling
completion plan §M2; owner tariff decision D1 = the LIF·year dual-fee
package). It states the **intended** launch fee package across the
functional specs so later M2 code cards implement against a current
spec, not a superseded one. No behaviour changes here — the code still
runs the legacy rates; these edits describe where it is heading.

What the spec now says (intent, sourced from the ratified design docs,
never transcribed from code):

- **List fees freeze at `0.2%` Loan-Initiation Fee and `2%` yield fee**
  (double the legacy `0.1%` / `1%`), with a **grandfather resolver**: a
  fee-rate change must never reprice an already-open loan — each loan
  resolves its settlement fee from the rate in force at its origination,
  so a loan opened before the freeze keeps the legacy rate. (Pre-live,
  this relaxes to deployment sequencing: a fresh deploy simply starts at
  the new defaults.)
- **Two borrower fee modes replace the peg-custody VPFI path for new
  loans:** HoldOnly (tier discount as a direct reduction of the
  lending-asset fee — no VPFI moved) and Full (an optional per-party
  native-VPFI tariff paid into the recycle bucket for an extra own-side
  discount, capped). Loans already open on the legacy custody path are
  grandfathered.
- **The interaction-reward `500 VPFI/ETH` cap (#1008) gives way to a
  fee-linked loan-side cap plus the D1 share-of-pool cap**, cut over
  jointly — the share-of-pool rule never activates without the loan-side
  cap in force.
- The recycling governor design's older ETH·day tariff formula (option
  (a)) is marked **superseded** by the LIF·year package.

Supporting edits: `_CodeVsDocsAudit` records the three spec-ahead-of-code
divergences (each tagged as intentional, with the M2 code card that
closes it); the WebsiteReadme borrower-copy rules carry the
new-loan-model note and reaffirm the no-purchase-price / no-APR
discipline for the Full tariff. Closes #1350.

## Thread — Groundwork for the per-user daily reward cap (PR #<n>)

First slice of the new daily reward cap. It lays the foundation only: the
bookkeeping the cap will need, an admin knob to set its size, and the step at
day-close that records what that day's ceiling is. Nothing pays out differently
yet — no day uses the new cap until the reward cutover is switched on, which
remains blocked until the rest of the pieces are in place.

**What the cap will do, once live.** Today a day's reward budget is limited by a
rule tied to the price of ETH. That is being replaced by a straightforward
ceiling: on any one day, a single participant can take at most a set share of
that day's budget for their side of the market — a default of 20%, adjustable
between 0.5% and 50%. The point is to stop one very large participant absorbing
most of a day's rewards.

**Why it needs a durable record of what has already been paid.** A participant
may have several loans that finish at different times. If each one asked "how
much of today's ceiling is left?" without a shared record, each would see the
full ceiling and they would collectively blow past it. So the amount already
paid out for a given person, side, and day is written down permanently, and
counts payouts to the participant *and* amounts diverted to the treasury when a
reward is forfeited — a forfeit must not quietly open a second allowance.

**Two deliberate safety choices worth stating.**

Each day is explicitly stamped with which cap applies to it, rather than that
being inferred from the ceiling's value. A day can legitimately have a ceiling of
zero — a day with negligible or no emission — and if "zero ceiling" were read as
"the old rule applies", such a day would fall through to the *uncapped* path.
Days that close under the new regime without that stamp are treated as an error
rather than silently paid, and the stamp is written in the same step that turns
the old rule off so the two cannot drift apart.

The size knob refuses zero and is bounded at both ends. A zero share would stall
every claimant, and an unbounded one would defeat the cap's purpose entirely. A
stored zero therefore unambiguously means "never configured" and resolves to the
default, so a single mistyped setting cannot strand anyone.

A day's ceiling is fixed when that day closes. Adjusting the knob later changes
future days only — it can never retroactively reprice a day that has already
been settled.

Part of #1351. Umbrella: #1349.

## Thread — The calculation behind the per-user daily reward cap (PR #<n>)

Second slice of the new daily reward cap. The previous slice recorded what each
day's ceiling is; this one adds the calculation that actually shares a day's
rewards out under that ceiling. Still nothing pays differently — the new
calculation is not connected to any live payout path until the remaining slices
land, and no day uses the new regime until the reward cutover is switched on.

**One calculation, used by both payout routes.** Rewards can leave via two
routes: a participant claiming, or a sweep that redirects forfeited rewards to
the treasury. Both now go through the same piece of code. That is the whole
point of capping per participant-and-day rather than per loan — there is one
allowance, and two routes spending against it independently is exactly how a
single participant would end up taking more than their share.

**Why order doesn't matter.** A participant may have several loans finishing at
different times. Each settlement records what it actually paid out, so whichever
one settles first consumes allowance the later one then cannot re-spend. The
ceiling therefore holds no matter what order things settle in. What is
deliberately *not* promised is that loans settling at different times split the
day perfectly evenly — only that together they never exceed the ceiling.

**Running out of budget doesn't lose your rewards.** If the pool cannot cover a
day in full, that day pays nothing at all and stays pending, to be retried once
the pool refills. Paying part of a day and marking it done would have quietly
discarded the rest, because the current design records progress a whole day at a
time. Each funding source is checked against its own remainder rather than
against a single combined figure — the two sources are physically separate, so a
combined check could report "enough" while one of them was actually short.

**A day that hasn't closed yet is simply not ready.** Days that haven't been
finalized are left pending and retried later, not treated as an error. Only a
day that *has* closed but is missing its regime marker is refused outright,
because that combination should be impossible and quietly guessing would apply
the wrong limit.

**Reward that a loan's own limit refuses is accounted for.** When a loan's
lifetime limit turns some of a day's reward away, that amount is reported back
so the bookkeeping can be released. Nobody can ever draw it — the day has moved
on — so leaving it recorded as still-owed would shrink every future day's
available rewards for value that cannot exist. The separate case of a
participant hitting their own daily ceiling is deliberately *not* treated this
way: that reward stays in the pool and someone else can still receive it.

**Rounding never overshoots.** When a day is split between several of a
participant's loans, the leftover from rounding is handed to whichever loan has
the most room left. If none has room, the remainder is simply left in the pool
rather than forced onto a loan that has already hit its own separate limit. When
two loans have equally much room, the tie is settled by which reward is older —
not by the order the caller happened to list them in, so the same set of rewards
always splits the same way no matter who asks.

**The budget check counts what will actually be paid.** Because each side of the
split rounds on its own, the exact amounts drawn from each source can differ from
a single estimate by the smallest possible unit. The amounts are therefore worked
out in full first and the available budget checked against those, rather than
against an estimate — an "off by the smallest unit, absorbed somewhere
downstream" discrepancy is precisely the kind that becomes impossible to trace
later.

**Days that legitimately pay nothing still move forward.** A day where the
allowance is already used up, or where there is nothing to pay, is marked done so
the walk progresses. Only the "pool ran short" case stays pending. Conflating
those two would either lose rewards or leave a participant stuck retrying a day
that can never pay.

**A forfeited reward is not capped like a payout.** Each loan carries its own
lifetime limit on how much reward it can pay its participants. That limit
applies to money actually paid *out* to someone — it does not apply to a reward
that was forfeited and is being reclaimed, because reclaimed value is returned
to the pool rather than handed to a participant. Applying the payout limit to a
reclaim would have let an exhausted loan limit silently swallow reclaimable
funds, and because the day moves on regardless, they would never have been
recovered. Forfeits are still bounded by the per-participant daily ceiling, so
they can't be used to sidestep it.

**A loan's own limit is met from newly scheduled rewards first.** When a loan's
lifetime limit only permits part of a day's reward, the part that is paid comes
from the newly scheduled pool before any recycled reward is touched — the same
order the existing settlement path already uses. Sharing it proportionally
instead would have drawn down the recycled pot for reward that should have come
from elsewhere, and left the corresponding bookkeeping unreleased by exactly that
amount. The separate reduction that happens when a participant hits their own
daily ceiling is *not* treated this way: that one keeps whatever mix survived, so
a day whose ceiling binds tightly still draws on both sources.

**Reclaiming a forfeited reward doesn't wait on spare funds.** Reclaimed reward
that was originally funded from the recycled pot never actually leaves that pot —
reclaiming it just cancels the earmark. So it is no longer held up when the
recycled pot has nothing spare to pay out with; otherwise a reclaim could sit
stuck behind unrelated payout funding it never needed. Reclaimed reward funded
from newly scheduled rewards *is* still counted, because that genuinely moves.

**Rounding always favours the same side.** Wherever a reward has to be divided
between its two funding sources, the recycled share rounds down and the newly
scheduled share absorbs the remainder. That direction is applied uniformly, so
the recycled pot is never drawn on for a fraction that should have stayed in it.

**Rewards say where they came from.** A day's reward pool is funded from two
sources: newly scheduled rewards, and rewards recycled from fees already
collected. The calculation now reports each payout broken down by source rather
than as a single number, in the same proportion as the day's pool was funded.
That distinction is not cosmetic — the two sources are settled differently
downstream, and on the treasury side they are not even the same kind of event:
one is genuine new absorption, the other merely releases a reservation on money
that never moved. Reporting a flat total would have made those impossible to
tell apart.

Finally, the calculation refuses to run on a mismatched request — one mixing
different participants or sides, or naming a day a reward doesn't cover — rather
than trusting its caller, since two separate callers construct those requests.
It accepts a reward whose loan simply *ended* (defaulted or was liquidated)
without being formally wound down, because those are exactly the rewards that
get redirected to the treasury: refusing them would have left them stuck
forever, never paid and never redirected.

Part of #1351. Umbrella: #1349.

## One reward-pricing calculation, and what happens when the pool truly runs out (#1351 slice 2d-0)

Foundation slice of the per-user daily reward cap work. Nothing pays
differently on any current deployment — the new daily-cap regime is still
switched off everywhere, and the day-by-day payment walk this slice prepares
for has no live callers yet. What changes is *how the code is shaped* and
*what is specified to happen at the end of the reward programme*.

**One calculation, one place that records.** Before this slice, five separate
places each computed "what is this reward entry worth", and each was
independently responsible for agreeing with the others. A previous attempt to
build the payment walk on top of that (the parked slice 2c) showed exactly
where that goes wrong: review rounds kept finding new disagreements between
the copies, including one that could have left a claim permanently stuck.
Now a single read-only calculation prices an entry — the settlement path, the
expiry sweep, the claim preview, and the funding-need check all read it — and
a single place records the result. A preview can no longer promise what a
claim would not pay, because they are the same arithmetic by construction
rather than by discipline.

**The expiry countdown now tests what a claim would actually pay.** The gate
that decides whether an entry's expiry clock is running previously looked at
the entry's raw face value. It now looks at the same capped figure the claim
itself would pay, so a reward that a cap has already turned away can no
longer keep an expiry clock running on value no claim will ever move. (The
value reclaimed *at* expiry is deliberately still the uncapped figure — an
expired reward is returned to the pool, not paid to a person, so the
paid-to-a-person cap does not apply to it.)

**Running out of newly scheduled rewards is now an ending, not a wait.** The
day calculation distinguishes its two funding sources when one is short.
Rewards recycled from collected fees live in a pot that refills over time —
if that pot is short, the day still waits and is retried later, exactly as
before. Newly scheduled rewards, however, come from a fixed lifetime
schedule that can only ever go down. Under the previous rule a day short on
scheduled rewards also waited — but that wait could never end, leaving the
claimant retrying forever and the rest of their claim stuck behind the
unpayable day. Now such a day pays out exactly what the schedule still
holds, settles, and writes off the remainder that no future ever funds —
with the claimant's own payout funded first, before any forfeited amount is
redirected to the treasury. This supersedes the "a short day always stays
pending" wording from the earlier day-calculation slice: that remains true
for the refillable pot, and is deliberately no longer true for the one that
cannot refill.

Each side of that rule carries a test that fails if the other side's
behaviour leaks across, so the distinction cannot erode silently.

Part of #1351. Umbrella: #1349.

## Claiming rewards under the new per-participant daily cap (#1351, re-landed)

Connects the day-by-day cap calculation to the actual claim, so a participant
collecting rewards is bounded by their daily ceiling. Nothing pays differently
yet — the new regime governs only days after the reward changeover, which has
not been switched on anywhere. This is the re-landing of the previously parked
claim-routing slice, rebuilt on the single-pricing-core foundation; the
differences from the parked version are noted below.

**Only the days that need it are worked through one at a time.** A reward
covering a long stretch of days is still settled in a single step for the days
that predate the changeover; only the days that fall under the new cap are
handled individually. That distinction is not just an optimisation: the daily
ceiling depends on how much a participant has already drawn on that day across
*all* their loans, so it cannot be derived from a whole-period shortcut. Days
before the changeover have no such interaction and keep their existing, cheaper
treatment.

**Progress is recorded in one place, not two.** The parked version kept a
separate "the old-style part has been settled" marker alongside the day
counter, and the two could disagree — which is exactly how its review found a
reward that could become permanently uncollectable. Now the day counter itself
is the record: its first write *is* the old-style settlement, so "settled" and
"where the day walk stands" are one fact that cannot fall out of step. This is
the structural fix the redesign was reversed for, and it required no new
storage at all.

**A long history may need more than one claim.** Working days individually is
bounded per transaction, so a participant with a very long unclaimed stretch
finishes it across a few claims rather than in one oversized one. Each claim
pays and records the days it actually covered, so nothing is recomputed or
paid twice, and stopping partway is safe.

**Running short of funds pauses or ends, depending on the pot.** Per the rule
established in the foundation slice: a day short on the refillable recycled pot
is left untouched and retried later; a day short on the fixed lifetime schedule
pays what remains and settles, because that shortfall can never be funded.

**One claim's day allowance covers both roles together.** A participant who
both lends and borrows works through a single per-claim allowance of days
rather than a separate full allowance per role — the allowance exists to bound
the size of one claim, and splitting it by role let a claim be twice the
intended size.

**Reclaiming forfeited rewards at loan close is unchanged for now.** The
redirect-to-treasury sweep still settles a forfeited reward in one step; it
moves to the day-by-day treatment in the next slice. A reward whose collection
has already *started* day-by-day is protected in the interim: the expiry
reclaim — whose one-step calculation has no memory of what was already paid —
leaves such rewards to their owner instead of reclaiming them, so nothing can
be counted twice. Rewards nobody has started collecting expire exactly as
before, and the expiry horizon is off by default anyway.

**Where the claim lives has moved.** The claim entry points now sit in their
own component, purely because contracts have a hard byte limit and the
day-by-day logic did not fit alongside everything else. The claim and its new
logic moved together deliberately, so collecting a payout still happens in one
place. There is no change to how a claim is made.

Part of #1351. Umbrella: #1349.

## Every reward settlement path now values exactly the uncollected days (#1351 slice 2d)

Follow-up to the chunked-claim slice. Once a reward can be collected a chunk
at a time, every OTHER path that prices that reward — the expiry reclaim, the
loan-close redirect of forfeited rewards, the claim preview, and the
funds-availability check — has to know what part is already collected, or it
will count those days a second time.

**One rule instead of four special cases.** The single pricing calculation
now values a reward's *remaining* days — everything at or after its recorded
collection position — rather than its whole lifetime. Every consumer of that
calculation becomes exact for partly-collected rewards automatically: the
expiry reclaim recovers precisely the days nobody collected (previously such
rewards were parked untouched as an interim safety measure, which this
replaces); the loan-close redirect of a forfeited reward likewise settles
only what the day-by-day collection hadn't already handled; the preview and
the funds check count only value that can still actually move. A reward whose
days are all collected simply has nothing left, on every path.

The interim safety measure this replaces — "a partly-collected reward is not
reclaimable by expiry at all" — was deliberately shipped with its deletion
pre-announced; this is that deletion, with the exact-valuation rule in its
place. A dedicated test proves a partly-collected reward's reclaim equals a
never-touched reward covering the identical remaining days, and fails in a
distinct way against both of the older behaviours (the double-count and the
park-forever).

Nothing pays differently on any current deployment: rewards only acquire a
collection position once the new reward regime's changeover is switched on,
which it is not, anywhere.

Part of #1351. Umbrella: #1349.

## The reward preview now promises exactly what a claim would pay (#1351 slice 2e)

Completes the preview half of the chunked-claim work. Nothing pays
differently anywhere — the new regime is still switched off on every
deployment; what changes is what the *preview* reports once it is on.

**The problem.** Under the new per-participant daily ceiling, what a claim
pays depends on things no single reward can know by itself: the day ceiling
is shared across *all* of a participant's rewards on that day, a single
claim processes a bounded number of days, and a partly-collected reward
resumes from where it stopped. The old preview valued each reward
independently, so a participant with two rewards sharing a day would have
been shown roughly twice what the claim would actually pay, and a long
backlog was shown all at once rather than per claim.

**The fix, without a second implementation.** The preview now runs the very
same day-by-day calculation the claim runs — same eligibility, same
ceilings, same day allowance — but keeps its progress in memory instead of
recording it, carrying forward between simulated days exactly what a real
claim would have recorded between real days. The payment arithmetic itself
exists once; the simulation only replaces where progress is kept. One
deliberate exception is documented in place: the internal funds-availability
safety check keeps a cheaper per-reward sum, because its contract is "a
guaranteed at-least figure" rather than "the exact payment" — and the exact
simulation is heavy enough that carrying it there would have pushed a
deployed component over the platform's hard size limit.

**What the preview now means.** It reports what *the next claim call* would
pay. A backlog longer than one claim's day allowance previews in
per-claim portions, updating as each claim advances. Three properties are
each pinned by a test that compares the preview against a real claim's
actual payout, and each was observed failing — always in the over-promising
direction — against the previous per-reward preview: two rewards sharing a
day, a backlog stopped mid-allowance, and a reward spanning the regime
changeover.

**Deliberately unchanged, on one axis only.** The preview does honour the
recycled pot's real balance — a day the claim would postpone for a short
recycled pot is not shown as payable — because that postponement is the
payment walk's own behaviour. What the preview still does not subtract is
the global reward budget's remaining lifetime headroom: on that one axis it
remains an upper bound that the claim itself truncates at payment time.

Part of #1351. Umbrella: #1349.

## Thread — HoldOnly borrower LIF + fee-default freeze 0.2%/2% (M2 PR-4) (PR #<n>)

Implements the borrower-side of the fee package the spec supersession (#1350)
described. Two changes, both dark-safe for the pre-live posture:

**Fee-default freeze (0.1%/1% → 0.2%/2%), grandfathered.** The compiled
default Loan-Initiation Fee moves from 0.1% to 0.2% and the yield (treasury)
fee from 1% to 2%, for **new** originations only. A loan snapshots the fee
rate in force at its origination, and the settlement resolver now falls back
to a **frozen legacy 1%** for any loan whose snapshot is zero (a pre-snapshot
loan) — so bumping the live default can never retroactively reprice an
already-open loan from 1% to 2% at repayment. The Loan-Initiation Fee is
charged once at acceptance, so the 0.2% only ever applies to new loans. On a
fresh deploy the new defaults are simply in force from genesis.

**Borrower LIF becomes a HoldOnly hold-tier direct reduction.** Previously a
consenting tier-holding borrower's Loan-Initiation-Fee discount was delivered
only through a peg-gated path that pulled the full fee in VPFI into protocol
custody and rebated it at settlement. That peg-custody path is **retired for
new loans**: the borrower's hold-tier discount is now applied **directly to
the lending-asset fee at acceptance** — the borrower simply pays less fee, in
the loan's own asset, with no VPFI moved and no custody taken. The discount is
resolved at acceptance (pinned at origination, so a last-minute top-up can't
game it), consent-gated, and applies on liquid-asset loans (an illiquid loan
pays the full fee — matching the prior posture, and a reward-eligible loan
requires a priceable asset anyway). A new loan therefore never records
up-front VPFI custody; loans already open on the legacy custody path keep
settling through their existing rebate/forfeit helpers unchanged. The
per-party VPFI "Full" tariff is a separate later card.

The accept charge and the accept-preview quote share one fee-computation
helper so a borrower is quoted exactly what they are charged. The offer-match
event's matcher-fee field is **gross/display-only** — it logs the list-rate
matcher slice, not the borrower's tier-discounted figure (folding the discount
into that event pushed the match facet past the runtime-bytecode limit, and
the field is an informational log rather than the borrower's charge).

**Uniform 50% fee-discount ceiling.** The 50% cap the borrower Loan-Initiation
Fee already respected is now applied symmetrically to the **lender yield-fee**
discount as well, and to the public `getEffectiveDiscount` view. Governance can
configure a per-tier discount as high as 90%, but the *applied* reduction on
either fee line — and what the view reports — is clamped at 50%, so a high-tier
lender can never under-collect treasury by more than half the yield fee.

The Loan-Initiation-Fee receipt (`loanInitiationFeeBpsAtInit`) is clarified as
the **list-rate schedule** the loan was originated under — a consenting
tier-holding borrower pays a lower effective rate after their HoldOnly discount,
derivable from their consent + tier. The client-side default fee mirrors and the
stale-facet upgrade script's selector list were also brought in sync with the
new defaults.

The connected-app accept modal was reframed to match the HoldOnly mechanic: a
consenting tier-holder now sees the discounted Loan-Initiation Fee charged in
the lending asset (with net proceeds = principal − fee), instead of the old
"pay the full fee in VPFI and receive a later rebate" framing that no longer
matches how the fee is charged. The fee and net-proceeds figures are read from
the authoritative on-chain accept preview (the exact fee the accept path will
charge), so they are correct whether the connected wallet is borrowing or
lending, independent of the VPFI price oracle, and rounded exactly as the
contract does. (The broader Full-tariff frontend surface remains tracked under
PR-8.) Closes #1352.

## Thread — Loan-side interaction-reward cap (M2 PR-5c) (PR #<n>)

Adds the third piece of the VPFI fee package the spec supersession (#1350)
described: the **loan-side interaction-reward cap**. Where the Full tariff
(#1347) makes a party *absorb* a fee-native `C*` at loan origination, this card
uses that same notional `C*` to **bound how much interaction-reward VPFI a
single loan can emit per side** — replacing the old #1008 "VPFI-per-ETH-of-
interest" ratio cap that scaled with loan volume and let a thin, high-share
book over-reward.

The new ceiling is a per-`(loanId, side)` **lifetime budget**, priced off the
`C*` stamped at open:

- `loanSideRewardCapOpen = ½ × C* × (1 − m_reward)`, cached at origination.
  `m_reward` is a new governable haircut (`setRewardHaircutBps`, default **2%**,
  bounded 0–20%), **snapshotted** at open so a later retune can't rewrite an
  open loan's ceiling.
- At claim the ceiling **prorates by rewarded days**:
  `loanSideRewardCapEff = loanSideRewardCapOpen × min(rewardedDays, openDays) /
  openDays`. An early-closed loan (few rewarded days) earns proportionally less;
  a lender sale splits the reward entry but the day count and paid budget are
  **shared** across both halves, so a sale can't reset the budget.
- Each side (lender / borrower) owns the per-side half of the tariff-linked
  ceiling; the 50/50 pool split is unchanged and the daily-pool share still runs
  first — the cap only ever **lowers** a payout, never raises it.
- The cap governs only the **armed (post-`D*`) portion** of a reward entry, so a
  loan whose reward window spans the cutover keeps its pre-`D*` days under the
  legacy #1008 regime and has only its post-`D*` slice loan-side-capped.

A loan that carries no `C*` **stamp** (`openDays == 0`) — a mirror-chain loan, a
dark-era pre-enable loan, or any pre-cutover loan — is **not** zeroed: the cap
simply **does not apply** and it earns normally. (A **stamped** loan whose `C*` /
ceiling merely rounds to 0 — a genuinely-priced dust loan — IS still capped; the
skip keys on the `openDays` stamp marker, always ≥ 1 when stamped, not on
`cStarOpen` or the rounded ceiling.) True reward-**ineligibility** (a
canonical origination whose list LIF cannot be priced) is enforced **upstream** by
not creating reward entries at all — never by zeroing a payout at the cap. This is
the anti-farming rule stated correctly: an unpriced loan draws nothing because it
has no reward entries, not because a live loan's earned reward is retroactively
voided.

Because that skip leaves an unstamped loan uncapped once #1008 also retires on
armed days, arming `D*` has a **precondition** (the `cStar` **backfill gate**):
every reward-eligible **canonical** loan must be stamped before `D*` arms — which
holds from genesis on a fresh (pre-live) deploy, and is backfilled first on a
post-launch cutover. Mirror-chain loans are bounded by the D1 share cap (PR-2) on
their local claim, not the loan-side cap. The arming-time enforcement is a
deploy-assert (PR-9).

The whole cap is gated on the **joint cutover `D*`** (the ShareOfPool arming):
while `D*` is unarmed — the state of every current deploy — the cap is a
complete no-op and the pre-cutover #1008 regime is untouched, so this ships
**dark**. `D*` is armed later, jointly with the D1 share cap (PR-2 #1351) and
the settlement sweep (PR-6 #1354); the master `feeEntitlementEnabled` switch
stays forbidden until all three are live. On a fresh (pre-live) deploy every
loan stamps its notional `C*` from genesis, so there is no backfill step. The
lender-Full settlement discount (+10% yield-fee) and the frontend tariff quote
remain separate later cards (PR-6 #1354 / PR-8 #1355). Closes #1353.

## Thread — Settlement sweep honors the lender Full stamp (M2 PR-6) (PR #<n>)

Adds the lender-side counterpart to the Full fee package the spec supersession
(#1350) described. Where the Full tariff (#1347) makes a lender *absorb* a
fee-native `C*` at loan origination, this card makes every lender-yield
settlement finally **honor** that opt-in: a lender who paid the Full tariff now
receives the promised **+10% own-side yield-fee discount** when the loan repays,
precloses, refinances, or auto-settles.

Concretely, the lender yield-fee discount at settlement becomes
`d = min(d_hold + d_tariff, 5000)` — the existing consent-gated hold-tier
discount `d_hold` **plus** a `d_tariff` of `+10%` whenever the loan's lender
absorbed the Full tariff (`lenderMode == Full`), all still capped at the uniform
50% ceiling. Two consequences fall out of the spec (formula §F2):

- **The Full opt-in is itself the consent.** A lender who paid `C*` but never
  toggled the separate hold-discount consent still gets the `+10%`: the hold
  slice `d_hold` stays `0` without consent, but the tariff slice does not require
  it. The settlement sites therefore attempt the discount whenever the lender has
  consent **or** absorbed Full (previously consent-only, which would have
  silently skipped a Full-no-consent lender — paying the tariff and getting
  nothing back).
- **Borrower Full never leaks into the lender's discount.** Only the lender's
  own hold tier and own Full stamp feed the lender `d`; a borrower's Full stamp
  is irrelevant to the yield fee.

The bump is delivered through **both** existing delivery modes with no call-site
duplication: the discount computation was centralised so the VPFI-payment path
(peg configured) and the Phase-1 direct-reduction path (peg unset) both charge
against the same Full-aware total. The four **primary** lender-yield settlement
facets — repay, preclose direct close, refinance, and the auto-lifecycle sweep —
pick up the change through the shared helper.

Because the VPFI-payment delivery **debits** the lender's vault, and settlement
consolidates `loan.lender` to the current position-NFT holder before quoting,
that path is gated on the charged party's own consent: an unsolicited transfer
of a Full-stamped lender position can never spend a non-consenting recipient's
VPFI. A Full lender without hold consent still receives the `+10%` — but only
through the no-token-move direct-reduction path, in every peg posture.

**Scope — still pending before `feeEntitlementEnabled` cut-over (hard blockers).**
Two tracked items remain, both enforced by the PR-9 (#1356) deploy-asserts so
the master switch cannot cut over while either is open:

- **#1383 — secondary settlement paths.** The `+10%` is not yet honored on
  swap-to-repay, preclose obligation-transfer (Option 2b) / offset (Option 3),
  rental-prepay, **partial repay** (`RepayFacet.repayPartial`),
  **periodic-interest** (`RepayPeriodicFacet`), or the **auto-lifecycle
  transferred-position** case (where the current holder ≠ the recorded lender).
  These apply neither the hold nor the Full discount today; extending them
  cleanly needs a size-reducing shared-helper refactor (preclose sits close to
  the EIP-170 limit) that also keys eligibility on the current holder.
- **#1384 — extension repricing.** `extendLoanInPlace` overwrites the loan term
  without restamping the fee entitlement, so an extended Full loan would keep
  the `+10%` (and the #1353 reward-cap budget) on unpriced added term until the
  entitlement is restamped/recharged for the new term.

No lender may pay `C*` while any settlement path they can be closed through
ignores the stamp, so both must close before the cut-over.

This ships **dark**: no loan carries a `Full` lender stamp until the Full opt-in
path (`feeEntitlementEnabled`) is enabled at the M2 joint cutover, so every
current settlement resolves to exactly the pre-existing consent-gated hold
discount — the change is a strict no-op today. PR-6 is itself a hard dependency
of that enablement (a lender must never be able to pay `C*` while settlement
still ignores the lender Full stamp), which this card removes. The frontend Full
quote / incidence copy remains a separate later card (PR-8 #1355). Closes #1354.

## Thread — Full VPFI tariff opt-in surfaces in the connected app (PR #TBD)

The connected app now carries the user-facing half of the M2 Full
fee-entitlement tariff (#1347): each party can opt their own side into
Full at the moment their authorization is actually signed. On the
classic accept review and the desk's signed-order fill confirm, the
acceptor sees a live tariff quote for the prospective loan, an editable
authorization ceiling (seeded from the quote plus a small headroom, and
mandatory — the app refuses to sign a Full opt-in without one, mirroring
the contract), a warning when their vault's free VPFI is below the
quote, and an explicit choice between "reject the whole acceptance if
the tariff can't complete" and "open the loan without Full in that
case". A standing-offer creator arms their own opt-in after posting,
from the desk's Open Orders panel (the contract deliberately keeps this
off the create path); a signed-order maker cannot opt in at all until
the follow-up that threads it through the gasless order shape (#1369).

The copy holds the dual-fee honesty line throughout: paying the tariff
never replaces the loan's asset fees — it adds a deeper discount on the
payer's own side's fees, up to the overall cap — and the tariff is
non-refundable, priced on the loan's full term at open. Loan Details
shows the stamped per-party fee modes and absorbed tariffs once a party
actually paid Full, warns before an early close that none of the tariff
comes back, and notes on the lender's sale surfaces that the Full fee
mode travels with the position NFT to a buyer. While the on-chain
kill-switch is off — the deployed posture until the M2 joint cutover —
no new opt-in can be collected anywhere, because a Full authorization
presented while the feature is dark fails on chain. One recovery
surface deliberately remains in that state: the creator of a standing
offer that is already armed with Full can still open the offer's tariff
form to clear the commitment (a strict armed offer is otherwise
unfillable while dark); that form only permits clearing there, never
arming.

The whole surface is exercised on the CI Anvil fork
(`e2e/tests/24-full-tariff.spec.ts`): the dark default renders no
opt-in control; with the feature admin-enabled, a strict Full opt-in
from an empty vault rejects the accept end-to-end (proving the signed
opt-in reaches the contract), and the same accept with downgrade
permission opens the loan with a stamped non-Full record. New copy ships
English-first and reaches the other locales at the next bundle refresh.
Closes #1355.

## Deploy-time guardrails for the new fee-and-reward defaults (#1356)

Adds the M2 deploy-sanity asserts the completion plan schedules before any
mainnet deploy. A fresh deployment is now proven — by the same automated
gate every deploy already runs — to land in exactly the intended dark
state:

- the VPFI price anchor is unset (the retail deploy never prices VPFI, and
  an accidentally-set anchor would arm the VPFI-payment discount path);
- new-origination fees resolve to the frozen defaults (0.2% initiation,
  2% yield);
- the fee-entitlement master switch is off — the joint reward-cutover gate
  expressed as a deploy assert — with its tariff coefficient at the bounded
  default;
- the reward governor is unarmed (arming is an operator ceremony with its
  own preconditions);
- the retired per-ETH-day tariff knob still reads its default, so a value
  moved on a dead knob is caught as the alarm it is.

Because the platform is pre-live, these are green-field assertions on
fresh deploys — no migration variants exist or are needed.

The pre-deploy gate also gains a drift check between the deploy scripts
and the shared deployments manifest: every facet address a deploy script
records must have a matching typed field in the manifest every consumer
reads — an unrecorded-but-deployed address would otherwise be invisible to
the frontend and the off-chain workers. Typed fields that no script writes
are listed as advisory only, since some are populated by chain-specific
tooling.

Part of the #1349 recycling completion programme (plan §M2 PR-9).

## Thread — alpha02: AST-based hardcoded-string detector (#1365)

The `apps/alpha02` guardrail that fails CI when a user-visible string is
hardcoded instead of routed through the copy catalog was a line-based
regex scanner. It had been hardened five times and still had a
structural blind spot: a real prose word sitting next to an
interpolation — `expires {date}`, `{collateral} collateral (borrower's)`,
`Offer #{id} · waiting for the other side to accept`. These render
through JSX with values spliced mid-sentence, so there is no clean
`>text<` node and no quoted literal, and a per-line regex cannot blank
`${...}` boundaries precisely or tell a rendered word from a code token.
The previous release shipped a dozen such strings that the regex passed
clean, surfacing only when a user viewing the app in Chinese saw English
fragments.

This replaces the regex scanner with a detector that parses each `.tsx`
with the TypeScript compiler and inspects the exact rendered positions
the syntax tree exposes: JSX text children, string/template literals used
as JSX children (including inside conditionals), and a small allowlist of
user-visible JSX attributes (title, aria-label, placeholder, alt, …). The
attribute/object-key allowlist is backed by a camelCase-suffix rule
(`*Label`, `*Title`, `*Body`, `*Hint`, …) so a component's typed
copy-field family (the offer-flow side copy, step labels, take/submit
labels) is covered as a whole without enumerating every field name, while
lowercase look-alikes like `context` stay untouched. Hardcoded values
passed into a catalog template through the codebase's established
branch-alias pattern (`const text = copy.desk.ticket; text.method('…')`,
including destructured `const { tokenSecurity } = copy`) are followed via
a single-file, lexically-scoped alias map — function parameters, block,
loop, and catch bindings that reuse a common variable name are respected,
so ordinary code is never mis-flagged and a real alias call after a
shadowing scope still is — and prose inside tagged templates, object-spread
prop bags, or the string returns of a rendered `.map()` callback is scanned
the same as its direct form. HTML entities (`&nbsp;`, `&middot;`) are
treated as the punctuation/spacing they render, never as words.
Because the parse makes "is this rendered?" unambiguous, the detector can
flag even a single prose word without the false positives that blocked
the regex — a template literal assigned to a className or a route is
simply never in a scanned position. A standalone TypeScript-compiler
script was chosen over an ESLint rule because alpha02 deliberately runs no
ESLint toolchain; the script stays wired into the same `typecheck` lane.

Running the new detector on the tree found several dozen pre-existing
hardcoded strings the regex had missed (the committed baseline currently
freezes 48 occurrences across 19 files, most of them advanced Rate-Desk
copy and hardcoded fallback labels passed into catalog templates).
Rather than block the tooling change on extracting them all, they are
frozen in a file-scoped, occurrence-counted baseline (the standard
lint-ratchet: existing debt grandfathered, any new violation — new file,
new string, or new duplicate — blocked; the check also fails if a
baselined string is extracted without lowering its count, so burn-down
stays honest). Their burn-down is tracked as a follow-up. A unit test
suite pins the detector against the exact bug shapes from the previous
release so the guardrail cannot silently regain its blind spot. Scope is
limited to `apps/alpha02`.

## A lender's Full-tariff opt-in now counts when a keeper matches their offer

The Full tariff is a fee a party opts into on their own offer, in exchange for
a deeper discount on their own side's fees. Until now that opt-in was honoured
on a direct acceptance but quietly ignored when a keeper matched two standing
offers against each other.

The reason is a detail of how a match executes: it fills the borrower's offer,
so the lender's own offer — the only place their authorization lives — was
never consulted. The lender was resolved as not having opted in at all,
so they were neither charged the tariff nor told their authorization had been
declined. No wrong charge ever occurred and the feature is off in production,
which is why this was safe to leave open, but it made the tariff a party pays
depend on which route happened to fill their offer rather than on what they
signed.

A match now carries the lender's offer through to where the tariff is priced,
so both sides are resolved from the artifact each of them actually signed.
A lender who opted in is charged exactly as on a direct acceptance; a lender
who opted into nothing is charged nothing, whatever the counterparty did.

There is a second half to "honoured whichever venue fills it", and review
caught that the first version only did the first half. When the feature is
switched off — which is how it ships today, and permanently so on chains that
do not host the token — a lender who opted in and refused a downgrade has said
"charge me or do not open this loan". A direct acceptance of that offer
correctly refuses to open. A matched fill did not: the decision about whether
to price the fee at all still looked only at the borrower's offer, so it
skipped the step entirely and opened the loan un-priced. The guarantee was
venue-dependent in exactly the configuration that ships. That decision now
consults the lender's offer too, so both venues refuse alike — and a lender
who *did* permit a downgrade still gets their loan opened, un-priced, as they
asked.

The carried reference cannot outlive its match. Two independent guards stop
it: the substitution is permitted only while a match is in progress, and that
flag has a single clearing point, while the reference itself is cleared beside
it. Removing either alone leaves the other holding — confirmed by removing
each in turn and watching the behaviour stay correct, then removing both and
watching a later unrelated acceptance charge a lender who had authorized
nothing.

Closes #1369. Part of the #1349 recycling-completion programme.

## Thread — Extract the shared lender-yield-fee resolve helper (M2 PR-6 follow-up, part A) (PR #<n>)

Groundwork for #1383. The lender yield-fee settlement delivery — the
`consent OR Full`-stamp eligibility gate followed by the
"try VPFI-payment, else direct-reduction" fallback that #1354 wired into the
four **primary** lender-yield settlement paths (terminal repay, preclose direct
close, refinance, and the auto-lifecycle interest sweep) — was duplicated
almost verbatim across those four facets. This change extracts it into a single
shared helper, `LibVPFIDiscount.resolveLenderYieldFee`, and points the four
primary facets at it.

The helper takes the settlement's pre-split interest and the full treasury share
and returns the deltas the caller folds into its plan: how much extra the lender
keeps in the lending asset, the treasury share that actually transfers, and any
VPFI debited from the lender's vault. The four call sites collapse to a single
call plus a three-line apply, with no change to what any of them compute or
move — the lender still receives exactly the same discounted settlement as
before.

This is a **pure, behaviour-preserving refactor**. It ships **dark** for the
same reason #1354 did — no loan carries a `Full` lender stamp until the M2
`feeEntitlementEnabled` cut-over, so every current settlement still resolves to
the pre-existing consent-gated hold discount. Nothing an external caller can
observe changes today.

Its purpose is to give the **secondary** settlement paths (#1383 part B:
swap-to-repay, partial repay, preclose obligation-transfer / offset /
rental-prepay, periodic interest) one proven, size-cheap entry point to honor
the same lender Full/hold discount — several of those facets sit too close to
the EIP-170 limit to inline the delivery block a fifth, sixth, and seventh time.
Part B wraps this same helper behind a diamond-internal host so those
size-constrained facets can call it without carrying the delivery logic in their
own bytecode, and extends eligibility to the current position-NFT holder on the
paths that don't consolidate the lender.

Part of #1383. Does not itself close the `feeEntitlementEnabled` cut-over
blocker — part B does.

## Thread — Honor the lender Full/hold stamp on the repay-family settlement paths (M2 PR-6 follow-up, part B2 — repay family) (PR #<n>)

Continues #1383 (part B delivered the swap family via the shared resolve host).
This part delivers the same §F2 lender Full/hold yield-fee discount (#1354) to the
**repay-family** secondary settlement paths, which previously transferred the
treasury cut with **no** discount:

- **`RepayFacet.repayPartial`** (ERC-20 and NFT-rental branches) — keyed on the
  current lender-NFT holder (this path does not reliably consolidate
  `loan.lender` — the #597 `heldForLender` exclusion).
- **`RepayPeriodicFacet.autoDeductDaily`** (NFT-rental daily interest) — keyed on
  the current holder, which the daily payout already routes to.

The VPFI-payment delivery can drive the treasury share to zero (the cut is paid
in the lender's VPFI instead). Both paths transfer the treasury cut
unconditionally, and they deliberately stay that way: a zero-amount transfer is
a harmless no-op, and adding a skip would have quietly changed long-standing
behaviour that existing tests pin.

A rental-specific correctness fix rides along: the yield fee on an NFT rental is
denominated in the rental's prepay asset, but the discount quote was pricing it
against the loan's principal asset — which for a rental is the rented NFT
itself. Asking for a price and decimals on an NFT simply fails, so the quote
gave up and every rental lender silently lost the option to pay the fee in VPFI.
The quote now prices against whichever asset the fee is actually denominated in,
which fixes it for every rental settlement path at once. The no-token-move
discount was never affected.

To make the room for these on the at-EIP-170 `RepayFacet`, its **primary**
`repayLoan` path is switched from inlining the discount delivery to calling the
same diamond-internal resolve host the secondary paths use — a net bytecode
**reduction** (the delivery logic lives on one facet), behaviour-preserving, and
it also moves the analytics passthrough event onto the host so the facet no
longer emits it separately. As part of the same hardening, `repayLoan` and
`swapToRepayFull` now key the resolve on the current lender-NFT holder rather
than `loan.lender`, so a settlement whose lender consolidation was skipped (a
sanctioned holder / the `heldForLender` exclusion) can never resolve the
discount — or a VPFI vault debit — for the wrong party.

The remaining secondary paths — preclose obligation-transfer / offset /
rental-prepay, and the auto-lifecycle transferred-position case — are handled
next, reusing this same host.

Ships **dark**: no loan carries a `Full` lender stamp until the M2
`feeEntitlementEnabled` cut-over, so every current repay settlement resolves to
exactly the pre-existing behaviour (which now also includes the consent-gated
hold discount these paths formerly ignored).

Tests: a Full-stamped lender settled through `repayPartial` receives the exact
10% treasury-cut discount (reference vs Full); the existing `repayLoan`
settlement-sweep suite re-runs green through the host (behaviour-preserving
conversion). Part of #1383. Umbrella: #1349.

## Thread — Honor the lender Full/hold stamp on the preclose-family settlement paths (M2 PR-6 follow-up, part B3 — preclose family) (PR #<n>)

Continues #1383. Parts B and B2 delivered the swap family and the repay family;
this part extends the same lender Full/hold yield-fee discount to the
**preclose family** — the early-close and obligation-transfer settlements, which
until now took their treasury cut with no discount at all.

Three settlement legs that previously ignored the discount now honor it:

- **Early close of an NFT rental.** A rental lender lost the discount purely
  because the collateral was an NFT — the rental leg never asked for it. It now
  does, sized on the same remaining-rental-plus-late-fee base the treasury cut is
  taken from.
- **Obligation transfer, interest leg.** When a borrower hands their obligation
  to a new borrower, the exiting lender is paid the interest accrued up to the
  handover. That settlement now applies the lender's discount. The extra top-up
  the incoming borrower owes for a shorter replacement term is money the treasury
  never touches, so it stays outside the discounted base.
- **Obligation transfer, rental catch-up leg.** Same for the rent that accrued
  since the last daily deduction, which is forwarded to the lender at the moment
  of transfer.

Every leg resolves the discount for **whoever currently holds the lender
position**, which is the party a claim actually pays out to. This matters most
when a lender position has been sold: the settlement bookkeeping can still name
the seller in places, and pricing the discount off that stale name would have
sized it against the seller's holdings and — once the token peg is configured —
spent the seller's own tokens to fund a discount they would never receive. The
discount follows the party who is paid, never the party the paperwork happens to
still mention.

To make room for all of this on a facet that was within a few hundred bytes of
the contract size limit, the early-close ERC-20 path was switched from carrying
its own copy of the discount delivery to calling the shared settlement helper the
other paths use. That reclaimed roughly two kilobytes, leaving comfortable
headroom rather than the sliver there was before, and it means the discount
logic now lives in exactly one place across every settlement path in the system.

Ships **dark**: no loan carries a Full lender stamp until the fee-entitlement
cut-over, so every current preclose and obligation transfer settles exactly as it
did before — now also including the consent-gated hold discount these paths
formerly ignored.

Two settlement paths are deliberately **not** covered here and remain
prerequisites before the fee-entitlement cut-over: the offset close-out (its
treasury cut is computed in one transaction but settled in a later one, so the
figure the discount is sized against has to be carried across that boundary) and
the automated-lifecycle case where the lender position has been transferred.
Each is subtle enough to warrant its own focused change.

Part of #1383. Umbrella: #1349.

## Thread — Honor the lender Full/hold stamp on the swap-to-repay settlement paths (M2 PR-6 follow-up, part B — swap family) (PR #<n>)

Continues #1383. Part A extracted the lender yield-fee resolve into a shared
helper and pointed the four **primary** settlement paths at it. This part
delivers the same §F2 lender Full/hold discount to the **swap-to-repay**
secondary settlement paths, which previously transferred the treasury cut with
no discount at all — so a lender who paid the Full `C*` tariff and was settled
through a swap received none of the promised **+10%**.

Two pieces of groundwork make this work cleanly:

- **A diamond-internal resolve host.** `VPFIDiscountFacet.resolveLenderYieldFeeFor`
  runs the whole try-VPFI-then-direct-reduction delivery for a given loan and
  settling lender, and emits the analytics passthrough when VPFI moves. Because
  the delivery logic now lives on one facet, the size-constrained settlement
  facets call it with a single cross-facet call instead of carrying the delivery
  bytecode themselves — the EIP-170 headroom an inlined library helper cannot
  free.

- **Keying the discount on the party actually being paid.** The resolve helpers
  now take an explicit settling-lender address. On the paths that consolidate
  the lender to the current position-NFT holder, that is the recorded lender; on
  the paths that do not, it is the **current holder**. Because the hold-tier
  discount is an instantaneous per-address tier read (the per-loan time-weighted
  window was retired earlier), the current holder's own tier is exactly the
  correct discount for them, and the Full `+10%` — being loan-scoped — applies to
  whoever holds the position.

Wired in this part:

- **`swapToRepayFull`** — consolidates the lender, so keyed on the recorded
  lender. The discount shifts the treasury cut to the lender in the lending
  asset (or is paid in the lender's VPFI when a price source is configured),
  with the settlement's required-proceeds and borrower-surplus amounts unchanged.
- **`swapToRepayPartial`** — does not consolidate the lender, so keyed on the
  current lender-NFT holder (matching where the path already routes the payout).
- **The Fusion swap-to-repay intent settlement** — the lender-side consolidation
  runs after the treasury split, so likewise keyed on the current holder.

The remaining secondary paths — preclose obligation-transfer / offset /
rental-prepay, partial repay, and periodic interest — are handled in the next
part, reusing this same host.

Ships **dark**: no loan carries a `Full` lender stamp until the M2
`feeEntitlementEnabled` cut-over, so every current swap-to-repay settlement
resolves to exactly the pre-existing behaviour (the consent-gated hold discount,
which these paths also now honor). Part of the #1383 cut-over blocker. Umbrella:
#1349.

## Thread — Reprice the fee entitlement when a loan is extended in place (M2 Full-tariff follow-up) (PR #<n>)

Closes one of the two `feeEntitlementEnabled` cut-over blockers the M2 settlement
sweep (#1354) left open. When a loan is **extended in place**
(`AutoLifecycleFacet.extendLoanInPlace`), the executor settles the current term's
interest and rolls the loan onto a **new term** — but its fee-entitlement record
is stamped once at origination and was never revisited.

For a loan whose **lender** paid the Full `C*` tariff, that gap let the lender
keep the promised **+10% yield-fee discount** (#1354) on the later extended-term
interest **without paying any new tariff for the added term**. The extension
carries no fresh per-party Full authorization (it is a keeper-driven / borrower-
driven lifecycle action, not a new signed opt-in), so there is nothing to charge
the added term against.

The single repricing action on extension is therefore to **downgrade a lender
Full stamp to None** (and clear the recorded paid tariff). Because the +10% is
delivered **per term** — the original term's bump is already settled, with the
Full stamp intact, at the extension boundary — the downgrade only stops the bump
on the term no `C*` was paid for. The lender's ordinary consent-gated hold
discount is unaffected (it flows from the platform VPFI-discount consent,
independent of the Full stamp).

Everything else is deliberately left untouched:

- **The loan-side reward-cap budget (#1353) is preserved.** That budget is a
  per-loan **lifetime** ceiling, consumed lazily as rewards are counted, and the
  single `C*` funds the whole loan's rewards across all terms. Resetting it on
  extension would retroactively cap an **unclaimed original-term** reward budget
  to zero. The per-day proration already clamps at the origination term, so an
  extension can never over-credit; refining the proration base across the
  extension boundary is a separate precision item (#1372).
- **The borrower stamp is left as-is.** No settlement path reads the borrower
  mode — it is an informational record — so there is no per-term borrower
  benefit to reprice. (A new Full borrower's `C*` is routed to the recycle
  bucket at origination, not held per-loan; the legacy peg-custody borrower-LIF
  rebate is a separate, pre-existing mechanism and is untouched regardless.)

The reprice is a **no-op on a plain (unstamped) or non-Full-lender loan**. Ships
**dark** with the rest of the M2 fee package: while no loan carries a Full stamp
(the master switch is off on every deploy), this only ever reads zero-default
fields and returns.

This closes **only this blocker**. The other M2 cut-over blocker — honoring the
lender Full/hold stamp on the **secondary** settlement paths (#1383) — remains
open; the PR-9 (#1356) deploy-asserts gate the master switch on both.

Closes #1384. Umbrella: #1349.

## Thread — Honor the lender Full/hold stamp on the offset close-out (PR #<n>)

Follows #1383. The lender fee discount is now honored on the **offset** close-out
— the route where a borrower replaces their existing loan with a new one and the
original lender is paid off as part of that swap. Until now this was the one
close-out where the treasury took its cut with no discount, so a lender who had
paid for the discount lost it purely by exiting through an offset instead of an
ordinary repayment or early close.

The offset is unusual: what the lender is owed is worked out while the
replacement offer is being posted, but the money only actually moves later, when
someone accepts that offer. The figure the discount has to be sized against is
therefore calculated in one step and spent in another, and it now gets carried
across that gap so the discount is applied to exactly the same amount the
treasury cut was taken from. The extra top-up the lender receives when the
replacement loan pays less than the original stays outside that figure, since
the treasury never takes a share of it.

Delivering the discount inside someone else's acceptance transaction is safe in
both forms it can take. The form that simply reduces the treasury's share moves
no tokens at all. The form where the lender pays the fee in VPFI instead is
already gated on that lender's own recorded opt-in, so an acceptance by another
party can never spend the tokens of a lender who never opted in — they receive
the benefit through the no-token-movement route instead.

As with the other close-out paths, the discount is resolved for **whoever
currently holds the lender position**, which is who a claim actually pays out to,
rather than whichever address the settlement bookkeeping still happens to name.

Ships **dark**: no loan carries a Full lender stamp until the fee-entitlement
cut-over, so every current offset settles exactly as it did before — now also
including the opt-in hold discount this path formerly ignored.

Closes #1391. Umbrella: #1349.

## Thread — A sold lender position keeps the fee discount it paid for, on automated loan extensions (PR #<n>)

Follows #1383 and #1391. This closes the last settlement path where the lender
fee discount was not honored: the automated loan-extension flow.

The problem was specific and unfair to the lender. A lender can pay an upfront
tariff to buy a standing discount on the fee taken out of their interest. If that
lender later **sold their position** to someone else, the automated extension
flow stopped applying the discount at all — so the benefit that had been paid for
simply evaporated the moment the position changed hands, and the treasury quietly
took the undiscounted cut instead.

The skip was not arbitrary. The older discount machinery always charged the
*originally recorded* lender internally, so applying it after a sale would have
billed the seller for interest the buyer was receiving. Refusing to apply it was
the safe choice available at the time.

That constraint no longer exists: the discount can now be resolved for an
explicitly named party. So instead of opting out after a sale, the flow now
resolves the discount for **whoever currently holds the lender position** — the
same party the interest is actually paid to. The original concern is addressed
properly rather than avoided:

- The portion of the discount bought by the upfront tariff belongs to the loan,
  not to a person, so it survives a sale intact.
- The portion earned by holding tokens is read live for whoever holds the
  position now, so the new holder's own standing applies — not the seller's.
- If the fee is to be settled in tokens from a vault, that is still gated on the
  current holder's own recorded opt-in. A holder who never opted in is never
  charged; they receive the benefit through the route that moves no tokens.

Two side effects of the change: discounts applied on this path now emit the same
analytics record every other settlement path emits, so reporting no longer has a
blind spot here; and the contract itself got noticeably smaller, since the
discount logic is now shared rather than duplicated.

Ships **dark**: no loan carries a paid lender stamp until the fee-entitlement
cut-over, so every current extension settles exactly as it did before — now also
including the opt-in holding discount this path formerly ignored on transferred
positions.

Closes #1392. Umbrella: #1349.

## Thread — alpha02: Basic-surface hardcoded strings extracted and translated (#1393)

The last patch of user-visible English on the connected app's Basic
surface — strings that rendered the same in every language because they
were hardcoded in the markup rather than routed through the copy catalog
— was moved into the catalog and translated. These were the occurrences
the AST detector (#1365) had frozen in its baseline; this is the burn-down
that empties that baseline for the Basic surface (the advanced Rate-Desk
copy is a separate later pass, and the release-stage badge stays English
as a proper noun).

The extracted strings: the offer-book row line ("Lend 100 mUSDC at 5%
yearly") and its offer-number chip; the accept-mode banner opener ("You're
accepting lending offer" / "You're funding borrow request"); the two
token-security leg labels (loan asset / collateral); the "Step N of M"
compact step indicator; the "on <chain>" vault-address suffix; the
contract-address accessibility label on the asset picker; the "…? Switch"
path toggle, the prepayment-token security-gate label, and the
network-name fallback on the rental flow; the unknown-collateral-symbol
and unknown-chain-id fallbacks; and the VPFI "warming up" tier explainer —
the last composed from a body template plus interchangeable tier and
"currently" sub-phrases so each language supplies its own wording rather
than gluing English fragments together.

Each new catalog key was translated across all nine active locales (zh,
ta, de, fr, es, ar, ja, ko, hi), reusing each locale's existing
terminology for recurring words like collateral, yearly, and lend/borrow.
English output is byte-for-byte unchanged. With these gone, the
hardcoded-string detector's Basic-surface baseline is empty, so the same
strings cannot be reintroduced untranslated. Scope is limited to
`apps/alpha02`; no other app, package, or contract was changed.

## Thread — alpha02: Rate-Desk hardcoded strings extracted and translated

The advanced Rate-Desk terminal was the last connected-app surface still
rendering English in every language, because a handful of its labels and
tooltips were hardcoded in the markup rather than routed through the copy
catalog. These were the occurrences the AST hardcoded-string detector
(#1365) had frozen in its baseline for the desk; this pass moves them into
the catalog, translates them, and empties that baseline.

The extracted strings: the tape panel's "Loading recent fills…" line and
its per-row tooltip (rate · loan # · status); the market-header last-fill
tooltip; the order-book mid-row ("mid …" with an optional " · spread …"
suffix, now two catalog pieces so the connector translates cleanly) and
its quoted-mid tooltip; the crossable-match band's pair tooltip (rate ·
offers # × #); the open-orders amend form's "Reading the offer's live
values…" line, its "Close" button, and the "bps stored on-chain" unit
hint; the signed-fill confirm's "Close" button; the positions row's
remaining-days ("N d left" / "N d overdue") and partial-repay marker; and
the order ticket's two security-check leg labels (loan asset / collateral),
which are display-only there, so localizing them carries no gate-recheck
hazard. The loan-id references in the desk history and positions rows now
reuse the shared "Loan #N" catalog entry instead of a second hardcoded
copy.

One dependency had to be resolved first: the recent-fills tape tooltip
shows the raw indexer loan-status word (active / repaid / defaulted /
liquidated / settled / settling / matched), which — unlike the position
and history badges that collapse status through the existing label helper —
had no translated vocabulary. A small `desk.loanStatus` map now localizes
each of those seven values, so the tape tooltip reads in the active
language like the rest of the desk.

Each new catalog key was translated across all nine active locales (zh,
ta, de, fr, es, ar, ja, ko, hi), reusing each locale's existing desk
terminology for recurring words like spread, mid, loan, and collateral,
and preserving every `{{placeholder}}` and the leading spaces on the
concatenated fragments. English output is byte-for-byte unchanged. With
these gone, the hardcoded-string detector's desk baseline is empty — only
the AppShell release-stage badge (a proper noun) and non-copy developer
diagnostics remain frozen — so the same strings cannot be reintroduced
untranslated. Scope is limited to `apps/alpha02`; no other app, package,
or contract was changed.

## Thread — alpha02: hardcoded-string detector now scans `.ts` helpers (#1398)

The AST hardcoded-string guardrail (#1365) only walked `.tsx` files, so a
hardcoded fallback string passed into a `copy.*` template from a plain
`.ts` helper could ship untranslated without tripping CI. The detector now
also scans `.ts` files, in a scoped mode: because `.ts` has no JSX and is
full of catalog / config / label-map objects, only the `copy.*`
call-argument check runs there (the JSX and object-key checks stay
`.tsx`-only), and the catalog source, declaration files, and tests are
skipped. This keeps the `.ts` scan focused on the one real class — a
hardcoded English literal filled into a translated message — without
flagging the ordinary data objects that fill helper files.

Turning it on surfaced exactly one pre-existing occurrence (the
"the required asset" symbol fallback in `contracts/preflights.ts`, which
feeds the "you need more" balance error when a token's symbol can't be
read). It is grandfathered in the detector baseline and tracked for
extraction with the rest of the fallback-label work; the point of this
change is that the ratchet now *sees* the `.ts` copy-arg surface, so a new
hardcoded fallback there fails CI instead of shipping silently. Scope is
limited to `apps/alpha02`.

## Thread — Rate Desk i18n wording pass (post-#1403 live review)

Following the post-deploy live review of the #1403 Rate-Desk string
extraction (recorded in
`docs/DesignsAndPlans/RateDeskI18nLiveReview-2026-07-22.md`), this change
refines the desk translations in five locales so they read as the intended
market meaning rather than a literal word-swap — and, critically, so each
desk term agrees with how that same concept is already rendered elsewhere in
the same bundle.

Applied: French/German/Spanish now use the standard market term for the
quoted mid rate (`cours moyen` / `Mittelkurs` / `punto medio`) consistently
across the whole desk (market header, chart overlay, and the ladder mid row)
instead of the literal "middle" renderings; German's opaque `T` day chip
becomes `Tg.`; Arabic's ladder mid label is aligned to the same word its own
market header uses; and two Tamil desk strings are corrected — an "on-chain"
label that literally said "in the physical chain" now uses the on-chain term
the rest of the Tamil bundle already uses, and an "offer" label is aligned to
its immediate sibling in the same block.

Several initially-flagged items were deliberately left unchanged because the
"suboptimal" term turned out to be the bundle's own established, consistent
choice (e.g. Spanish `en default`, Japanese `超過` for overdue) — changing
only the desk would introduce a second word for the same thing. Those, plus a
pre-existing app-wide split in Tamil's word for "offer", are documented in the
review as follow-up items rather than silently half-fixed here. Korean and
Hindi keep their intentional English-jargon posture, which is consistent
app-wide. Locale JSON values only — no source, `copy.ts`, `en.json`, or key
changes; placeholder parity re-verified across all nine locales and the i18n
test suite is green.

## Each chain now records how much reward funding it was actually sent

Groundwork only. Nothing reads this yet and no behaviour changes — it is the
first of three steps toward letting secondary chains pay rewards at all.

### The gap it fills

Reward funding for secondary chains is sent from the main chain. Until now,
when a secondary chain worked out how much it could still pay out, it
consulted the **programme-wide lifetime cap** less what it had paid locally.
That figure is nearly meaningless there: every secondary chain computes it
independently, so each one concludes it has almost the entire programme
available. What actually limits a secondary chain is what the main chain sent
it, and nothing was counting that.

A recent change did narrow this. Before paying, a chain now refuses if the
amount exceeds the tokens it holds that are not already spoken for. That is a
real improvement and it prevents the worst version of the problem. But it
measures **what the chain happens to be holding**, not **what was delivered
to fund rewards** — so tokens that arrived for some other reason (a donation,
an operator transfer meant for something else) can still be paid out as
rewards, and the main chain's own accounting never sees it happen.

So each chain now keeps a running total of the reward funding delivered to it
for coordinated-mode days, separating the portion that is genuinely new from
the portion that is recycled value being relocated. The recycled portion is
already tracked elsewhere; counting it here too would double-count the
backing.

### Two tests a delivery has to pass — and what happens when it fails one

**It has to say what it is made of.** Deliveries arrive in one of three
formats, and the two older ones never carried the new-versus-recycled split at
all. On those, a recycled portion of zero means "not stated", not "none was
recycled" — and from inside the accounting the two are indistinguishable.
Working the new portion out there as "everything that wasn't recycled" would
therefore record a delivery of *entirely unknown* composition as *entirely
new*: over-stating exactly where least is known. The component that receives
the delivery is the only party that knows which format arrived, so it now
states the new portion outright, and for a format that cannot say, it states
**none**.

**It has to be funding for the days this figure governs.** Every day the
delivery covers must be at or after the day that chain switched into the
coordinated mode. Funding for earlier days belongs to the ordinary schedule,
which this figure does not govern.

A delivery failing either test is **recorded as uncounted**, not discarded.
The tokens still arrive and are still counted in the overall received total;
what changes is that they do not widen this particular figure. That matters
because both exclusions are otherwise invisible: an uncounted delivery moves
real value and changes nothing else, so without a counter the only symptom
would be payouts waiting on funding an operator can watch arriving. The two
totals are published together and always account for the whole non-recycled
delivery between them, so they can be reconciled against what was actually
sent.

One case is deliberately conservative. A delivery whose days **straddle** the
switch is refused whole rather than split: the main chain decides day by day
but sends one combined amount, and nothing at the receiving end can divide it
again. Guessing would over-state. Refusing under-states, which delays a
payout; over-stating would pay out funding nobody sent. The uncounted total is
what makes the difference visible instead of silent.

### What this is not, and why the obvious next step is missing

These are **receipts**. They say what arrived and how it was attributed — not
what remains, and not a limit on anything.

The tempting shortcut is to subtract lifetime payouts and call the remainder
headroom. That is wrong twice over, and an earlier version of this change was
withdrawn for doing it. Lifetime payouts mix ordinary-schedule payments — which
no delivery funded — with coordinated-mode ones, and no single starting point
separates two sources inside one running total. Fixing that by noting the
payout figure at switch-over made it worse, not better: it left funding that
had been *delivered and already spent* before the switch reading as still
available, because the note erased the spending while the receipt survived.
That direction over-states, which licenses the very payout the figure exists
to prevent.

So the *paid* half is not derived here at all. It needs the amount paid **for
coordinated-mode days specifically**, which the payment path does not currently
report — a payment trimmed by a per-loan ceiling keeps its full obligation on
record while the amount actually transferred sheds the trimmed part, so no
combination of what it reports is the sum that moved. That lands with the step
that consumes it, alongside the deferral rule below, rather than being guessed
at now.

### What comes next, and why this cannot be used yet

Secondary chains do not currently price reward days in the coordinated mode at
all — that is deliberately blocked, and the block cannot lift until a separate
problem is solved (a day the main chain deliberately funds at zero would
otherwise be permanently closed out at zero, before the compensating payment
can reach it). Until that lifts there is nothing for this budget to limit,
which is why this lands as accounting with no consumer.

When it is applied, a shortfall must **postpone** the day rather than pay a
reduced amount. The existing shortfall behaviour trims and moves on, which is
right against the lifetime cap — that ceiling only ever falls, so a trimmed
remainder can never be funded later. A delivered budget is the opposite: it
**grows every time more funding arrives**, so trimming would permanently
underpay a day whose funding was merely still in transit.

## Thread — P2-w1: the V3 broadcast carries the day's frozen lapse clock (PR #1632)

First build slice of the #1434 P2 zeroed-day lapse mechanisms (design
record: Vpfi1434P2ZeroedDayMechanismsDesign.md §1.1/§1.2, slice 1 of §8).
The Base→mirror day broadcast gains a NEW wire generation that carries the
day's finalization clock facts: the finalization timestamp, the
lapse-schedule version in force at that moment with its two parameters
inline (lapse window, dispatch-cutoff gap), the destination's
deliberately-zeroed marker, and the identity of the Base deployment that
finalized the day. Every one of those facts is frozen ONCE at
finalization and only read back at send, so re-broadcasting a day is
deterministic by construction — an operator clearing the zeroed chain's
remit-ineligibility or creating a newer schedule version between two
sends can no longer change what the wire says. The old wire generation
stays accepted unchanged: an in-flight pre-upgrade packet still applies,
just without a clock, and a day finalized before the upgrade keeps
broadcasting on the old wire (it has no authentic clock to send).

The lapse schedule itself becomes a versioned, append-only table behind a
bounded admin setter (window 3–30 days, gap 6 hours–7 days, window at
least 48 hours above the gap — a version that would place the dispatch
cutoff at or before finalization is refused, never stored). Each
finalized day prices its clocks under the version frozen at its
finalization forever.

Mirror-side, the new ingress installs the clock beside the day's figures
with three protections: two-layer era binding (the packet must name the
mirror's explicitly configured current Base deployment — fail-closed
while that configuration is unset, since the per-day record cannot
defend a day's first install against a retired deployment's delayed
packet after a rotation — and must match the day's recorded era where
one exists), a divergence check extended to every frozen clock fact on
re-delivery, and a clock-backfill branch for days whose figures were
already applied by the old wire — it verifies only the immutable global
pair, writes the clock, and performs the same idempotent reservation
repair the ordinary re-delivery path performs (from the day's stored
figures, never the packet's), so the one supported migration sequence
stays healable without leaving a healed day under-reserved.

Two operational closures from the review's second round: the era ground
truth is armed by the standard deployment spell (with the canonical Base
Diamond address now part of the mirror-chain deployment environment —
warned on testnet, required on mainnet), and the old-wire cross-era
channel is shut — an armed mirror records era provenance on every
old-wire apply, and a genuine era rotation permanently retires the old
wires' fresh applies (their packets carry no sender identity, so after a
rotation only the clock-bearing wire can introduce new days). The
rotation ceremony — drain old-era broadcasts, heal era-unknown days,
rotate every mirror's ground truth, heal old-era days by ceremony — is
recorded in the CCIP cutover runbook. The review's third round closed
the last three gaps in that family: a rotated mirror also refuses clock
facts for days applied before it ever armed (their era cannot be told),
the heal's standing test consults the frozen zeroed marker so an
operator reconciliation never strands a zeroed destination, and the
mainnet deploy enforces era arming on the transaction-producing phase
itself rather than only in preflight.
A new permissionless single-destination re-broadcast heals a clockless
day even for a mirror that has been removed from the current broadcast
destination list, admitted on the destination's day-scoped historical
standing.

This slice is wire + storage only: the lapse terminals, the zeroed-day
suppression gate and the compensation remit tag are later slices
(w2–w4). Until they land, the clock facts are recorded and verifiable
but nothing lapses and no pricing changes. Part of #1434 (P2); the
umbrella recycling programme is #1349.

## Thread — P2-w2: the compensation remit classifies at the mirror, and quarantined value is reserved (PR #1634)

Second build slice of the #1434 P2 zeroed-day lapse mechanisms (design
§1.3, §2.2, §4.1 — slice 2 of §8), and the slice the halt lift is
sequenced behind. The manual-compensation remit now travels on its own
wire shape: a new tagged payload carrying exactly one zeroed day, the
authenticated per-side amounts (the operator sizes lender and borrower
separately — a single scalar would leave the mirror solving for a side),
and the day's frozen expiry inputs read back from the finalization-time
freeze, so the mirror can classify the arrival even when the compensation
overtakes the day's own broadcast. Ordinary batch remits keep the
existing wire unchanged.

Mirror-side, a new classifying ingress replaces blind booking for
compensation deliveries. Era first: a day whose broadcast state is known
accepts the compensation only from the deployment matching the day's
recorded era, only if the day was genuinely zeroed out of its finalized
denominator, and only before any lapse; every other arrival is
QUARANTINED token-safely — the tokens are accepted into a new
arrival reservation (never reverted: a revert would be re-executable into
the same revert forever) with a receipt-keyed record naming why, awaiting
the return path a later slice adds. A day whose state is unknown — the
overtake case — credits PROVISIONALLY under the payload's authenticated
sender as the assumed era; the day's broadcast later confirms the credit
in place or demotes it wholesale to the reservation, moving the
armed-fresh counting with it so the funding reconciliation identity
survives.

The reservation is the claim exclusion the halt lift requires: the single
backing definition both claim-enforcement sites read now subtracts it, so
an ordinary fresh claim can no longer spend quarantined tokens that are
promised back to the canonical chain. The transparency snapshot publishes
the reservation, and the mesh watcher gains a matching critical check —
balance must cover bucket plus reservation — with the standing
skip-on-unknown discipline for chains whose lens predates the widened
snapshot shape.

The review rounds pulled the dispatch cutoff INTO this slice: because
the mirror now evaluates expiry directly from the frozen clock words,
"no arrival can lapse before the terminals ship" stopped being true — so
the canonical chain refuses to dispatch a compensation within the
cutoff gap of the day's frozen expiry, and refuses clockless days
outright (they can never settle; pre-clock days belong to the later
legacy migration). The post-lapse quarantine branch driven by the
terminal FLAGS exists now but stays unreachable until the terminals
arm; the clock-based expiry quarantine is live. Part of #1434 (P2);
umbrella #1349.

## Thread — P2-w3: the mirror quotes its own compensation, and a funded day reprices (PR #TBD)

Third build slice of the #1434 P2 zeroed-day lapse mechanisms (design
§1.4, §1.5, §2.1, §2.3 — slice 3 of §8). The compensation's sizing
input now originates where the evidence lives: the zeroed mirror
itself. A permissionless, batched accumulator walks the day's own
reward entries and prices each at the counterfactual fair share — the
delta the chain would have priced at had its report made the day's
finalization — computed entirely from finalization-frozen data, with a
conservation identity proving the walk covered every entry before the
quote may dispatch. The quote is deliberately UNCAPPED — the sum every
settlement path is bounded above by, because forfeit settlement prices
without the per-user ceiling by design — while each payment still
applies its own path's ceilings; an admin reset valve recovers a day
whose permissionless accumulation was mis-ordered, and a day whose
frozen pool figures have not arrived refuses to quote rather than
wrongly resolving to zero. The day-level funded pool figure now
travels to every mirror on the day's own broadcast — a zeroed chain's
own funding slice is deliberately zero, so the day-level figure is the
only faithful pricing input — and a re-send of the broadcast heals any
day delivered before the figure joined the wire. The quote travels to the canonical chain on its own wire
kind and lands as evidence, never funding: manual compensation for a
quoted day is bounded per side by the standing quote, an unquoted day
cannot be manually funded at all, and a both-sides-zero quote resolves
the day terminally on the mirror before dispatch while clearing the
canonical chain's manual-funding anchor — nothing to compensate. The
standing quote is bound to the sending deployment's identity, stamped
into the wire by the messenger itself: a re-delivery from the same
deployment refreshes it, a divergent one is refused, and an operator
clear releases a stale binding after a mirror redeployment — so a
delayed wire from a retired deployment can never overwrite newer
evidence or spuriously clear a day's funding anchor.

The repricing closes the loop the earlier slices left open: a funded
compensated day now prices through the ordinary claim machinery at the
same quoted delta — one shared implementation feeds the quote, the
pricing fold, the commitment report and the payment decomposition, so
the quoted figure and the paid figure cannot diverge. The day becomes
payable only once its delivered per-side pool covers that side's full
quoted sum, a wait keyed on the amount present rather than any message
arrival; an underfunded day defers whole (never a trimmed payout), a
lapsed day retires at zero with its loss recorded at the lapse, a
resolved-zero day prices zero, and an open zeroed day keeps deferring
so no reward entry is silently retired while compensation is still
possible. This includes the constraint-17 day whose excluded
denominator is zero — the case the ordinary pricing can never reach —
which now pays under the mirror's own local denominator. Ordinary
armed mirror days are untouched: the blanket mirror pricing halt
stays exactly where it was until the halt-lift slice. Part of #1434
(P2); umbrella #1349.

## Thread — P2-w4: the lapse terminals, the one-in-flight gate, and the supplemental top-up (PR #TBD)

Fourth build slice of the #1434 P2 zeroed-day lapse mechanisms (design
§3, §5.1, §5.2, §2.5 — slice 4 of §8). The deferral states the earlier
slices created now have guaranteed, permissionless exits.

A never-compensated zeroed day whose frozen expiry passes takes the
FULL lapse: it retires at zero through the ordinary pricing machinery,
the cursor advances past it, and the loss is recorded at the terminal
itself — from the completed quote when one stands, else from the
accumulator's partial progress flagged as partial, never by an inline
scan that could make the guaranteed terminal itself run out of gas.
The record is non-blocking bookkeeping: it gates nothing and a later
completed accumulation may refine it.

A compensated day still funded below its quote after a bounded
deadline takes the SHORT lapse: pricing switches from
defer-on-shortfall to a pool-scaled delta, so every settlement path
pays proportionally within delivered funding and the cursor advances.
The deadline is absolutely bounded — a rolling window that only a
quarter-of-the-shortfall top-up extends, under a hard three-window
cap — so neither operator silence nor dust top-ups can park a day
(and every day behind it) unclaimable forever.

On the canonical chain, compensation dispatch gains the one-in-flight
gate: one outstanding compensation reservation per chain, cleared by
the consumption acknowledgement (or its operator-evidenced
equivalent), held by cancellations, with an enumerable
outstanding-chain inventory for rotation ceremonies. A consumed but
short delivery (fee-on-transfer, partial burn) now has its intended
remedy: the supplemental top-up funds the SAME receipt-bound
obligation — bounded per side by the standing quote cumulatively
across the original remit and every supplement — without touching the
day's closed markers; the mirror's deferral absorbs it naturally.

The activation precondition for these terminals is the legacy
migration: a pre-P2 manual remit carried neither the tagged wire nor a
per-side split, so an upgraded mirror could hold its value without a
priced compensation. An operator-evidenced stamp allocates such a
receipt pro-rata over the day's completed quote (one receipt, one
day), and a paginated canonical-side inventory lists reservations
matching the legacy shape — the arming checklist requires it to read
empty. No deployed environment holds any such receipt today.

Fitting the new surface within contract size limits also split the
remittance facet three ways: a read-only lens facet took the ledger's
view surface, a compensation-dispatch facet took the manual +
supplemental pair, and the shared dispatch primitives moved to one
library so the facets cannot diverge on them. Part of #1434 (P2);
umbrella #1349.

## P2-w5 — the stranded-compensation return and the recovery position (#1434 R4)

A compensation that a mirror had to quarantine (wrong era, expired
window, conflicting arrival) is no longer a dead end. Anyone can now
send the quarantined value home to Base over the shared return channel —
the record on the mirror is the evidence and the caller only pays the
message fee. Returns are sent in caller-chosen chunks bounded by the
record's remaining balance (the destination lane has a transfer ceiling
the mirror cannot read, and a single indivisible send above it would be
permanently undeliverable), with the remainder staying retryable; the
caller can neither redirect a chunk nor send more than the record
holds, and the wire itself carries the record's remaining balance so
the canonical chain can tell a partial return from the final one.

On Base, the returned value lands in a new **recovery position**. The
credit is strictly bounded: it must arrive from the chain the original
remittance was sent to, and it can never exceed what that remittance
dispatched — anything above that entitlement is parked in an
operator-visible overage ledger rather than credited (or bounced).
Receiving a return also settles the "one compensation in flight per
chain" gate for that chain, so a replacement can be funded.

The position exists to be re-spent, without double-charging the reward
budget: a replacement compensation (manual or supplemental) can be
funded **from the recovery position**, bounded by the position's
balance, and the lifetime reward-budget cap is not charged a second
time — the returned parcel already paid its charge at the original
dispatch. Reservations funded this way are marked, so no later
bookkeeping can "restore" budget headroom that was never consumed.

Returned tokens sitting on Base are earmarked away from ordinary reward
claims (the same protection quarantined arrivals already had on
mirrors), the transparency snapshot publishes the new earmark, and the
mesh watcher alarms if the Diamond's balance ever stops covering it.

## Thread — Retiring the LayerZero-era backup binding (PR #1450)

The nightly off-chain backup was still exporting a second database
belonging to the retired LayerZero monitor. That monitor's Worker was
deleted earlier: after the move to Chainlink's cross-chain transport it
had been polling a decommissioned stack every five minutes, including one
surface that the securities-feature excision had removed outright.

Its database survived the Worker, and looked orphaned but was not — the
nightly backup still bound and read it. This removes that binding, so the
backup covers only the shared archive database.

Nothing of value is lost. The database held alert de-duplication state and
per-chain block cursors for a transport that no longer exists — operational
scratch space, not records. Manifests written before this change still
list their LayerZero section and remain readable; a manifest describes the
run that produced it, which is the behaviour a restore should expect.

**Deliberate ordering, and the reason it matters.** Deleting the database
first would have broken the nightly backup, and broken it *quietly* — the
failure would surface at 03:17 in a job nobody is watching, not anywhere
obvious. So this change ships and runs one clean nightly first; deleting
the database is a separate operator step afterwards, and irreversible.

Also corrected while here: several comments still described the retired
monitor as holding one of the account's scheduled-job slots. It was freed
when the monitor was deleted and is currently **unused** — the recycling
mesh watcher is its intended occupant but has not been deployed yet, so
anyone planning capacity from those comments would have believed the
account was full when it has a slot free. The comments that attributed the
slot cost to creating a database rather than to deploying a scheduled
service were corrected in the same pass.

Two further hazards surfaced in review and are closed here. The
disaster-restore runbook still told an operator to recreate the retired
monitor's database, wire it into config, and deploy that monitor — on a
real restore that would resurrect a decommissioned service and consume one
of the account's five scheduled-job slots. And the retired monitor's own source tree
was still deployable by its documented command. Review then established
that **no configuration edit can make a source tree undeployable** — every
guard sits inside the artifact an operator overrides, and removing the
config is worse still, because the tool then inherits a parent one and
deploys under the wrong name. So the tree was **deleted outright**. Git
history is the rollback path; there is no retained copy in the working
tree.

The archive format keeps its version number. Nothing about the shape
changed except that one optional section is no longer produced, so bumping
the version would force restore tooling to branch for no benefit — the
runbook now states plainly that the section is optional within the current
version, and how to handle an older archive that still carries it.

Review of those runbook edits then turned up several procedures that were
already wrong independently of this change, and they are corrected here
rather than left for the incident that would find them:

- The credential-rotation sequence destroyed the working bot token as its
  first step and only afterwards went looking for where to write the
  replacement. Telegram allows no overlap — revoking a token is what
  issues its successor — so the outage cannot be removed, only shortened.
  Everything that does not need the new credential now happens first, and
  exactly one command runs during the outage.
- Rotating the notification signer changes which channel the platform
  publishes to, but the procedure left the app pointing users at the old
  one. Anyone opening the alerts page would have subscribed, successfully
  and silently, to a channel that would never post again. Updating the
  app is now part of the main path rather than a footnote to a fallback.
  The procedure was also built on an operation the notification service
  does not implement. It described transferring ownership of the existing
  channel to a replacement identity, with a fallback for when the
  compromised wallet refuses to co-operate — but there is no ownership
  transfer to attempt, so there was no fallback either, just one path
  presented as two. Rotating the signing key always changes which
  identity the platform posts as, and the service will reject posts from
  an identity it has no record of. So the procedure is now written as
  what it is: a migration to a newly created channel, which costs a stake
  and does not bring existing subscribers with it. Both facts are stated
  up front rather than discovered mid-incident.
- The disaster restore claimed both public websites carried their own
  domain attachments. They do not — they are plain Worker deployments,
  so a restore that followed the steps exactly brought the platform back
  with neither public address resolving, and the redirect that serves the
  `www` hostname is a zone-level rule that travels with nothing at all.
  Each binding is now listed explicitly.
- The restore also smoke-tested the backup writer one section before
  deploying it, and offered to import the retired monitor's rows into a
  database whose table definitions were deleted along with the monitor.
  Both now sequence correctly, and the schema is recovered from history.
- Two credential lookups listed the account's secrets with the default
  page size, which is smaller than the number of secrets held — so the
  one being rotated could simply be absent from the output, with nothing
  to indicate the list had been truncated.
- The restore deployed all three background services at the point where
  it created their databases — which starts their every-minute scheduled
  work immediately, hours before the data those schedules read has been
  restored or checked. The consequences were not symmetric and not all
  harmless: the event reader would begin recording from wherever it found
  itself and then be reset out from under itself; the alerting service
  would start messaging users from half-imported thresholds, because its
  alert duties are not behind the switch that holds back its
  transaction-signing duties; and the retention passes would begin
  deleting expired rows from tables still being imported one at a time,
  before the row-count check meant to confirm the import could see them.
  The restore now deploys all three with their schedules switched off and
  re-arms them in stages, each once its own data is verified — the same
  discipline the nightly backup writer already had a warning for, applied
  to the services that read rather than write.
- The restore rebuilt every credential but nothing restored the
  operational switches that decide whether the platform's autonomous
  duties run at all. They are not in the archive and are not committed to
  the repository, so a restore could finish with the signing key in place
  and every autonomous duty silently off — indefinitely, and looking
  exactly like a deliberate configuration. They are now part of what an
  operator is told to keep offline, with an explicit re-arming step that
  runs last, after the smoke test.
  How they are held was checked against the live deployment rather than
  assumed: the keeper's main switch is a per-Worker **secret**, not the
  plain configuration value an earlier draft of this note described. That
  also retires this note's earlier warning that an ordinary redeploy
  undoes them — it does not, because secrets are not rebuilt from
  committed configuration. The consequence that does matter is the
  opposite one: a secret's value cannot be read back afterwards, so the
  offline capture is the only record that will ever exist of it.
- A verification aid added earlier in this change logged the recipient of
  every successful notification. That branch is routine — it fires for
  every alert the platform sends — so it would have built a standing
  record of which wallet was notified when, as a side effect of making a
  key rotation checkable. The recipient is no longer logged; the channel,
  which is the field a rotation actually changes, still is. The failure
  branch keeps the address, where it is the diagnostic and the volume is
  exceptional.
  Removing our own line turned out not to be enough, and review caught it:
  the notification library we use logs its whole outgoing request — wallet
  address included — just before sending it, so the standing record was
  being written regardless of what our code did. That library line is now
  filtered out, narrowly, by matching the exact text it prints, so nothing
  else logged at the same moment is lost. Both services that send
  notifications carry the same fix.
- The compromise inventory said every credential it lists is held by both
  public-facing services. Three entries are not: the keeper's signing key
  belongs to one service alone, and two of the per-chain endpoints are
  held by services the section does not even name. A responder reading it
  would have scoped both the exposure and the post-rotation check to the
  wrong set. Each entry now names its actual consumers. Further down, the
  same document still explained at length why the two services keep
  *separate* copies of a shared credential — the pre-split arrangement,
  and the exact opposite of how they are configured now. That reasoning
  is marked superseded and replaced with what shared storage actually
  implies for an incident: exposure is shared by default, one rotation
  covers every consumer, and the per-service rotation command updates
  nothing.
- The Telegram rotation put the freshly minted replacement token into a
  command line, one step after taking care to accept the same token
  through a prompt so it would not be recorded. That wrote it into shell
  history and into the process list, where any other user of the machine
  could read it — undoing the precaution and leaving the credential
  behind on the workstation an attacker was just evicted from. The
  request is now assembled so the token reaches neither.
- The instruction to confirm the schedules were really switched off named
  a command that cannot see schedules — it reports deployments and
  versions. It would have shown a healthy deployment while the
  every-minute schedule was still live, which is precisely the mistake
  the check exists to catch. Replaced with a schedule-aware query.
- The restore told an operator to copy every saved credential straight
  into the replacement account — correct after a lockout or a billing
  dispute, and exactly wrong after a compromise, which the same document
  now explains: anyone able to edit the services can read every one of
  those values. Following it would have handed the rebuilt platform back
  to whoever caused the incident, with the cutover reading as a clean
  recovery. The step now branches on *why* the restore is happening, and
  the compromise branch is a rotation rather than a restore, naming each
  credential and what rotating it costs.
- The canonical key inventory said the keeper's signing address holds no
  on-chain authority at all, and told a responder to replace the secret and
  sweep the old address's remaining balance. Both parts were wrong: the
  address can hold a role granted on every chain, and separately be the
  named party for reward remittance — a distinct authority the role does not
  cover. Following that row would have left a stolen key able to make
  risk-affecting configuration writes and move reward budget after an
  apparently completed rotation. The row now describes a revocation, on
  every chain and for both authorities, with the balance sweep demoted to
  housekeeping.
- The step that re-arms the remittance duty verified the wrong permission.
  It checked the role on each secondary chain, which is correct for two
  other duties and says nothing about remittance — that authorises against
  its own separately configured address. An operator could confirm
  everything the step asked and still enable a duty whose every attempt
  fails silently. It now reads back both.
- The recovery reused the internal operations bot token verbatim after a
  compromise. That token was as readable as any other, and it authorises
  posts to the operators' own channel — so retaining it lets an intruder
  spoof backup outcomes, health verdicts and ticket alerts *throughout* the
  recovery. Those are the signals the operator is acting on while working,
  which makes it worse than the user-facing equivalent, and it was missed
  because it is held differently from the credentials the section is
  otherwise organised around.
- The recovery also published both public sites and the API host
  immediately after the first deploys, hours before the database is
  restored and checked. Visitors would have found a working-looking site
  with no history on it — and, because disabling scheduled work does not
  disable request handling, could have created new records while the
  archived ones were still being imported, mixing fresh rows into a restore
  whose row counts were about to be verified. Those hostnames are now bound
  in the existing later step that already exists for the purpose.
- The compromise branch above told an operator to replace the signing key
  and sweep the old one's remaining gas. Sweeping gas is housekeeping, not
  revocation: the old address keeps every permission it held, and anyone
  can fund it again for pennies. Worse, there are **two** separate
  authorities and revoking one leaves the other — the remittance duty
  authorises against its own configured address, not the role, so an
  attacker whose role was revoked could still move reward budget. The
  branch now revokes both, on every chain rather than only the secondary
  ones, and says to read both back before re-arming.
- The archive-selection guidance was checked against the live backup
  storage rather than reasoned about, and two of its assumptions turned out
  to be wrong in the unsafe direction. It had said the naming scheme
  guarantees a forged archive cannot displace the genuine one, so two files
  under one date would be evidence of tampering. In fact a forgery can be
  written at the genuine file's own name, and at the time this was found the
  storage deleted a superseded copy about a day later — so the original did
  not persist as something to fall back on, and finding a single copy is not
  evidence of safety. That deletion window has since been widened
  considerably, which is what makes the older copy a usable fallback at all;
  the recovery step now reads the current figure from the stored
  configuration rather than restating it. The step now inspects versions rather than files, says
  so explicitly, and records that the daily series only reaches back about a
  month, so a compromise older than that leaves the monthly copies as the
  only candidates. Making forgery impossible rather than detectable is a
  storage-configuration decision and is filed separately.
- The archive-selection flow reads "take the most recent one that
  verifies". After a compromise that is the attack. Whoever can read the
  services holds both the storage write credential and the encryption key,
  so they can upload a *newer* archive of their own choosing that is
  correctly checksummed and genuinely decrypts — every check in that
  section passes, and the newest-first rule selects it. The checks prove
  the file is intact and encrypted under our key; they cannot say who
  encrypted it, and nothing downstream re-establishes that. Selection is
  now by *time* rather than recency: rotate the storage keys first,
  establish the earliest possible compromise moment, choose an archive
  safely before it, and accept the extra data loss. And re-encrypting the
  history under a fresh key,
  previously recommended, is explicitly deferred until after selection: it
  launders a poisoned set into the new key and destroys the one signal that
  distinguished it.
- Switching off the scheduled work was not enough to hold the event reader
  still: it has a second writer. A committed flag routes incoming webhook
  deliveries through a durable object that runs the same indexing, so the
  moment the replacement address answered, pre-existing webhooks would
  resume writing and advancing the cursor — the very race the schedule
  change was meant to prevent, arriving through a different door. Both
  writers are now closed together and re-opened together, after the cursor
  reset.
- One restore step was described as safe to run early because the
  background service only reads and sends messages at that point. One of
  its passes signs transactions on the strength of the key alone, without
  consulting the master switch — so the step could broadcast from a
  freshly re-uploaded key before anything had checked it, and within a
  ten-minute window each day it would. That service's schedule and its
  switches now move together at the last step, and the missing guard in
  the code is filed separately.
- The restore also claimed two prerequisites for the remittance duty had
  to be rebuilt. Neither does: the database change is committed and
  applied by an earlier step, and the on-chain permission lives on chain
  and survives losing the account entirely. Left as written it would have
  kept remittance switched off indefinitely while it was ready to run. The
  step now says to verify both, and reserves rebuilding them for the case
  where the signing key was actually replaced.
- Three documents pointed at an application address that does not exist —
  the page was moved when the routes were flattened, and the only
  surviving compatibility path is an unrelated one. An operator verifying
  a notification-channel migration would have landed on a blank page and
  been unable to confirm the thing they were checking.
- The advice on restoring the background service's operational switches was
  checked against the deployed service and turned out to describe something
  the deployment does not do. The switches are held as secrets, not as
  ordinary configuration values, so the deploy-time behaviour the earlier
  advice worked around does not apply to them — and following that advice
  would have introduced the very fragility it was trying to avoid, by
  creating an ordinary value alongside the existing secret. The step now
  restores them the way they are actually held, and says plainly that the
  service's own configuration comment describes them incorrectly, so a
  reader trusts the readback rather than the comment. Correcting that comment
  is filed separately. The same check answered a question that had been left
  open: the service is armed, and the two reward switches are absent, which
  is correct while that programme is pre-activation.
- Both credential rotations end by redeploying the keeper, and this note
  previously warned that a plain redeploy of that service deletes the
  switches deciding whether its autonomous duties run at all. **That
  warning was wrong and is withdrawn.** Checked against the live
  deployment: the main switch is held as a per-Worker secret, and secrets
  are not rebuilt from committed configuration, so an ordinary redeploy
  does not touch them. The advice that accompanied the warning — move the
  switches into committed configuration — would have been the one change
  that made the described failure possible, so it is withdrawn too. What
  is true and does matter: a secret's value cannot be read back
  afterwards, so the offline record of what it was set to is the only one
  that will ever exist.
- The document justified keeping a scoped backup-read credential inside a
  service on the grounds that it can only reach encrypted data, with the
  decryption key held offline. That is true if the storage provider is
  breached and false if the cloud account is: the same service also holds
  the decryption key, so anyone able to edit it can take both and read
  every archive in the clear — including the uploaded legal documents.
  The claim is now stated accurately, with the boundary it really
  provides, and separating the two is filed as a design decision to make
  before mainnet.
- The check on whether the restore had re-armed the autonomous duties
  read the service's log output. Every one of those duties returns
  silently when its switch is off *and* when it is on with nothing to do,
  so silence proved nothing and a restore could finish with remittance or
  reporting still dark. It now reads the deployed configuration back
  directly. Writing that up turned up a trap worth stating: the main
  switch accepts any capitalisation while the two it gates accept only
  lowercase, so one spelling arms one duty and silently skips the others.
- Two more credentials were being typed onto command lines — the
  Cloudflare recovery token, in a check added earlier in this same change,
  and the third-party marketplace key, whose surrounding text claimed a
  prompt would appear while the command as written suppressed it. Both now
  use the prompt-and-stdin pattern, so neither reaches shell history or
  the process list.
- The resilience plan listed the nightly backup writer among the services
  a paused copy in a second account could take over. It cannot: its
  database and object-store bindings can only address resources in the
  account it runs in, so a standby copy is attached to that account's
  empty storage rather than to the lost data, and unlike the others it
  has no address or switch to redirect. Its recovery is the restore
  itself, which is why it is deployed last. Described that way now.

Part of #1440. The card stays open for the operator steps: redeploy,
confirm one clean nightly, then delete the database.

## Thread — Migration numbers are now checked for uniqueness (PR #1449)

The indexer's migrations directory is the single source of truth for every
table on the shared archive database, specifically so a fresh environment
can be built by replaying it in order. An audit found two migrations
sharing the number `0011`.

Nothing was broken, and nothing needed repairing on any existing
environment: the database keys its applied-migrations record on the
filename rather than the number, so both files ran and neither was
skipped. The latent problem is replay order on a *fresh* environment.
Pending migrations are applied in alphabetical order, so a colliding pair
replays in whatever order their descriptive names happen to sort in —
which need not be the order production actually experienced. The existing
pair is order-independent (one creates a table nothing else in the pair
touches, the other adds an unrelated column), so today it is harmless. The
next collision might not be.

A check now fails the build when two migrations share a number. The
existing pair is recorded as a deliberate exception with its reasoning
written down next to it, because the obvious tidy-up is the wrong move:
renaming a migration changes the key the database recorded it under, which
makes it re-run everywhere it has already been applied. For a
non-idempotent statement that fails the whole apply. The check also flags a
stale exception — one whose collision no longer exists — so the
exception list cannot quietly accumulate entries that would mask a real
future clash on the same number.

Two ways the exception could have been too generous, both closed. It is
recorded against the exact pair of filenames rather than the number alone,
so a *third* migration landing on that number is still reported — otherwise
the guard would have been blind to precisely the clash it advertises
catching. And migrations are grouped by their sequence *number* rather than
the literal text of the prefix, because the tool that applies them parses
the number: two files whose padding differs are one sequence to it, but sort
apart in an alphabetical replay. A four-digit prefix is now required as
well, so the two groupings coincide and the numbering stays readable.

While auditing: two migrations are pending on the live staging database,
and that is correct rather than drift. Both belong to the cross-chain
commitment work and applying them is an activation step, not routine
housekeeping.

Closes #1441.

## Thread — Two untested paths in the three-chain mesh harness (PR #TBD)

The end-to-end mesh suite exercises three real deployments talking to each
other, but two operationally important paths ran at zero in every case it
contained. Both are now covered.

The first is the platform funding a chain that cannot fund itself. Reward
funding resolves in two passes: each chain covers what it can from its own
recycled balance, then the canonical chain tops up whatever is left over
from its remaining balance. Every existing scenario gave both mirror chains
far more than they needed and gave the canonical chain nothing to fund
with, so the second pass never ran once. A change that disabled top-ups
altogether, or booked their reservation against the wrong ledger, would
have passed a suite calling itself a three-chain end-to-end test — while
underfunding any live chain whose own balance fell short.

Getting a shortfall to occur at all is the interesting part, and it is why
this sat undone. A chain's spare capacity and its share of the reward
target are coupled through the same figure: what it reports having
absorbed. Simply giving a chain a smaller balance also shrinks its
contribution to the protocol-wide absorption average, which shrinks the
target the shortfall would be measured against, and the gap closes itself.
The fixture keeps the daily absorption feed high while the balance stays
low, so a genuine gap survives.

The two passes are pinned separately rather than by their total, which
could not tell them apart. The canonical chain is given a balance but **no
reward demand of its own**, so its reservation consists entirely of top-ups
for others; the other mirror stays comfortable, so it contributes nothing
to that pool. Removing the top-up pass fails this test and nothing else.

The second path is a missing day closed the way operators actually close
it. An existing case drops a chain's report and immediately accepts the
next day, leaving the incomplete day open forever. In practice the day gets
force-closed: the silent chain is dropped from that day's totals and marked
ineligible for remittance pending reconciliation, and only later does a
fresh report restore its capacity. The interaction between those two was
untested.

What this pins is that the day-4 exclusion **survives** the later healing.
Capacity recovering must not quietly re-admit a chain to a day's totals it
was never part of — those are separate facts about separate days. Worth
recording that the ineligibility marking only happens on an armed day,
since that is when there are commitments to be remitted at all; an unarmed
fixture exercises only the weaker half.

Closes #1442. Test-only — no platform behaviour changes.

## Thread — Making the recycled-bucket books externally verifiable (PR #1448)

The mesh watcher shipped with two gaps its own README recorded as known
limitations. Both came from the same root: every figure the watcher could
read was one the contracts **derive**, and a derived figure cannot be used
to check the derivation that produced it. This change publishes the small
number of raw counters needed to close both, and tightens the watcher to
use them.

The first gap was bucket coverage — the check that a chain's recycled
balance actually backs the commitments reserved against it. On a receiving
chain that relation is hard, and the watcher pages on it. On the canonical
chain it was not, because of a deliberate design decision elsewhere:
releasing a remittance whose message can verifiably never execute restores
that day's funding commitments but does **not** re-credit the balance,
since the sent tokens are sitting in the transport's custody, outside the
platform's. That is the correct conservative behaviour, and it meant the
canonical chain could legitimately show a shortfall — so the check could
only be reported as an advisory there, which is to say it could not page on
the one chain that funds every other. The platform now records how much
backing each release stranded, so that amount counts as backing that exists
and is in transit. One strict rule now covers every chain, and the
role-based exception is gone rather than documented. The funding gate is
deliberately left alone: a day whose backing was stranded still cannot fund
until recovery. Whether something is a fault and whether it may fund
another day are different questions, and only the first is answered by
knowing where the tokens went.

The second gap was more subtle and is the reason this was flagged as worth
closing before mainnet. Each chain reports a lifetime absorption total to
the canonical chain, and the canonical chain's accepted copy is checked
against the chain's own figure to make sure it never runs ahead. That
catches a transport or replay problem, but it cannot catch the reporting
rule itself regressing — because the same rule produces both numbers, so
they would inflate together and stay equal. The rule in question is
load-bearing: it excludes the platform's own already-spent top-ups from
what a receiving chain reports as its own absorption, and without that
exclusion the canonical chain would re-offer its own top-up as the
receiver's local funding and commit it twice. The fix publishes the stored
counters behind that figure, which lets an outside observer do two things
it previously could not: confirm that the totals a chain claims never
exceed where its tokens actually went, and independently reproduce the
published absorption figure. The first catches a counter advancing without
tokens arriving; the second catches the exclusion being dropped from the
derivation. Neither could be caught by the other, and the tests assert that
division of labour explicitly rather than assuming it.

Both were originally expected to need new capability — a pre-exclusion view
plus, for the harder half, reconciliation against the event stream, which
the watcher deliberately does not do (every read it makes is a view call at
a pinned block). Publishing the raw counters turned out to be enough for
both, so the watcher keeps its read shape.

Two corrections came out of review and are worth recording, because both
were cases of the correction itself being subtly wrong. The amount a
release strands is the share that actually left the balance, not the whole
commitment it restores — a partly-sent remittance retires its remainder
without moving anything, so that remainder is still sitting in the
balance and counting it would have credited it twice. And the allowance is admitted
only when two independently-changeable statements of the canonical role
agree — the platform's own record of which chain is canonical, and that
chain's own claim to be. Only the canonical chain can release, but the
role is an administrative setting, so requiring both closes two gaps at
once: a chain demoted after accruing an allowance keeping it, and a
mis-flagged chain granting itself one. A disagreement between those two
statements is now itself a paging alert, because a chain wrongly holding
that flag can close its own reward days and release remittances while the
platform still expects reports from it.

Reviewed further, the checks also gained a mirror image. Verifying only
that the counters do not claim more than the balance received left the
opposite corruption invisible — a transfer arriving and crediting the
balance while the counter that marks it as relocated custody is skipped
makes the original check *looser*, not tighter, and the re-derivation
agrees because it reads the same missing figure. The relation is now
checked in both directions: value in the balance that no counter accounts
for is as much a fault as counters claiming value that is not there. On a
platform upgraded in place, where the historical balance legitimately has
no counter behind it, that reverse direction reports as an advisory
stating the relation is unverifiable rather than either paging or staying
silent — and it resolves itself at the first credit.

Upgrading an existing deployment needed one more thing. A remittance
released *before* these counters existed already restored its commitment
and reversed its payout figure, but nothing recorded how much it stranded
— so both relations would have read as broken, from the first check after
the upgrade, on state the supported path produced. A one-time operator
ceremony seeds that figure. It derives the amount from the platform's own
records rather than accepting one, and refuses outright if the result does
not reconcile both relations, so it cannot be used to quiet a real
discrepancy. Because a long-lived deployment can hold more history than
one transaction can scan, the ceremony runs in operator-chosen chunks
and publishes nothing until the last one completes; and because a
remittance can be released while it is part-way through, it stops rather
than mixing two views of the same range, and can be discarded and
restarted from the current state. It still refuses to run twice, so
no lever edits a figure once published. The operator procedure is in
the Deployment Runbook.

Alongside the amount, the ceremony publishes how many releases were behind
it, so an operator can reconcile the figure against the release history
independently instead of taking it on trust. Two counters sit behind that
tally and both are new, which means a deployment upgraded in place starts
both at zero with real releases already in its past. The scan now repairs
both, not just the amount: without that, the platform would advertise a
"lifetime" release count smaller than the subset the scan had just found,
and an operator following the reconciliation instructions would find it
short by every release that predated the upgrade. It also refuses to go the
other way — a count above what the scan found means the two disagree about
the history, which stops the ceremony rather than being quietly overwritten.

One limitation of that reconciliation is now stated in the runbook rather
than left for an operator to discover: the allowance the scan derives is
*gross*. A remittance released and then delivered late has already handed
over its tokens, yet the scan still counts them as backing held back, so a
successful ceremony can complete over a bucket that is genuinely short by
that amount. A seed proves the published figure agrees with the recorded
reservation history — which is what it is for — not that the tokens are
present. Tracked as #1461.

The redeploy helper also prints those instructions per chain the moment
that chain's upgrade lands, rather than once at the very end of the run. The
instructions are owed from the moment the upgrade takes effect, and a later
step failing — the vault upgrade, or the optional artifact re-export — used
to end the run before anything was printed, leaving an operator with an
upgraded deployment, two alerts inbound, and no procedure.

One incidental finding worth recording: the new reproduce-the-figure check
immediately failed against the watcher's own healthy-mesh test fixture,
because that fixture described a chain reporting less lifetime absorption
than its balance and payouts together imply — a state the contracts cannot
produce. Rather than correct that one fixture, the test helper now derives
those figures from where the tokens went, so no fixture can express an
unreachable state and a future check does not rediscover the same problem.

Closes #1444. Closes #1446. The remaining watcher limitation is #1445 —
nothing verifies that each configured endpoint really is the chain it is
labelled as.

## The mesh monitor now checks that each endpoint is the chain it is configured as

The monitor that watches every reward chain's recycled accounting reads
each chain through an operator-supplied endpoint, paired with that chain's
committed contract address. Until now nothing confirmed the endpoint was
actually the network it was configured for. A single mistyped or stale
setting — a copy-paste during setup, or a value left behind after a chain
migration — was adopted without complaint, and every figure read through
it was recorded under the configured chain's name.

The noisy version of that fault was survivable: reads fail, and the
failure surfaces as a gap in coverage. The quiet version was not. If the
contract address happens to hold compatible code on the wrong network,
every check runs to completion against an unrelated chain's books and the
monitor reports a clean tick. A watcher that is confidently silent about
the wrong subject is worse than one that is merely down, because nothing
downstream has any reason to look.

Each tick now asks every endpoint which chain it is and compares the
answer to the configuration. A disagreement is reported as its own kind of
problem, separate from an unreachable endpoint — the distinction matters
because the endpoint here is working perfectly, so every instinct about
providers, quotas and outages is the wrong one, and the fix is the
setting. The message names both the chain that was expected and the chain
that answered, so the wrong setting is identified rather than merely
suspected.

What happens next depends on which chain it is. A mismatched secondary
chain is dropped from that tick and compared against nothing — the same
treatment a chain serving an old block already gets, and for the same
reason: comparing an unrelated chain's ledger against the main one would
raise a false alarm of the most serious kind. A mismatch on the **main**
chain stops the tick outright, because every figure the tick rests on is
read through that one connection; a wrong main chain does not weaken the
result, it voids it.

The check rides along with a request each path already makes, so it adds
no waiting.

One limit is worth stating rather than leaving to be discovered: the
tests cover the identity check itself — that it detects a mismatch, names
both chains, keeps the distinction from an unreachable endpoint, never
leaks the endpoint's credentials into an alert when it fails, and never
aborts the run. They do not cover the surrounding wiring, which has no
test harness able to stand in for real network connections. That part is
reviewed rather than tested, and it is now the monitor's remaining
untested seam.

Closes #1445. Follows from #1443, under the #1222 mesh work and the #1349
umbrella.

## Thread — reward claims can no longer spend the recycle pool's backing (PR #TBD)

The protocol holds one pool of its own reward token that two separate
books draw on: the recycled pool, topped up by fees the platform
absorbs, and the scheduled reward allocation. A claim that mixed the two
was subtracting only its recycled part from the recycled book while
paying the whole amount out of the shared holding — so a claim whose
scheduled part had no funding behind it could quietly be paid out of the
tokens reserved for recycled payouts.

Nothing was ever paid to the wrong person, and no one was paid more than
they had earned — but value did leave protocol custody, because the
tokens that funded the payout were the ones earmarked as the recycled
pool's backing. What broke was the truthfulness of the books: the
recycled pool would go on reporting a balance it no longer held, and the
failure
surfaced much later, on some unrelated recycled claim that could not be
funded — as far from its cause as a symptom can land. The reconciliation
tooling could not see it either, because it reads the recorded figures
rather than the actual holding.

Claims now check, before paying anything, that the scheduled part of a
payout fits within the holding that is not already backing the recycled
pool. A claim that does not fit is declined, and the message says how
much was needed against how much was free.

Declining rather than paying a reduced amount is the deliberate part,
and it is worth explaining because the platform does reduce payouts
elsewhere. The fixed lifetime allocation may be shrunk to fit, because
once that allowance is spent it never grows back — the part that could
not be paid was never going to be payable, so nothing is lost by
settling the claim for less. Backing is the opposite: it is replenished
every time funding arrives. Since pricing a claim also uses up the
entitlement behind it, paying a reduced amount there would quietly
delete the remainder that was about to become payable — turning a
book-keeping fault into a real loss for the claimant. Declining keeps
the entitlement intact, and the same claim pays in full once funding
lands. That is also what the specification already promised for a chain
awaiting funds: recoverable back-pressure, never lost value. This was
checked rather than assumed — an experiment that reduced a payment,
restored funding and tried again found nothing left to claim.

The decline is deliberately distinguishable from the separate case where
the fixed lifetime allocation has genuinely run out, because an
operator's response to the two differs: one resolves itself when funding
lands, the other never does.

Two long-standing gaps that let this go unnoticed are closed alongside
it: an internal note that claimed the protection was already in force
now names where it actually applies, and the test suite now proves the
two books stay separate across a claim that really moves tokens — and
that a declined claim loses the claimant nothing. The only test that had
covered this ground exercised a claim paying out nothing at all, which
cannot demonstrate either property.

One imprecision is recorded rather than papered over: a third, smaller
reservation within the same holding has no running total to subtract, so
the check is a safe upper bound on what is genuinely free rather than an
exact figure. It is the same bound the two pre-existing checks use.

*(Follow-up: a later change found that reservation is no longer taken at
all — the path that collected it was retired earlier — so on a platform
deployed under current rules the figure is exact, not an upper bound. See
the note on giving that figure a single definition.)*

## Nightly backup notification records the full archive fingerprint

The nightly off-chain backup posts an ops summary to the operator Telegram
channel. It used to include only the first 16 characters of the archive's
fingerprint; it now records the whole thing, and the extra characters cost
nothing.

A short prefix is not useless — anyone can fingerprint a candidate archive
and compare the first 16 characters, and two unrelated files sharing them by
chance is vanishingly unlikely. What changes with the full value is the work
required of someone *deliberately* trying to produce a different archive with
the same fingerprint: on the order of 2^64 attempts against 16 characters,
and 2^256 against the whole thing. Recording all of it raises that number.

Three earlier drafts of this paragraph each reached for a verdict — "cannot be
compared", "removes a bound", "beyond reach" — and each was wrong in one
direction or the other. The numbers are the content; the verdict was never
needed.

**A correction, recorded because the mistake is an easy one to repeat.**
This change was originally justified as closing a real gap: that the
backup's own manifest can prove an archive is intact and encrypted under
our key, but cannot prove *who wrote it* — so someone who had taken over
the backup system could upload a replacement archive with a perfectly
consistent manifest, and every check the recovery procedure makes would
pass. That gap is real. The claim that this notification closed it was
wrong, in three separate ways:

- The credentials that let someone forge the archive also let them post to
  the operator channel. They come from the same place. A record cannot
  vouch for whoever wrote it.
- The channel is not a permanent record. A bot can edit and delete its own
  messages, so the original entry is not fixed once posted.
- Nothing reads it. The recovery procedure checks the archive against its
  own manifest and never against what was announced at the time.

The full fingerprint is still worth recording — an operator comparing two
candidate archives by hand needs all of it — but as an aid, not a
safeguard. The real gap is now tracked separately, along with what closing
it actually requires: a record the backup system itself cannot write to,
and a recovery step that consults it.

**Also fixed:** a nightly run whose ops notification failed to send used to
report success and move on, leaving a backup that exists with no record of
it anywhere an operator looks. The upload has already happened by then, so
this cannot fail the run — but it is now written to the Worker log, which
is the only channel left when the alert channel is the thing that broke.

## The keeper now says which switch stopped it

Three of the keeper's periodic jobs — reward remittance, its acknowledgement pass, and commitment reporting — each sat behind an on/off switch, and when a switch was off they simply did nothing, quietly. That is the problem: a job that was switched off and a job that ran and found no work to do produced exactly the same output, which is none at all.

That would be a small annoyance if the switches could be read back. They cannot. They are stored as secrets, and the hosting provider will confirm only that a secret of that name exists — never its value. So between a switch that could not be read and a job that said nothing, there was no way to establish whether the thing was on. A misspelling, a stray capital letter, or an invisible trailing newline pasted along with the value would leave the job switched off permanently while everything looked healthy.

For these particular jobs that is the worst case, because they move funds between chains and report what has been committed. A job that has silently stopped looks exactly like a quiet week.

**Every switchable job now announces itself once per run**, whichever way its switch reads. If it is running, it says so. If it is not, it names the specific switch that stopped it, and what is wrong with the value. One pass of the log settles the state of every switch the keeper has.

Some details worth calling out:

**No value is ever printed — only what is wrong with it.** "Unset", "empty", "deliberately switched off", "wrong capitalisation", "has spaces around it", or "unrecognised, 4 characters long". This is deliberate and was a correction during review: the situation this diagnostic exists for is the value being *wrong*, and one of the ways a value gets wrong is somebody pasting a password or key into the wrong box. Printing it would copy that secret into the logs at exactly the moment the system is meant to be protecting it. The character count still tells an operator whether they are looking at a four-letter typo or something long that does not belong there.

**Everything wrong is reported at once.** If three settings are wrong, one line names all three. An earlier version stopped at the first, which would have meant fixing one, waiting for the next run, and discovering the next — turning a single check into a sequence of them.

**One message became several.** The master switch previously reported a single "keeper disabled", covering two genuinely different situations — the switch being off, and the signing key being missing. Both are unreadable, so an operator seeing that message could not tell which to go and fix.

**A key that is present but unusable is now a blocker, not a green light.** The signing key was only checked for being non-empty, so a malformed one — wrong length, or not a valid key at all — let every job announce it had started and then quietly do nothing. Reporting the healthy state for a broken key is the worst direction to be wrong in, and it would have let the restore procedure sign off while nothing could actually sign. The key itself is still never printed; the line says only that it is malformed and in what way. Getting this right took two passes: the first check looked at the shape of the value — length and characters — which still admitted values that look exactly like a key but are not one. The check now simply tries to build the signing identity and reports whatever refuses, so the thing that decides whether a key works and the thing that reports on it are the same thing, and cannot drift apart.

**The promise that key material never reaches the log needed enforcing, not just stating.** One of the jobs built the signing identity itself rather than going through the shared check, and did so outside its error handling — so an invalid key threw, the surrounding handler logged the failure, and the underlying library's message for that case *contains the rejected key value*. Every construction now goes through one place, and a test fails if a second appears. The guarantee is only true while that holds, so it is now checked rather than trusted.

**A deliberate "off" reads as off, not as a mistake.** Setting a switch to `false` is the documented way to turn a job off, and an earlier version of this reported that as "unrecognised, 5 characters" — telling an operator their intentional shutdown looked like a typo, at the moment a spurious warning is least welcome. It now says the job is explicitly disabled. It still refuses to run, of course; the message describes the state, it does not decide it.

### Which jobs this covers

Six of the keeper's ten periodic jobs have a switch of their own and now report it. The other four have no switch to report, so they stay quiet — and the operator documentation says so explicitly, because "no line" would otherwise read as "the job failed".

### A quirk this exposes rather than fixes

The master switch accepts `True` and `TRUE`; the two reward switches accept only lowercase `true`. So `KEEPER_ENABLED=True` works while `REWARD_REMIT_ENABLED=True` does not, which is a genuinely surprising trap.

We deliberately did not make them agree here. Doing so would switch **on** a fund-moving job on any deployment that currently has it set that way and believes it is off — a behaviour change smuggled in under a logging improvement. Instead the log now reports `wrong case — these flags require lowercase \`true\``, which turns an invisible trap into a legible one without repeating the value back. Using lowercase everywhere avoids it entirely.

### Operator-facing

The restore runbook previously instructed operators to treat the two reward switches as write-only — re-enter the value rather than verify it, and wait for a successful remittance as the only confirmation. That instruction is now obsolete and has been replaced: one log cycle verifies all of them.

It also gained a correction that has nothing to do with logging but everything to do with acting on what the log says. The signing key is not stored the same way the switches are — it lives in a shared account-level store rather than on the individual job runner — and the command for one does not work for the other. Using the wrong one appears to succeed while leaving the job disarmed, so the runbook now spells out which command belongs to which setting.

## The backup healthcheck was only ever looking at a third of the backups (#1476)

The nightly backup writes three families of archive: a daily one, a monthly one cut on the 1st, and a yearly one cut on Jan 1. The weekly healthcheck verified the daily family — fetching the newest archive, checking it against its manifest, and decrypting it to prove the key still works — and never looked at the other two at all.

**The damage was not the missing check so much as the confident report.** Every week the operator received "Weekly backup healthcheck PASS", with nothing in it to suggest a scope. Two of the three families had never been examined by anything, and a monthly archive that had been overwritten or had quietly stopped being written would have produced exactly the same green message, indefinitely.

It also propagated. The retention policy sets a floor on how long a superseded archive stays recoverable, and that floor is derived from how often something routinely looks at these objects. For the monthly family there was nothing to derive it from, so the floor was set to a longer, weaker figure chosen only to outlast the monthly write cadence — and the reasoning was recorded honestly as such. A number stood in for a detector that did not exist.

The healthcheck now runs the same verification against all three families.

**The retention floor did not change, and the reason is worth stating.** Having built the detector, the obvious next step was to shorten the monthly recovery window on the grounds that something now watches those archives weekly. It does — but only in part. The check verifies the *newest* archive of each family completely: hash, size, and a real decryption. Every older archive still inside its retention gets a cheaper check that it is present and correctly paired. An archive that is silently corrupted or overwritten in place keeps both of those properties, so it passes.

The floor's whole justification is that the recovery window outlives one full round of whatever routinely inspects these files. That holds for the objects inspected in full and not for the rest, so shortening the window would have rested on a detector that does not watch them — the same substitution of a number for a detector that this change set out to remove, made again one level down. Rotating the full check across the older archives was considered and is worse: it would put each one under inspection roughly every eleven weeks, implying a *longer* floor than today's, not a shorter one.

Two smaller decisions worth stating:

**The alert now lists every tier on every run**, pass or fail. Extending the check without changing the message would have fixed this instance and left the next one — a report that does not say what it examined invites the reader to assume it examined everything.

**A yearly archive that has never been written is reported but not paged.** A deployment that has not yet lived through a Jan 1 legitimately has none, and that is a normal state lasting up to a year; paging weekly for it would train the operator to ignore the alert. That exemption is deliberately narrow: nothing ages out of the yearly archives, so once the first one exists, *every* year since must still be there, and a gap fails like any other. A missing daily or monthly archive always fails.

**The check asks which archives should exist, rather than looking back a fixed number of them.** That distinction turned out to matter more than it sounds. A fixed lookback cannot tell an archive that never arrived from one that has legitimately aged out — so a failed monthly cut was covered by the previous month for the remainder of that month, and then, once the following month succeeded, was never looked at again. The gap stayed permanently, behind green weekly reports. The previous month is now required rather than a fallback, and the fallback survives only for the one moment it was meant for: the 1st itself, before that night's upload has run.

This closes a detection gap, not the forgery gap: an attacker who holds both the upload credential and the encryption key can still write a self-consistent archive that passes every one of these checks. That remains tracked separately, and the retention floors remain a floor of usefulness rather than a sufficiency argument.

**A detector cannot derive its expectations from the survivors.** The first version of this checked which archives existed and required those to keep existing — which sounds right and is circular. Delete the oldest archive and the baseline quietly advances past it, so the deleted one stops being expected; delete the whole family and there is nothing left to infer from, so nothing is missing and the check passes. The worst case read as the healthiest. The operator can now declare when each long tier's first archive was written, and until they do, the weekly report says in as many words that its deletion detection is degraded.

Three related gaps closed with it. Only the current and previous month were checked although monthly archives live for about a year, so deleting an older one was never noticed. A period counted as present on the strength of its manifest alone — a few hundred bytes describing an archive that might no longer be there — so only the newest archive was ever confirmed to exist. And a period label taken from the storage listing was used unchecked to build a range of expected years: an upload named `-999999999` would have sent the check into a loop of roughly a billion iterations, inside the same scheduled run as the nightly backup. Labels are now validated to their exact expected shape, and the range builder independently refuses an implausible span.

One number in this change was wrong and a test caught it: the retention window was set to eleven months on the reasoning that it was already a month inside the twelve-month promise. The real figure is 10.97 months, so requiring an eleventh would have paged every week for an archive that had legitimately expired.


## Thread — committed restore converter for the nightly archive (PR #TBD)

The off-chain restore runbook's two hardest steps — turning a decrypted
archive into D1 import batches, and materializing the legal-vault
objects for re-upload — previously had no committed tooling: inline
code in the runbook failed review twice during #1450 (fragments that
presented as runnable and were not), so the document honestly said
"write the transform at restore time". That gap is now closed by a
single tested script in the archive Worker's package.

The converter enforces every requirement the #1450 review accumulated:
imports are replace-not-merge (each batch leads with a delete so
selective restores cannot collide or leave attacker-inserted rows),
tables apply parents-before-children so foreign-key cascades cannot
erase a just-restored child, values and identifiers from the archive
are treated as untrusted (strict quoting, hard failure on anything
unrecognised), legal-vault keys are validated against the canonical
shape with filesystem-traversal rejection before any write, every
object is SHA-256-verified against the archive's own digest, and
uploads go through wrangler with argument arrays rather than shell
strings. A test suite pins each hostile-input rejection, and a new CI
job (mirroring the mesh-watcher pattern for standalone ops packages)
runs it on every change to the package. The restore runbook's §4 and
§5 now invoke the committed script instead of describing a hand-written
one. Closes #1477.

## Thread — every documented pnpm deploy invocation now runs the package script (PR #TBD)

Under the workspace's pinned pnpm, `pnpm --filter <package> deploy`
resolves to pnpm's own built-in "portable package deploy" command —
which demands a target directory and never runs the package's declared
`deploy` script. Every per-app README documented exactly that broken
form, so an operator following any of the six app READMEs verbatim
stopped at a usage error instead of deploying. The ops runbooks were
corrected during the #1450 review (Codex round 28); this change sweeps
the remaining sites — the six `apps/*` READMEs — to the working
`pnpm --filter <package> run deploy` form. A repo-wide sweep found no
other documented pnpm invocation whose script name collides with a
pnpm builtin. Closes #1478.

## Thread — the nightly backup now archives `pre_grace_notify_state` (PR #TBD)

The pre-grace warning dedupe table (added with the T-092 pre-grace
watcher) was missing from the nightly backup's born-off-chain table
list, which had two consequences found during #1450's review: no
restore could ever recover it, and a replace-style selective restore of
`user_thresholds` destroyed it as a foreign-key cascade side effect
with nothing to re-import. The table now rides in the required
born-off-chain set, and every table-list surface (Worker README,
restore runbook §4, resilience design doc) says so. Archives written
before this change do not carry the table; restoring from one loses the
dedupe rows, and the observable consequence is duplicate pre-grace
warnings — stated in the restore runbook rather than discovered.
Closes #1480.

## Thread — every written D1 table now needs an explicit restore classification (PR #TBD)

The #1450 review exposed that the backup's table lists had drifted well
behind the live schema: some tables were unarchived and unrecoverable,
others were missing from the tampering-recovery clear list, and the
failure mode in every case was silence — a migration adds a table,
nothing forces anyone to decide its restore treatment, and the gap
surfaces mid-incident. A new indexer typecheck guardrail (same pattern
as the event-coverage check) closes the silent path: it extracts every
table the indexer, keeper and agent Workers write and fails CI when one
lacks an explicit classification — born-off-chain (archived, imported
on restore), replay-derived (cleared before the block-zero replay), or
decision-needed with a stated reason. It also cross-checks the
born-off-chain class against the backup Worker's own archive list so
the classification and the backup cannot disagree.

The guardrail proved itself on its first run, surfacing four
keeper-written tables every manual sweep had missed. Sixteen tables
remain explicitly decision-needed on #1481's docket — visible debt in
place of silent debt; the issue stays open for those decisions. Part
of #1481.

## Thread — the provenance stamp that always said "dirty" (PR #1490)

Several build and deploy scripts record which source state their output came from: a commit hash, plus a marker when the working tree had uncommitted changes at the time. The marker exists to separate two cases that matter to anyone auditing a build — an artifact generated from a committed state, which can be regenerated and compared, and one generated from a developer's half-finished tree, which cannot.

**The marker was set on every single run, so it separated nothing.** Each script tested the working tree *after* it had already written its own output, and that output is itself a working-tree change. The check could only ever come back dirty. Worse than useless: it read as a warning, so a genuinely dirty build looked exactly like a clean one, and the flag would have been ignored precisely when it mattered.

This was first noticed while trying to get a clean stamp on an unrelated change. Committing the source first and re-exporting afterwards still produced "dirty" — because the export's own files are what dirtied the tree. There was no operator discipline that could have produced a clean stamp; the check was unwinnable by construction.

**Eight scripts write one of these stamps; six had the defect.** The report named the frontend ABI export. The same few lines had been copied into the deployments export, the subgraph export, and all three deploy scripts. Each now takes the reading once, before it writes anything — which is also the reading that answers the actual question, "what state was this generated *from*".

A seventh script, the keeper-bot ABI export, shares the same shape and was **not** affected, which only became clear on checking rather than assuming: it writes into a separate checkout alongside the monorepo, so its own output never dirtied the tree it was testing and its late reading was correct all along. It has been brought into line with the others anyway, so the seven now read identically and none is a special case a future reader has to reconstruct.

**Four of them were failing in the opposite direction as well.** Where most scripts compared against the last commit, a few compared against the staging area instead — so a change that had been staged but not committed was reported as *clean*. That is the more dangerous error of the two, because it hides real drift rather than crying wolf about none. All seven now use the same comparison and count staged work as uncommitted, which it is.

**An eighth script was found only because the check went looking.** It recorded a commit with no indication of tree state at all, and the first version of the check could not see it because it recognised only one of the two ways these stamps are written. It now records both, like the rest, so there is no exception for a reader to remember.

**The reading also ignores each script's own output, which turned out to matter more than it sounds.** Without that, simply *re-running* an export before committing the first run's result would see those files and report dirty — recreating the exact false warning this change removes, for anyone who reviews an export and runs it again. Each script now looks at everything except what it writes — **computed from the output location the run actually resolves**, never written down in advance. A fixed path silently excludes the wrong place the moment an operator points the output somewhere else, and does so for precisely the people who customise. Writing the paths down by hand produced one wrong filename and — worse — three cases of hiding too much: two templates and a deployment record that are **inputs** to their own scripts, where suppressing them turned a real uncommitted edit into a clean reading. The third of those was introduced while fixing the first two, in the same round, which is the clearest argument there is for computing the exclusion rather than choosing it. Computing it also meant taking the reading slightly later — once the destination is known, still before anything is written. The deploy scripts exclude nothing at all, because their reading precedes their writes entirely and their deployment records are inputs they consume.

**Every script also records the commit it started from rather than reading it again at the end.** If someone commits midway through a long run, a fresh reading would name a commit that never produced the artifacts, pairing a new hash with a clean reading taken before that commit existed. Any movement now marks the run as unreproducible instead.

**Detecting mid-run changes to the inputs is deliberately not attempted here.** It is a genuinely useful thing to have on a deploy, which can run for many minutes while consuming source — but three attempts at it in review each shipped a subtly wrong comparison, including one that silently examined a directory that does not exist and could therefore never report anything. That is a signal the problem deserves its own design rather than another patch inside a change about stamp ordering, so it is recorded as separate work with the failed approaches written down.

The same pairing problem applies to the exporters, which is where it was first missed: they too read the commit fresh at the end while having observed the tree at the start. The window is a few seconds rather than several minutes, but a commit landing inside it produces the same wrong pairing, so all of them now record the commit they began with and flag the run if it moves.

**The alert-manifest exporter now stages its output instead of overwriting it.**

The same abort question came up on the Tenderly alert exporter and took three attempts to answer, each one still destructive. First the aborted run left its half-written manifests on disk, where the documented apply step would have picked them up by glob. Then it deleted them — by wildcard, so running the exporter for a single chain and hitting the abort wiped every *other* chain's perfectly good manifest. Then it deleted only the paths this run had touched, which is still wrong: touching a path that already held a valid manifest means overwriting it, so the cleanup destroyed a working configuration the run had merely passed through.

Each fix addressed the reported symptom and left the cause alone. The cause is that the run wrote to the live location before it had established it was entitled to. Manifests are now generated into a staging area and moved into place only once the provenance check has passed — so a failed run leaves the previous configuration exactly as it found it, and there is no cleanup to get right. The staging area sits beside the output so each publish is a single atomic rename rather than a partial copy.

Staging introduced one more fault of its own, worth recording because it is the same mistake in miniature. The publish step walked a list of the chains the generation loop had *meant* to stage, rather than looking at what was actually staged — and the two disagree the moment a chain is named twice on the command line, which a generated argument list can easily do. One file gets published, the second rename finds nothing, and the run aborts partway through publishing: precisely the half-applied state staging exists to prevent. It now publishes whatever is on the staging area, which cannot disagree with itself, and a repeated argument simply overwrites its own staged file and publishes once.

This is the same shape as the mainnet fix above, arrived at from the opposite direction: there, work that could not be undone had to be recorded; here, work that had not yet been earned should not have been done. Both reduce to not letting an abort path find state it has to repair.

**Mainnet stops before it starts, and records after.** That script already refuses to *start* from a tree with uncommitted changes, on the stated grounds that incident forensics need the recorded commit to describe the deployed bytecode. If the commit moves, the check that matters happens **before the first transaction**, where stopping costs nothing but a re-run.

After that point it deliberately does *not* stop. An earlier version of this change aborted late, and that was the more damaging choice available: by then the contracts are on chain and irreversible, while the local record of them, the completion marker, and the clock that tracks how long a single key holds control are all still unwritten. Exiting there leaves a chain with live contracts nobody has a record of — the ordinary retry is refused, the only remaining route is the destructive one, and the countdown on that key exposure never starts. The rule the late abort broke is worth stating on its own: **never exit between an irreversible external effect and the record that it happened.** So the later path records the move loudly and marks the run unreproducible, which is exactly what the marker is for. Testnet keeps the softer treatment throughout, because a rehearsal can simply be re-run.

**A check was added so an eighth copy cannot quietly reintroduce it.** The pre-deploy gate now looks at every script that writes one of these stamps and fails if the reading is taken after the script's first write, or if it is taken more than once. It finds those scripts by the shape of what they emit rather than by a hand-maintained list, which is how the two deploy scripts turned up — they were not in the original report and were not in the first sweep either. The check states its own blind spot in a comment: it recognises the four ways these scripts currently write files, and a script that writes some other way is only partly covered.

The fix was verified by watching the stamp change: clean from a committed tree, dirty from a tree with a real edit, and dirty from a tree whose only change was staged. The guard was verified the same way — by reintroducing the bug two different ways and confirming it went red for the right reason each time, then confirming it goes green again once restored.

No output artifact changes as a result of this; only the provenance line that describes it.

**How to read stamps written before this change — and there is an exception worth knowing.** For six of the seven scripts, a recorded "dirty" should be treated as *unknown* rather than as a genuine warning: the flag was set by the script's own output, so it could not have meant anything else.

The keeper-bot ABI export is different. It writes into a *separate* checkout alongside the monorepo, while the state it was testing was the monorepo itself — so its own output never dirtied the tree it looked at, and its check was working as intended all along. An existing "dirty" stamp from that exporter is a **real** signal that the monorepo had uncommitted changes when those ABIs were generated, and should be investigated rather than discarded. An earlier draft of this note said to disregard every historical dirty stamp, which would have thrown that away.

## Thread — Build docs CI job un-broken (quick-profile doc compile) (PR #TBD)

The contracts documentation CI job had been failing on every push to
main since mid-afternoon on 2026-07-30: the documentation generator
runs its own full compiler pass over whatever the active profile's
file globs include, and the CI profile's test-exclusion list is an
explicit per-file enumeration that newer test suites were never added
to. When the rewards milestone's large test suites entered that scope,
the single-unit compile grew past the CI runner's memory ceiling and
the out-of-memory killer took down the runner itself — surfacing as a
cryptic "runner received a shutdown signal" after ~29 silent minutes,
on every subsequent run.

The documentation step now runs under the lean inner-loop profile,
whose test and script exclusions are directory-wide globs that future
test files can never drift out of, and whose source-only scope is
exactly what the docs site documents. Measured locally on
CI-equivalent hardware: the doc build completes in about two minutes
at ~1.5 GB peak memory, versus exceeding ten minutes and 5.7 GB and
still climbing before the fix.

## One definition of "how much VPFI is free to pay out"

Before a reward is paid, the platform checks that the tokens backing it are
genuinely spare — that paying this reward will not eat the balance set aside
as recycled reward runway. **Two** places enforce that: one refuses a claim
that would overdraw it, and one caps the amount an expiry sweep may take.
Each worked the figure out for itself, even though the library that owns the
underlying ledger already defined it and publishes it as a read-only
transparency figure. The arithmetic agreed. The explanations sitting beside
it did not.

Both now read that single definition. Nothing about what is or is not
allowed has changed; the same claims succeed and the same ones are refused.

### Why the duplication mattered more than it looks

The copies had drifted in their *descriptions*, not their results — and a
description is what the next person acts on. One of them said the figure was
only an approximation, and that making it exact needed a new running total of
a second category of held tokens.

That was true when it was written and had since stopped being true. The
category it referred to is VPFI collected from a borrower at the start of a
loan and held until settlement. An earlier change retired the path that
collects it: no loan opened under the current rules hands over any such VPFI,
so there is nothing left to subtract. Acting on the stale note would have
meant adding a running total that could only ever count zero — machinery that
reads as a safeguard while guarding nothing.

The correction is recorded once, at the definition, rather than at each of
the three readers. Restating it three times is what produced the drift.

### What is now written down

All three categories of held VPFI are stated explicitly, along with whether
each is subtracted and why — including one that deliberately is **not**.
Unclaimed reward funding is exactly what a reward claim is entitled to draw
on, so subtracting it would refuse claims their own money. Its place in the
underlying rule says the platform must be *holding* it, not that a payout may
not touch it. That distinction was implicit before and is now stated.

### More owners of the same holding kept appearing — and why none are reserved here

Review kept finding the same shape with different owners — recycled reserve,
borrower fee custody on grandfathered loans, treasury revenue where the
platform holds its own, the reward-emissions budget, the keeper reward
budget, collateral held during a live swap-to-repay, collateral left in place
when a liquidation cannot find a route to sell it, funded payroll
obligations, buyback allocations. The engineering note beside the code holds
the current list; it is deliberately not repeated here, because every time it
was repeated the copies disagreed within a round.

Each round of review produced another — and more than once the newest arrived
in the round *after* the list had been written up as complete, which is the
clearest possible statement of the problem. **The list is not an audit.** It
is what adversarial review happened to notice, and the last few were found
only because someone went looking in places nobody had thought to check.

**Some of them change what kind of problem this is.** Two are not protocol
budgets at all; they are a **borrower's collateral**, sitting in the same
holding while their loan is mid-flight. A reward payout that draws on them is
spending money that belongs to a user, so this stopped being a bookkeeping
tidy-up and became a fund-safety item.

One of them **was** reserved during this work, and that change has been
**withdrawn**. Two reasons, and the second is the more instructive.

First, the count. The list grew in every round it was written up as
complete, with no sign of the rate falling, which says the approach itself is
wrong: permitting a payout up to
"everything we hold, minus the claims we remembered to write down" needs that
list to be complete forever, and a missing entry causes no visible failure —
which is exactly how each of these went unnoticed.

Second, patching it made things worse. Reserving that one owner immediately
put the payout rule out of step with the separate rule governing when an
unclaimed reward expires, which still measured the holding the old way. The
result: expiry clocks kept running while every payout was refused, so an
entitlement could lapse without its holder ever having had a usable window to
claim it. A fix that creates a fresh way to lose user value is the point to
stop patching and change approach.

So the remaining owners are recorded as **known and unreserved** rather than
half-addressed, and the figure is documented as an upper bound on genuinely
free tokens — on every deployment, not just unusual ones. Bounding payouts by
*funding delivered for rewards* needs no list at all, covers every owner at
once, and is the same bound the outstanding cross-chain work needs. That is
now the tracked remedy, and new custody should wait for it rather than be
added to a subtraction that cannot be completed.

### One half of the first finding is fixed; the other is now stated plainly as open

The above holds for a platform deployed **fresh** under current rules. A
platform **upgraded from an older one** is a different matter, and review
was right to press on it: it can still be holding that VPFI against loans
open at the time of the upgrade. Those tokens sit inside the figure, so a
reward payout can spend them — and the borrower's settlement, when it
eventually comes, is short. It either fails outright or leaves them unpaid.

**That gap is not closed here, and the item tracking it stays open.** What
changed is the diagnosis. It is not really a missing subtraction; it is the
same root as the outstanding cross-chain reward work — payouts are limited by
what the platform *happens to hold spare*, rather than by what was *delivered
to fund rewards*. A running total of held custody would patch one symptom.
Bounding payouts by delivered funding removes both, and that is where the
item now points.

Separately, the collection routine still exists, unused. **Re-connecting it**
would reintroduce the gap on a fresh platform too. An existing test stands in
the way: it funds a borrower, brings them to a qualifying tier, opts them
into the discount, confirms that tier is actually in effect, and only then
asserts nothing is taken into custody. Checking the setup *before* the
conclusion is what makes it a real guard rather than one that would pass
whether or not the routine were live.

## Thread — Borrower-side listing-hold surface (#1503 PR-A follow-up)

The listing lifecycle shipped in PR-A exists for the borrower — the
mandatory expiry, the permissionless teardown, and the relist cooldown
all bound how long a lender's sale listing can hold the borrower's
offset close-out and collateral-withdrawal options. This change gives the
borrower the surface where that protection actually reaches them. On
their loan page, a listing on their loan now renders a hold notice:
while the listing is live it explains which options are held (the
offset exit and collateral withdrawal), which stay open (repaying
fully, partially, or closing early — a partial repayment shrinks
what a buyer would take over), and the structural bound on the hold;
once the listing has ended, the same notice grows a one-click "Free
held options" cleanup — the permissionless, pause-exempt teardown —
and confirms the lender's one-day relist quiet period after it runs.
The early-repayment chooser's offset entry is marked held with the
same explanation instead of jumping to its hidden card. (The review
rounds caught and corrected an inversion here: the on-chain hold is
on the offset path — offsetWithNewOffer refuses a listed loan — and
NOT on the direct early close, which carries no listing guard; the
same correction is applied to the PR-A wording in the specs and the
still-unassembled PR-A release fragment.)

One narrow state gets a stronger treatment than a notice. When a buyer
has already accepted the lender's listing and that sale is still
mid-completion, the buyer's funds are committed but the purchase has
not finished — and a borrower who repays, part-pays, closes, transfers
or refinances in that window would terminalize or reshape the loan the
purchase depends on, permanently stranding it. The app therefore
pauses the borrower's settlement options for the duration, with the
reason stated up front rather than surfacing as an unexplained
failure, and keeps adding collateral available throughout.

That pause deliberately stops at the edge of one state. A purchase can
only complete against a running loan, so once a loan has fallen into
fallback resolution the purchase is already stranded — a pause there
would protect nothing, could never lift on its own, and would shut the
borrower's last door while the lender's own claim stayed open to them.
In that state the app explains rather than enforces: it says a purchase
is attached, that it cannot finish until the loan is brought back to
normal, and that settling instead ends the purchase too — and leaves
the decision with the borrower. This is app-level protection over a
window the contracts still permit; the matching on-chain close-out
guard belongs to the #1503 PR-E slice.
Every settlement path additionally re-asks the chain immediately
before it sends, so an acceptance that lands while a review screen sits
open cannot slip past a cached answer, and any unanswered check pauses
rather than proceeds.

The state is judged from the chain alone, by simulating the exact
cleanup transaction the button would send and classifying the outcome
— no local marker, no off-chain index, so a listing made by the
lender on any device shows, and an outcome the app cannot classify
renders nothing rather than a false hold or a doomed button. The
committed browser-level test drives the full lifecycle (live hold →
expiry → cleanup → on-chain link severed). It arms itself: it asks the
test network whether the new listing entry point is actually routed
there, and stays out of the way until the answer is yes. That answer
turned yes when the contracts were redeployed, so the test now runs.
The same question guards the app itself, which is the point of asking
it — an older deployment reports some of the new outcomes under the
same names as the old ones, so rather than risk describing a hold
wrongly, the surface says nothing at all until it knows it is talking
to a deployment that has the feature.

The review rounds also removed the app's stale
pre-acceptance-binding partial-repayment freeze: the partial-repay
surface no longer blocks while a listing stands (the contracts never
held it — a partial shrinks the claim and the pending buyer
re-signs), the cleanup
goes through the app-standard review receipt, and the freed
confirmation survives the state refetch. A matching stale passage in
the connected-app functional spec (which claimed the reverse hold
set) was corrected the same way.

A pre-merge adversarial sweep of this work caught three defects the
review rounds had not, and all three are fixed here. The most serious
was self-inflicted and would have shipped a crash on every load of the
position page. The other two were failure modes of the safety
machinery itself: a paused surface that could never un-pause, and a
transient network error that could have stopped a borrower repaying on
the deployment as it stands today. Their common shape is worth naming
— each came from a protective check that was correct about the danger
it named and wrong about its own blast radius, which is why the
protection is now expressed as one tested rule rather than several
conditions maintained in parallel. The gap that let a page-crash
survive review — the connected app runs no linting at all — is
tracked as #1516.

Part of the #1503 series; the lender-side pending-card teardown
surface remains tracked as #1506.

## Thread — The early-repayment and listing surfaces now speak every shipped language

The borrower's ways out of a loan, the lender's sale-listing window, and
the VPFI fee-mode surfaces were all written in English only. Every other
language the app ships fell back to English for that entire set of
screens — 158 pieces of text, covering the early-repayment chooser, the
hand-the-loan-over flow, the become-the-lender exit and its standing-offer
card, the borrower's listing-hold notice with its one-click cleanup, the
lender's listing-window control, and the optional full-fee surfaces.

This was not a language sitting quietly unfinished. All nine of these
languages are already switched on in the language picker and already
advertised to search engines as translated pages. So a borrower reading
the app in Tamil or Arabic reached the screen where they decide how to
get out of a loan — the screen that explains what each exit costs, what
gets held, and what leaves their wallet — and found it in English. The
gap sat exactly where the stakes are highest and the reading is hardest.

All nine are now complete: Arabic, German, Spanish, French, Hindi,
Japanese, Korean, Tamil and Chinese. Each follows the vocabulary already
established in that language's existing text rather than inventing new
terms, and each keeps the project's do-not-translate names intact. The
merge tooling refused any entry whose live values — amounts, dates, rates,
identifiers — did not match the English exactly in kind and number, so no
translated sentence can quietly drop the figure it was written to carry.

## Thread — Lender-sale listing lifecycle: finite window, expiry teardown, relist cooldown (PR-A of #1503)

A lender-position sale listing is no longer open-ended. Every listing now
carries a seller-chosen finite window (one hour to thirty days, picked from
presets in the app), and the listing expires on its own when the window
ends. The window can never outlive the loan: a window reaching past the
loan's due date is clamped to end exactly there, and a position too close
to maturity to stand for even the minimum window is refused at listing
time. An expired listing can no longer be bought — a buyer's acceptance at
or after the expiry moment is refused regardless of how fresh the buyer's
own signature is — and independently, no buyer can enter a position sale
at or past the underlying loan's due date (a matured position has zero
remaining term; the buyer would be purchasing nothing). That maturity
refusal fires at the moment of purchase, before any buyer funds move; a
sale entered before the due date remains completable on the documented
manual-recovery path, so a committed buyer is never stranded. The expiry
rides the same offer-expiry machinery regular offers use, so the open
book, the accept gate, and the lazy-clear path all treat a sale vehicle's
window uniformly. Listings created before this change (which carry no
expiry) are admitted to the permissionless cleanup immediately, and the
in-place testnet refresh script now removes the retired listing entry
point so the pre-change shape cannot be recreated.

Once a listing has expired on a still-active loan, anyone may tear it
down: the cleanup unlocks the seller's lender position NFT, cancels the
stale sale offer out of the open book (including the vehicle's own
offer-position record, so it also drops out of the open-position views),
severs the loan↔listing link, and announces the cancellation the same
way an ordinary cancel does — so off-chain indexes mark the listing
terminal without any extra transaction.
This teardown stays available while the protocol is paused — it moves no
value and creates nothing; it only releases a lock that no longer protects
anything, so an incident pause must not trap a seller's NFT behind a dead
listing.

Ending a listing without a sale — expiry or seller cancellation — starts
a one-day quiet period before the same loan can be listed again. This is
the borrower's action window: a live listing holds the borrower's
offset close-out (the Preclose Option-3 lender-offer path) and
collateral-withdrawal options, so back-to-back relisting must not be
able to keep those options frozen indefinitely. (Repayment is never
held — full repayment, partial repayment, and the direct early close
all stay available throughout a live listing; a partial shrinks the
outstanding amount, with a pending buyer simply re-signing for the
smaller position.)

App surfaces follow: the alpha02 listing form gains the window selector
(with the expiry and cooldown explained, and window changes voiding any
given consent), the listing receipts now name expiry as a way the listing
ends, and the legacy defi page pins the seven-day default window. Part of
the lender early-withdrawal prerequisite series tracked on #1503 (design:
LenderEarlyWithdrawalUXDesign.md — items 1 and 14 plus the borrower
action window).

## Thread — Position sales now require a solvent position (PR-E, item 11)

Selling a lender position used to check almost nothing about the position's
health. Both exit routes — the direct swap-in against a standing buy offer,
and the resting sale listing — gated on the loan still being `Active` and
nothing more. That left a real trade open: a lender watching collateral fall
could hand an already-underwater position, in the worst case one liquidatable
in the very next block, to a counterparty who had authored ordinary lending
terms on the assumption that a new position starts comfortably
over-collateralised. The sale price is computed from principal and accrued
interest, neither of which says anything about a collateral shortfall, so
nothing in the trade signalled the problem.

A sale is an admission rather than a hand-off of already-accepted risk — the
incoming lender never underwrote this loan — so both paths now require the
position to clear the same health-factor floor its own origination required.
The floor comes from the loan's origination snapshot rather than the live
protocol setting, which is the rule every other post-origination health check
follows.

A sale must clear a second bar as well, and the two pull in different
directions on purpose. Transferring a position changes the lender, not the
loan's recorded admission floor, liquidation threshold or initial-LTV cap — so
where governance has tightened since origination, a buyer would silently
inherit looser collateral bounds and a later liquidation point than they could
be sold today, which no health reading reveals because the position is entirely
solvent against its own older terms. Sale admission therefore also requires
those inherited terms, and the position's live loan-to-value, to be compatible
with current parameters.

So the honest statement about a governance retune is narrower than "it changes
nothing for open positions". Snapshot semantics still govern the existing
loan's ongoing operation, so the current lender's bargain is never rewritten.
But a tightening can leave an otherwise valid open position temporarily
unsellable while it remains perfectly valid to hold, repay or liquidate. That
is a deliberate consequence of treating a sale as the admission of a new
lender rather than a hand-off of accepted risk. For a resting listing the
binding check is at the moment the buyer's value commits: a listing sits
still while the position keeps moving, and only the fill-time reading
describes what the buyer actually inherits. Listing creation runs the same
test so a seller is told at once instead of after some buyer's transaction
fails, and the read-only accept preview classifies a blocked position, naming
which bar it failed rather than reporting every refusal as a health-factor
shortfall. Consuming that classification in the acceptance interface is
separate follow-up work, so today a buyer can still sign and learn of the block
from the revert; the contract-side guard holds either way. It is deliberately not
re-checked at sale completion, where a refusal would strand a buyer whose
principal has already settled — the same reasoning the maturity gate follows.

Positions whose legs are not price-discoverable now get an answer of their own
rather than a free pass. Previously they were waved through this check on the
reasoning that a health factor is a ratio of priced values, so there was no
floor to measure, and that the platform's separate consent regime for illiquid
assets would govern them. That regime's enforcement sits behind a switch that is
off by default, so on a default deployment the practical effect was that an
unpriceable — in the worst case worthless — position could be handed to whoever
had authored a standing offer, with no loan-specific or pair-level agreement
anywhere in the flow.

Two things changed together, and neither would have been safe alone. Liquidity
is now judged **as of the sale** instead of being read from the record written
when the loan was opened, which is never refreshed: a market that had degraded
since origination previously let a position be sold on the strength of prices
the platform no longer accepts, without ever being recognised as unpriceable.
Fixing only that would have routed *more* positions into the pass-through, so
the pass-through is gone: where a leg cannot be measured, the sale is refused.

That refusal is unconditional, and an intermediate version of this change got it
wrong in an instructive way. It deferred to the platform's buyer-consent regime
whenever that regime was switched on, reasoning that consent is the right
mechanism for a position carrying no price-based safety net. But that regime
grades an asset by what it *is* — its identity and the depth class of its market
— while measurability is a property of the pricing oracle right now, and the two
come apart exactly where it matters. The platform's own reference and quote
assets are classed as lowest-risk **by identity**, needing no opt-up and no
per-pair agreement; one of them with a stale price feed is therefore
unpriceable and exempt from every consent step at once. Deferring would have
handed such a position to a buyer who had agreed to nothing. A regime that never
consults liquidity cannot consent to an unpriceable position, so it is not
treated as a substitute for measuring.

A leg counts as measurable only when the live determination and the loan's own
record agree. That is not belt-and-braces: the record is what decides whether
risk arithmetic runs for a loan at all, so a position recorded as illiquid has
no health factor to compare regardless of what its market has since done, and
consulting only the live value would surface an opaque internal failure from the
health calculation where the honest answer is that the position is unpriceable.

A refusal says which leg is not priceable and carries no figures, because there
is no measurement to report. The buyer-facing preview reports the same case as a
plain block rather than as a health shortfall — the platform should never show a
health figure for a position that has none.

The guard fails closed in the other direction too — if a position claims to be
priceable but the oracle cannot price it, the sale is refused rather than
admitted against an unverifiable figure.

Where that failed price read is concerned, the two surfaces now also agree on
the stated reason, not just on the refusal. Previously the buyer-facing preview
turned a price read it could not complete into "this position is below its
health floor", quoting nought as both the position's figure and the figure it
had to meet — a measured shortfall that had never been measured, and a
different reason from the one the sale itself would give. The preview now says
the position cannot be admitted and that the reason could not be determined,
which is what actually happened.

The admission test is a cross-component read, and that has a consequence for
upgrades rather than for users. Two of the operator scripts that refresh an
already-deployed contract set in place reinstall a sale entry point without
having installed the component the new check reads, so running either against
an existing deployment would have left sales failing outright — the new code
live, and every attempt refused for a reason that has nothing to do with the
position. Both scripts now install that component and register the check
alongside whatever they refresh, choosing per entry point whether it is new or
merely being repointed by reading what the live deployment currently routes,
so one script is correct against an older deployment and a current one alike.

Two related problems on that path were found and fixed in the same pass. One
of the two scripts could not run against a current deployment at all: it
assumed a specific historical shape and tried to register entry points that
were already present, which aborts the whole operation. Its every step now
reads live state instead of assuming a version — which also means the sale
fix is genuinely reachable through it rather than masked by the script failing
first. The second: that script refreshes the acceptance path but had left the
read-only preview beside it untouched, so the preview would have gone on
quoting a sale as fine while the acceptance refused it — the exact
preview-versus-outcome divergence this change exists to remove, reintroduced
by a partial refresh. The preview is now refreshed with the path it previews.

Verified beyond unit tests: each new test was confirmed to fail when the
guard is removed, and the behaviour was driven end-to-end against a real
Diamond deployed on a local chain — full facet routing, real oracle wiring,
no mocking — where a position was pushed under its floor by a collateral
price move, the sale refused with the specific error, and the very same sale
then settled once the price recovered.

The upgrade path was rehearsed the same way rather than argued from a
successful compile, because a compile cannot see this class of mistake at all:
an existing local deployment was reduced to the shape a pre-change one
presents, the sale was confirmed to fail there for exactly the routing reason
described, and each refresh script was then run against it. For the script
covering the direct route, the sale was then driven again and completes. For
the script covering the resting-listing route it does **not** complete — that
is the separately filed pre-existing defect described further down, and the
rehearsal is deliberately left failing on it rather than pointed back at a
route that would pass. An operator should expect that script's rehearsal to
stop at its final step.

What the automated test pins is narrower than the operator rehearsal, and the
difference matters: it drives the real cut assembly of both scripts and proves
every affected function ends up routed to a single live build, including an
assertion that the starting fixture really does reproduce the failure —
without which the test could pass against a fixture that was never broken. It
does not drive a sale to completion, so it cannot stand in for the rehearsal
on the point above. Each script is also run twice in a row, because the first
pass exercises the register-as-new branch and the second the repoint branch,
and the underlying operation rejects either one applied in the wrong
situation.

This is the first half of PR-E. Item 21 (sale paths rejecting or binding
active borrower close-out state) is not included: rejecting an active
refinance offer needs a loan-to-refinance-offer reverse index that does not
exist today, which is a cross-facet change worth keeping separate.

Two pre-existing problems were found while verifying and are recorded rather
than fixed here: the local-chain flow script cannot reach its broadcast pass
at all (an earlier scenario's keeper revocation re-simulates as
already-revoked and aborts the run, reproducible with every later scenario
disabled), and one test fixture builds a Diamond without the risk facet, so
sale-path tests in it now need the health read stubbed.

A second, larger flaw in the same script came out of reviewing that fix. It
kept its own hand-written record of which functions each component owns, and
that record had fallen a long way behind: for the configuration component it
listed 34 of the 90 functions actually in service, and two others were
similarly short. A refresh only re-points the functions it names, so the rest
carried on being served by the previous build — one component answering calls
from two different versions of itself, while the script reported success and
nothing appeared to fail. The script now reads those lists from the same place
the full deployment does, so the record cannot fall behind, and a new check
asserts every function of every refreshed component ends up on a single build.
The equivalent staleness in the other refresh script is filed separately and
untouched here; its sale-path fix, which is what this release needed, is
complete and covered.

One more gap in the rehearsal itself came out of that review, and closing it
found something. The rehearsal drove the direct sale route for both refresh
scripts, but one of the two refreshes the *resting-listing* route instead — so
for that script the rehearsal was exercising a path it does not touch, and would
have stayed green with the refreshed listing check broken or absent. Each script
is now rehearsed against the route it actually refreshes. Pointing it at the
right route immediately exposed a real defect, and not one this release
introduced: on a partially-refreshed deployment, completing a sale through a
resting listing fails outright while the direct route completes normally, and it
fails the same way against the previous version of the refresh script. It is
filed with its diagnostic trace and the partial-refresh path should be treated
as unsafe for the listing route until it is understood. Correct routing turned
out to be necessary but not sufficient, which is the sort of thing only a real
rehearsal can tell you.

## Thread — day zero was not a day (#1504)

Absorption credited before the reward schedule starts had nowhere to go, so it went to day 0. Genuine first-day credits landed in the same place. The published day-0 figure was therefore the sum of an arbitrarily long pre-launch period **and** the programme's first real day, with no way to separate them.

That is worse than an odd-looking data point, for two reasons.

The pre-launch period has no fixed length — value accumulates there for as long as it takes to reach launch — so day 0 can dwarf every real day and distort any chart, average, or window that includes it. And the figure feeds the trailing absorption average the programme uses to size each day's recycled budget. That average is a **mean daily rate**; the pre-launch figure is a **stock**. Folding one into the other inflated the earliest budgets for a full window on value no single day produced.

Pre-launch credits now accumulate in their own place, readable on its own, and day 0 means the first scheduled day and nothing else.

**Nothing about the value changes — only where it is attributed.** The tokens are in the recycling balance either way, and every backing, availability and cumulative figure is identical before and after. Several of the tests assert exactly that, because a fix that quietly dropped value would be considerably worse than the defect it replaced. The new figure is published rather than merely excluded: it explains the difference between the balance and the day series, and a reader reconciling the two needs to see it.

**The announcement had to change too, and which shape it takes was the real decision.** Leaving the existing notice saying "day 0" while the value was stored elsewhere would have put the announced and stored versions in disagreement — the exact divergence the platform's own rules are written to prevent, and it would have left the new indexer bucketing pre-launch value into day 0 after the contracts stopped doing so.

Three shapes were available, and the choice was made on **how each fails for a reader that has not been updated**. A special day number puts a magic value into a field several consumers iterate as a day. An added flag is silently absent when unread, and absent reads as *day 0* — which reintroduces the very defect. A separate notice is simply not recognised, so the value is **omitted**. Omission understates the series; the other two inflate it. For a transparency figure the conservative failure is the only acceptable one, and a test asserts that the old notice is not emitted for a pre-launch credit — the property that makes the omission real rather than assumed. It also spares the existing notice a second change of shape so soon after the last one, which would have needed its own cutover and its own historical backfill.

The new notice deliberately carries no day at all. There is no day to name, and a field that always reads zero invites exactly the attribution this change removes.

**Two near-identical places were found and deliberately left alone.** The same pre-launch handling appears on the custody-relocation and consumption notices. Neither writes a day-keyed total, so the day there is a label on a notice rather than an attribution feeding the average or the published series, and pre-launch consumption additionally requires an armed governor, which requires a running schedule. Changing them would have widened this fix on the way past. Both now carry a note saying why they differ and what would justify revisiting them, so the difference does not read as an oversight.

**The new record had to go at the very end, not where it belongs.** Logically it wants to sit beside the day series it was split from. Structurally it cannot: the platform's on-chain records are one long ordered list, and inserting an entry in the middle shifts every later one by a position. A deployment refreshed in place would then read its governor, remittance and commitment state from the wrong places and overwrite unrelated values on the next write. The rule governing that list says reordering is free before launch — which is true of the main network and false of the deployed test networks, which are refreshed in place, and which are exactly where this recycling work is being exercised. It now sits at the tail with a note explaining why, and the check that matters was mechanical rather than visual: the previous list of entries is an exact prefix of the new one, with the single new entry after all of them.

**Two other places had to learn about the new notice, and one of them is a different metric entirely.** The loop-closure ratio buckets by calendar day and asks whether value came back into the system — not which programme day earned it. Pre-launch absorption belongs in it exactly as scheduled absorption does, so leaving that metric reading only the old notice would have made it permanently undercount. A fix aimed at one published figure quietly breaking a second one is the kind of thing that is only obvious once someone points at it. The recycling series itself also stops labelling day 0 as suspect — it no longer is — and publishes the pre-launch quantity as its own line, since that is precisely the term that reconciles the recycling balance against the sum of the days.

**Saying "day 0 is clean now" turned out to be an overclaim, and so did the first two attempts to fix it.** Having scoped the contract note carefully, the dashboard's day-0 warning was then removed outright on the grounds that the figure is now correct by construction — true of a fresh deployment, false of every deployment upgraded in place, including the test networks this work runs on.

The next attempt inferred the answer from event order: once a deployment has announced its first pre-launch credit, its contracts must carry the split. That is unsound in the ordinary case — a fresh deployment that simply takes no credits before launch never announces one, so its first genuine day-0 credit would be marked suspect forever. The absence of an optional signal proves nothing about which version is deployed.

So **no provenance claim is published in either direction.** Which version a deployment runs is an operational fact the event stream does not carry, and a wrong marker is worse than none on a surface whose whole purpose is to be trusted. The pre-launch quantity itself is published, because it is genuinely observed; the endpoint states the limit; and a separate follow-up carries the real answer with its options costed.

**The runway estimate was understated twice, in the same direction, for different reasons.** First it counted only absorption attributed to days, leaving out this deployment's own pre-launch stock — keeping that out of a trailing *rate* says nothing about a lifetime *total*. Then, once that was fixed, it still left out every other chain's pre-launch stock: those credits are announced on their own chains and never reach this one, and the day-by-day reports carry only what each chain's attribution allowance admitted. Each chain now contributes the lifetime total it reports for itself, with its day-attributed credits excluded so nothing is counted twice.

Two smaller corrections in the same pass. The pre-launch total was read after the branch that answers "this chain has no days yet" — the *normal* state before the schedule starts, so the figure would have read zero for exactly the period it exists to describe. And a test that asserted the runway figure was *unchanged* when a new credit arrived was pinning an accident of the old arithmetic rather than the rule it claimed to check; it now asserts the window is unchanged and lets the total grow, which is what a lifetime total is supposed to do.

**A test elsewhere in the suite had been quietly relying on the old behaviour.** The notification-fee fixture never starts the reward schedule, so once pre-launch credits began announcing themselves separately, that suite's expectation of the old notice failed. Before this change both branches produced the same notice and the distinction did not exist; now it does, and an implicit fixture silently tests whichever branch it happens to land in. The test now starts the schedule explicitly for the day-attributed case and a second one covers the pre-launch case — which is not hypothetical, since the notification fee is the first absorption class that runs without any arming and can bill for an arbitrary period before the first day exists.

Worth naming how it was missed: the targeted test selection was the suites *named after* this feature, when the change was to a shared library with five call sites. The right set is every suite exercising a call site, and running that set found no further breakage.

**Two more gaps in the same figure, both about incomplete history.** A database that had already finished the earlier rebuild would have created the new per-chain record empty and never filled it, because that rebuild is one-way and the duplicate-suppression makes a re-run a no-op — so the runway would have omitted every other chain until each happened to report again, and a chain that had gone quiet would have been omitted permanently. The new record is now rebuilt from the stored event history directly, which sidesteps the suppression and is idempotent because it takes a maximum rather than a sum.

And the local term itself was bounded by whenever this consumer started watching. A deployment reports its own self-healing lifetime figure alongside every other chain's, so that is used for the local side when it is larger — larger, not simply substituted, because a report can lag the newest observed credits and a lifetime total must never move backwards on a stale one.

**What the fix cannot do:** it does not rewrite credits already taken. A deployment upgraded in place keeps whatever its day-0 figure already holds. On a fresh deployment — the current posture — day 0 is correct by construction. The published caveat is scoped to say so rather than claiming more than the change delivers.

## Thread — The handover no longer leaves a spending approval behind (#1514)

Handing a loan's obligation over to a replacement borrower asks for a
spending approval just before it executes. If anything then stopped the
handover — the transaction reverted, the borrower declined to sign it,
or a last-moment interlock refused it — that approval stayed granted,
against a form that had nothing left to cancel.

The app's stated intent was already that a handover which does not
happen should leave no pointless approval behind, and it achieved that
by running its eligibility checks BEFORE asking for the approval. One
check cannot work that way: the interlock that watches for a sale of
the lender's position being accepted has to be asked as late as
possible, because catching an acceptance that lands while the review
sits open is its entire purpose. So it necessarily runs after the
approval, and the guarantee no longer held.

Now the handover puts the approval back to whatever it was before the
attempt. Putting it back is the right description rather than
withdrawing it: an approval is not only ever created from nothing, it
is also sometimes raised from an existing smaller figure, and revoking
in that case would destroy a standing arrangement the wallet holds for
some other purpose. Whatever was there before the attempt is what is
there after it.

That care runs in the other direction too. If the approval has changed
since this attempt set it — a second tab, another flow, or the spender
having already drawn on it — the unwind leaves it entirely alone. Its
own idea of the earlier figure is stale by then, and writing it back
would be the same destructive overwrite pointed the opposite way.

Withdrawal is best-effort by design: if it is itself declined, the
original failure stays the reported one rather than being replaced by a
second, more confusing error.

The sibling refinance flow already withdrew its unused approval, and
shared both of the flaws above; it is fixed in the same way. Both are
now covered by tests that pin the exact sequence of approval writes,
including the awkward middle case where a two-step approval is
interrupted after the first step — the point at which the wallet's
earlier figure has already been cleared and genuinely does need
restoring.

One more assumption sat underneath all of this, and it was wrong
everywhere the app used it. A wallet lets you cancel a transaction that
is waiting to be mined, by sending a do-nothing one in its place. The
app's way of asking "did my transaction go through?" was to wait for a
result and check that it succeeded — and for a cancelled transaction
that check passes, because the do-nothing replacement really did
succeed. A transaction that did none of what was asked was therefore
indistinguishable from one that did all of it.

The consequences differed by where it happened. A cancelled approval
was reported as granted, so the flow carried on to a step that could
only fail. A cancelled withdrawal reported the earlier approval as put
back when it was still cleared. A cancelled posting reported an offer
as live when nothing had been posted.

The app now checks that the result it is looking at belongs to the
transaction it sent, rather than to whatever replaced it, and says so
plainly when it does not. Where the intended effect is something the
app can simply look at afterwards — an approval figure, for instance —
it now confirms by looking at that instead, which is a better question
to ask: it answers "did what I wanted happen?" rather than merely "did
some transaction happen?", and so it also covers the chain reorganising
or the wallet's data source being wrong.

That check needed one correction of its own, worth recording because the
first version of it broke something that had been working. Wallets offer
two ways to interfere with a transaction that is waiting: cancelling it,
and speeding it up. Both give it a new identity, but only cancelling
stops it happening — a speed-up is the very same request, paid for more
generously. Rejecting every change of identity therefore told users that
a sped-up approval or offer had failed while it was going through
perfectly well. The app now distinguishes the two, and only treats the
cancelling kind as a failure.

The same care applies to how the app decides an approval landed. Asking
a public data provider what an approval is worth immediately after the
transaction confirms often gets an answer from just before it — the
provider has not caught up. Treating that as proof the approval never
happened would retract something that did happen, and leave the very
approval the app is trying to tidy up standing untouched. So a
disagreement is now only believed when it comes from a provider that
demonstrably has the relevant block; anything less is treated as not
knowing, and not knowing never overrules the app's own confirmation.

Two further consequences of getting the confirmation right, both about
telling the user the truth afterwards.

A sped-up transaction genuinely has a new identity, and several success
panels were still showing the old one — so a link meant to prove the
thing happened pointed at a record that does not exist. Those panels now
show the identity the network actually recorded.

And when a step fails — or is stopped by one of the last-moment checks
that run after the approval — the app tries to tidy up the spending
approval it had asked for. That tidying can itself fail partway, in which case the
approval is left cleared rather than restored — something the person
needs to know about and act on. Previously only the original failure was
shown and the cleanup problem was silent. Both are now reported: the
original failure stays the headline, because it is what they were trying
to do, with the cleanup problem added after it.

Two last corrections, both about the tidy-up being honest rather than
merely quiet.

The tidy-up can reach a third outcome besides working and failing: it
can be unable to find out what happened, when the approval it is chasing
never resolves and the network cannot be re-read. That outcome was being
reported as nothing-to-undo, which is the same thing the app says when
an attempt genuinely left no approval behind — so the person saw only
the original failure while an approval sized for a payoff might still be
about to take effect, or an earlier standing figure might already have
been cleared. Not knowing is now said out loud, alongside the original
failure, because it is a wallet state they may need to act on. Standing
back from the approval in that case is unchanged and still correct: what
changes is that they are told.

And a sped-up approval is now handed to the tidy-up under the identity
the network recorded rather than the one the wallet first offered. A
speed-up replaces the transaction, and data providers stop answering for
the replaced one shortly afterwards — so the tidy-up was left waiting
for something that would never come back, giving up on an approval that
was standing the whole time. The success panels were corrected on this
point earlier; this is the same correction on the path that cleans up
after a failure.

Two more, both on the two-step version of the tidy-up — the one that has
to clear an approval to zero before it can write the earlier figure back.

The check that the clearing step had taken effect was asking about the
moment it happened rather than about the present. If someone granted a
fresh approval in the gap between the clearing and the putting-back —
another tab, another device — that grant was invisible to the check, and
the tidy-up wrote the old figure straight over a decision somebody had
just made. The other guard that might have caught it, which looks for a
transaction still waiting, cannot help here either: by then theirs has
already gone through. The app now asks what the approval is worth right
now, immediately before writing, and stands back if the answer is not
the zero it left there. If it cannot get an answer at all it also stands
back — and says so, because at that point the earlier approval has been
cleared and the person is the only one who can decide whether to grant
it again.

The second is a case where the tidy-up did nothing when it was the one
case it most needed to act. If the clearing step succeeded but the
approval that followed it did not take effect, the tidy-up compared what
was on chain against the figure that never happened, concluded the
approval was no longer its business, and reported success. What had
actually happened is that the person's earlier approval was cleared by
our own confirmed step and never put back. It now recognises that
situation and restores the earlier figure, while keeping the same
protection as everywhere else: it goes ahead only if what is on chain is
exactly what this attempt left there.

Three more places where the tidy-up stayed quiet about an outcome the
person needed. The rule they all break is the one already written down:
saying nothing is a promise that nothing needs acting on, and it can
only be made once that has actually been established.

Two of them are the tidy-up declining to act because another transaction
is in flight on the account. Declining is right — the other transaction
could take effect first and ours would write straight over it — but the
consequence is not nothing. Before the clearing step it means the
payoff-sized approval is still standing; after it, it means the person's
earlier grant is sitting erased and is not being put back. Both were
reported as a clean tidy-up. The same applied when the app could not
even find out whether anything was in flight, which is weaker ground for
staying silent, not stronger.

The third is the pair of checks that ask what the approval was left at.
When neither could get a trustworthy answer — no archive depth on one
side, an unreachable data source on the other — the app fell back to
comparing against a figure it had no confidence in, concluded the
approval was no longer its business, and reported success. What had
actually happened is that it could not tell. It now says so. The
deliberate exception is unchanged and still silent: where a data source
that demonstrably has the relevant block reports that someone else has
moved the approval, that is a real answer about a decision somebody
made, and standing back from it needs no warning.

A Spanish wording fix in the same area, found while checking one flagged
line and turning out to affect six. The offset screens use one Spanish
word, *cancelación*, for two different things: cancelling the offer, and
the payoff that gets collected. In the banner shown after a cancellation
the two meanings sat in the same sentence, so the line that warns "the
spending approval you granted for the payoff is left in place" read as
though the approval had been granted for the cancellation — understating
what the approval can still be used to collect. The payoff sense is now
*pago* throughout those screens, matching the wording the refinance
screens already use; the one place the word genuinely means cancelling
is unchanged. No other language had the problem.

One last place the tidy-up mistook its own unfinished work for somebody
else's decision. After clearing the approval, the app checks what the
value is now before putting the earlier grant back. Any figure other
than zero was read as "someone else has since granted something here",
and the app stepped back without a word — correct when it really is
someone else's grant, and wrong when the figure it is looking at is its
own. Our own value still standing means the clearing step did not hold
after all: undone by a chain reorganisation, or a token that reported
success without moving anything. Nothing else claimed the slot, so there
is no other decision to defer to — only the tidy-up having failed, with
the payoff-sized approval still live and the person told everything was
clean. The neighbouring check already drew this distinction; this one
now does too, and a genuine competing grant still steps back quietly.

Finally, the same honesty now applies to the last step of all. Having
cleared the approval and written the earlier figure back, the app checks
that the figure really is there — and until now, being unable to check
was treated as success. Everywhere else in this flow that outcome is
reported, for a reason that applies here most of all: at that point the
person's approval has definitely been cleared and only might have been
restored. If the putting-back was undone, or the token reported success
without moving anything, they were told the tidy-up was clean while their
approval sat at zero, with nothing to prompt them to look. Being unable
to confirm is now reported alongside the original failure, in the same
words the rest of the flow uses: check this token's approvals in your
wallet.

## Thread — Linting for the connected app (#1516)

The connected app ran no linting at all. It had type-checking, a
hardcoded-string guard, unit tests, a production build and a preview
deploy on every change — and none of those can see a React hook called
in the wrong place. That gap let a defect reach a merge-ready state in
the previous change: a hook placed below the position page's
loading branch, which meant the page requested a different number of
hooks on its first render than on its second, and React aborts the page
outright when that happens. It would have crashed the position page on
every single load, and it was caught by a reading pass rather than by
any automated check.

This adds the missing check, deliberately narrow. The one rule that
catches that defect is now enforced and fails the build; the connected
app is clean against it today, so it starts enforcing rather than
starting as a backlog. The linter's other, newer advice — about work
done in the wrong phase of rendering — is recorded as warnings for now
and tracked separately, because switching it on wholesale would have
meant either a large unrelated rewrite bundled into a plumbing change,
or quietly downgrading the whole check to advice to get it passing.
Advice nobody has to act on is how this gap appeared in the first
place.

The check runs inside the same command continuous integration already
invokes for this app, so enforcement needed no new pipeline step.

Running the same check against the older connected surface — which has
had a lint configuration for some time that nothing has ever executed —
found the identical defect class fourteen more times, one of them a
live crash on its offer-creation form. That surface is being retired in
favour of this one, so those go unfixed by decision rather than by
oversight; they are recorded for anyone who reads its code before it
goes. The more useful reading is that the same blind spot produced the
same bug in both apps independently, which is the argument for the
check existing at all rather than for any particular fix.

## Thread — The e2e harness now says when the testnet is behind (#1518)

The browser-level test tier runs against a fork of the live test
network, but with the contract interfaces from the current checkout.
That works only while the two agree. When a merged contract change
widens a value the app reads and the test network has not been
redeployed yet, every read of that value fails to decode — and because
those reads are batched, one failure empties the whole offer book. The
tests that need an offer then fail with timeouts that name the offer
book and never the actual cause.

This is not hypothetical. A change in late July appended three fields
to the offer record and correctly regenerated the interface files in
the same commit, exactly as the process requires. What that process
does not cover is the deployed test network, which has been serving the
older, narrower record ever since. The tier has been failing on the
main branch for roughly two weeks, always the same four tests, and the
cause was found only while checking an unrelated merge.

The harness now probes the shape of the records it depends on when it
starts, and prints an explicit banner naming the mismatch, the two
widths, and the deploy command that fixes it. It stays a warning rather
than a refusal to start: the tier still has value with a stale network,
since the tests that never read the affected records pass, and turning
a deploy lag into no coverage at all would trade one silent failure for
a louder one. What was missing was never the failure — it was being
told which failure it is.

The underlying mismatch itself is now gone: the contracts were
redeployed to the test network, which is what the banner was telling
anyone who read it to do. The records the app reads and the records the
network serves agree again, and the browser-level tests that had been
failing on it can run properly.

The banner stays regardless. The mismatch it caught was not a mistake by
anyone — the change that introduced it followed the documented process
exactly; that process simply says nothing about the deployed test
network, so the two drifted apart quietly and stayed that way for two
weeks. Nothing about the redeploy prevents the same drift the next time
a contract change lands ahead of a deployment. What has changed is that
the next occurrence announces itself in the first seconds of a test run
instead of hiding behind four unrelated-looking failures.

That proved its worth immediately. Clearing the first mismatch revealed
a second one hiding behind it, of the same family but a different kind —
the offer-state gap described in its own note alongside this one. Four
tests were still failing, for a reason that looked identical from the
outside.

The deeper problem was never either mismatch. It was that a single
unrecognised offer took down the entire book: the harness read every
offer at once and refused all of them if any one was unfamiliar, so a
one-offer problem presented as a total outage with no hint of its cause.
Twice now that has cost weeks. The harness still refuses to guess at a
state it does not recognise, but it now omits just that offer and says
which value it did not understand, so the failure is proportional to the
fact rather than to where it happened to sit in the list.

## Thread — the Create Offer page could be taken down by a dropdown (PR #1601)

Changing the asset type on the connected app's Create Offer page could
crash it outright. The periodic-interest cadence field hid itself for
illiquid offers by returning early, and two memoised calculations sat
below that return. Because the liquidity decision is derived from live
form state, switching from a liquid asset to an illiquid one changed
how many hooks the component called between one render and the next,
which React treats as unrecoverable — the page aborts rather than
re-rendering. The fix moves the two "render nothing" gates below the
calculations. Both are pure, so running them on a path that displays
nothing costs a little work and changes no behaviour.

This was found by the linting work in #1529 rather than by anyone using
the app, which is the uncomfortable part: `apps/defi` has carried a lint
configuration for months that no automated job has ever executed, and a
real crash sat in it undisturbed. The same scan reported thirteen more
violations of the same rule. Two turned out to be latent rather than
live — one is gated on a build-time environment flag and the other on a
lookup that does not vary for a given element — but latent is a property
of today's conditions, not a guarantee. Both are fixed here as well. The
admin console needed more than moving its gate: eleven hooks sat below a
redirect for visitors who are not supposed to reach the page, and simply
lowering the redirect would have run the console's chain reads for
exactly those visitors. It is now split so the gate is hook-free and the
dashboard calls its hooks unconditionally — which is also the shape the
planned wallet-aware gating needs, since that will make the condition
runtime-driven and turn the old arrangement into a live crash.

Review then caught the sweep being narrower than it looked. The
documentation component that had been fixed lives in the connected app,
and that copy turns out to be unreachable — nothing renders it. The
component the documentation pages actually render is the marketing
site's near-identical copy, which still carried the same defect, on
pages that really are served: the whitepaper, the overview, the user
guide and the parameter reference. That copy is fixed here too, along
with four more conditional hooks on the parameter-reference page, which
needed the same gate-and-inner split as the admin console for the same
reason. The duplicate itself is left alone for now and tracked
separately (#1603) — two look-alike files where only one is rendered is
a trap that already cost this change a review round, but deleting dead
code is its own piece of work.

Guarding the fix mattered as much as making it. Wiring the app's full
lint into CI is not currently possible — it reports several hundred
pre-existing errors, mostly untyped values — and waiting for that
backlog is precisely what let this crash class survive. So CI now runs a
single-rule check for conditional hooks, the one rule the app is clean
against, alongside the existing type check. Reinstating the original bug
shape makes it fail with the two calculations named. The narrow check is
deliberately quiet about everything else: an earlier draft reported
forty-two problems it did not care about, and a guard that cries wolf is
one people stop reading — the habit that started this.

The marketing site needed the same guard and had even less: no lint
configuration of any kind, which is why nothing could have reported the
defect on its pages. It now runs the same single-rule check, verified
the same way.

The first attempt at stating the coverage was wrong, and review caught
that too. It named the apps this work happened to touch rather than
listing what the repository actually contains, and two more deployable
React apps were missing — one with no lint configuration at all, one
whose configuration existed but was never run, and neither typechecked
by the build at all. Both are clean of this defect today and both are
now guarded and typechecked, so the coverage claim is a statement about
an enumerated list rather than an impression. Every deployable surface
that renders React now fails its build on a conditional hook: the
connected app, the marketing site, and all three alpha surfaces.

No functional-spec change accompanies this: the intended behaviour was
always that the page works, and nothing about what the product is meant
to do has changed.

Closes #1521

## The retained reserve, published only alongside the tokens behind it (#1525)

The public recycling account already showed where each day's reward pool came from and how much was drawn. It did not show the one figure people most want from a reserve: **how much the platform has retained** — and, deliberately, it showed nothing rather than showing that figure alone.

The reason is the difference between this number and every other number on the page. All the others are computed from the platform's own internal counters. A counter is a record of what *should* have happened, and it cannot notice that the tokens it describes have since left. A reserve figure derived that way can report perfect health over an account with nothing in it, and a reader has no way to tell.

So the reserve is published **beside the token balance actually held**, and the two travel together or not at all. There is no falling back to the counter-derived half when the balance is unavailable — the page publishes neither, and says why. A reserve on its own is exactly the confident, checkable-*looking* number this requirement exists to prevent.

Worth being precise about what "unavailable" means here, since the reading is captured on a schedule rather than fetched per visit: a capture that fails does **not** blank the section. The last acceptable reading continues to be shown, with its own timestamp, until it passes the point where the schedule should have replaced it — or until the chain it came from stops advancing. Only then is the pair withheld. Blanking on the first failed capture would replace a slightly older true figure with nothing, which is worse for the question being asked.

Several figures now appear together: what the platform has retained, the VPFI it actually holds, how much of that holding is labelled as recycled runway, how much sits outside that label, and a plain answer to whether the recycled pool is fully backed — with the size of any shortfall. The balance is what makes the reserve checkable; the plain answer is there because the numbers alone cannot distinguish a pool that has been exactly spent down from one that is short.

**Two details that are easy to get subtly wrong, and were:**

The retained figure nets out both value already promised to users *and* the share set aside to pay for permissionless upkeep. That second term is carved from inside the same balance without reducing it, so a reserve that nets only the first is correct exactly while the upkeep share is switched off, and begins overstating silently the day it is switched on.

The figure is floored at zero. The subtraction can genuinely go negative — that is what a shortfall looks like — but a negative reserve rendered on a public page reads as a display bug rather than as the problem it is. The balance published beside it is what makes that state visible instead, which is the whole reason the pair exists.

Reading the live chain also introduces a way for the page to fail that the rest of it does not have. That failure is contained: the day-by-day account comes from the platform's own records and stays readable, and only the reserve block reports itself unavailable — with the reason, since a blank reads as zero and zero is the opposite of *we could not check*.

**Two of the figures were, on their own, capable of misleading.**

The "balance outside the pool" number is floored at zero. That means a pool the platform has exactly spent down and a pool it is genuinely *short of* display the same value — the ambiguity is built into the figure rather than being a fault in it. A page showing only that number publishes the healthy and the broken state identically, which is the one distinction the whole block exists to draw. So the page now answers the question directly: whether the pool is fully backed, and if not, by how much it falls short.

That same number was also labelled "not earmarked for anyone", which claimed more than it can support. It sets aside one kind of commitment, not all of them — value the platform is holding on a user's behalf is still counted inside it. Describing that as belonging to nobody would tell a reader the platform has more freely available than it does. It is now described as what it is: the balance sitting outside the recycled pool.

**And a set of failures that would have misled rather than simply degraded.** The capture confirms it is talking to the chain it thinks it is — an endpoint pointed at the wrong network answers perfectly well, and would otherwise have recorded another network's reserve under this one's name — and it records *which* deployment the figures came from, because replacing the contract on a chain would otherwise leave the previous one's balances being served as current, a healthy predecessor masking an empty successor. A reading that stops being refreshed is withheld rather than served indefinitely, and so is one whose chain has stopped advancing: those are different faults with different responses. And a reading can never move backwards — an older capture arriving late cannot replace a newer one, which would quietly walk the published verdict back in time.

One figure needed its name changed after a closer look at what the underlying counter does. Value released from the recycled pool is recorded permanently — if the transfer later goes through after all, the recipient gets it but the counter is deliberately never wound back. Calling that row "sent but not yet delivered" would therefore become untrue the moment a delayed release completed, and stay untrue. It now says what the counter actually measures: value released from the pool and never credited back to it.

The two chain reads behind this section are pinned to a single block. They exist to explain each other — the second is what stops released value looking like a depleted reserve — and read independently, a release landing between them produces exactly the misleading pair the second read was added to prevent. That block is published too, so the figures can be reproduced by anyone rather than taken on trust.

**A note on how this is read from the chain, because the first design was wrong in an instructive way.**

The reserve and the balance behind it were originally read from the chain *while answering each request for the page*. That sounds like the freshest possible answer and it is, but it couples a blockchain round trip to a browser request — and every consequence of that coupling then has to be solved separately: the read has to finish before the browser gives up, or it takes the rest of the page down with it; simultaneous *and* consecutive visitors have to be prevented from each spending a call against the same quota the platform's own indexing depends on; that prevention has to work across the many isolated instances serving the page; and each visitor waiting on a shared read needs their own time limit. Each of those was fixed, and each fix produced the next problem.

None of them exist if answering the page does no network work at all. The platform already reads the chain on a schedule, so the reserve is captured there and the page serves what was stored.

The cost is that the figures trail the chain, and **the page now shows the timestamp of the state they describe**. How far they trail depends on how many chains the platform is reading — captures rotate one chain at a time — so the page states the timestamp rather than promising an interval it cannot keep at every size. If the reading falls further behind than the rotation should allow, or the chain it came from stops advancing, the whole section is withheld rather than shown as current.

That disclosure is the part I originally had wrong: I justified serving a not-quite-live figure on the grounds that its age was published, when it was only present in the underlying data and never shown to anyone. A disclosure a reader cannot see is not a disclosure. For a question like *do the tokens behind this reserve exist*, a reading somewhat behind the chain answers it perfectly well — but only if the reader can tell how far behind it is.


## The keeper's kill-switch does not stop everything, and now says so

No behaviour has changed. What changed is a description that was misleading in a way that mattered.

The keeper's master switch was documented as disabling "autonomous actions". In fact it disables six of the periodic jobs — the ones that lend, liquidate, extend loans, and move reward budget — and leaves **four** running: the daily oracle snapshot, the health-factor watcher, the pre-grace watcher, and the liquidity-confidence pass. The snapshot keeps signing and spending gas whenever a signing key is present, switch or no switch; the watchers keep reading, keep writing their bookkeeping, and **keep sending notifications to users**.

**The snapshot gap is deliberate and has been affirmed rather than closed.** It is a public good rather than a risk-taking action — anyone can trigger it, permissionlessly, and the protocol wants the price series unbroken. Gating it would punch holes in that series every time the keeper was switched off for some unrelated reason, which is a worse outcome than the gas it costs.

The watchers are a different case and worth stating plainly, because it is the one an operator is most likely to be surprised by: **turning the switch off does not stop users being messaged.** The health-factor watcher continues to evaluate positions and send alerts. If the reason for reaching for the switch is that something is wrong and users should not be hearing from the system, the switch alone does not achieve that — stopping the schedule does.

What was wrong was only the wording, and the practical consequence of getting it wrong: an operator flipping the switch to stop the keeper spending money would have found it still spending. The documentation now states the exception plainly, names the six jobs the switch does cover, and gives the actual answer for a full stop: **stop the schedule.** The keeper has no web surface — every job runs on a timer — so emptying its timer list stops all of them, snapshot included, in one reversible step. Reaching for the signing key instead is a trap: it lives in an account-level store, and the obvious per-job command silently edits a copy that is ignored — so the change appears to work and the keeper keeps signing. Removing the store entry is a rotation-grade operation with no documented procedure, which is reason enough not to improvise it mid-incident. (An earlier draft also said it would affect every other consumer; it would not — the keeper is the only holder of that key.)

A second job is called out in the same place, and the switch is narrower there than it looks: the liquidity-confidence pass always runs, and consults the switch only when deciding whether to send a transaction. It keeps reading, and it keeps updating its own bookkeeping either way — deliberately, so the counter it maintains stays continuous. So the switch stops what that job spends, not what it stores.

## The last two untranslated messages are filled, and the gap record is closed

Two messages were still shown in English to everyone: the one that says an
offer can no longer be accepted because the person who created it has changed
their own risk settings, and the one that says the deal needs a higher risk
level than the reader's vault currently allows. Both appear at the moment an
acceptance is refused — exactly when a reader most needs to understand why, and
the worst possible place to switch language.

They are now written in all nine offered languages. The instruction that tells
the reader where to raise their risk level names the menu items as that
language actually labels them, rather than the English ones, so someone
following the sentence finds the entry it points at. Each message also ends
with the same reassurance the neighbouring refusal already used in that
language, so the three do not each phrase "nothing was sent or approved" a
different way.

With these filled, the list of known-missing entries is empty. That list was
never a place to park things: every entry had to be deleted as it was filled,
and the requirement it was measured against was deliberately never softened to
match whatever happened to be finished. It shrank from a hundred and sixty
entries per language to two to none.

That closes one question and not the bigger one. The list tracked wording that
was ABSENT, and every language now has every entry. But an entry can be present
and still hold the English words, and several hundred do — Hindi most of all —
so a reader can still meet English partway down a page in a language we offer
as translated. The check cannot see those, because it asks whether an entry
exists rather than what it says. That gap is now recorded and tracked
separately; it needs a decision about which entries are meant to read the same
in every language (brand names, token symbols) before it can be checked
automatically.

Filling the list closes one question but not the one people actually care
about. Checking the wording files proves the sentences were written; it does
not prove a reader ever sees them, because each language is fetched separately
while the page is loading and that fetch can fail without anything appearing to
be wrong — the reader simply gets English and no error is reported. So a review
now opens the deployed Recovery page once per language, checks that the wording
file the page actually downloaded is the one this change produces, and confirms
the page genuinely changed language, shows the expected heading, and lays
Arabic out right-to-left.

All nine passed on a build made from this change. They do not pass against the
currently published site, and that is the check working rather than failing:
the published site was built before this change, so it does not yet carry the
two new messages. It will pass there once this is released — which is the point
of checking the downloaded file rather than something that was already correct
beforehand.

## Thread — Recovery and Risk access are readable in every offered language (PR #1563)

The nine languages alpha02 presents as translated — Spanish, French, German,
Japanese, Chinese, Hindi, Tamil, Korean, Arabic — were each missing 291 of the
English catalog's keys, including every string on the two most recently shipped
pages. Nothing looked broken, because the app falls back to English key by key;
what a user actually got was a page that switched to English partway down. On the
stuck-token recovery page that is the worst possible place for it, since the page
asks the user to sign a declaration attesting they understood what they are
signing. This fills Recovery and Risk access across all nine, and leaves the
remaining older sections tracked as follow-up.

One of the translated strings was load-bearing in a way translation would have
broken: the recovery page makes the user type `CONFIRM` as a deliberate speed
bump, and the app compares that input against the literal English word. A locale
that translated it would have rendered a gate no user of that language could
pass — they type the word the page asks for, it never matches, and the sign
button stays disabled. `CONFIRM` is now in the shared do-not-translate glossary
alongside the protocol terms, so the machine-translation path can't reintroduce
the problem.

The gap existed because nothing was watching for it. The template drift check
guards the English catalog against the app's copy, but nothing guarded the
translated bundles against the template, and the shared translate script had no
mode that could top a locale up — it either skipped anything that wasn't an empty
placeholder, or overwrote the whole file. So every locale silently froze at the
key set it had on the day it was first generated. There is now a gap-fill mode
that translates only the missing keys and merges them back, a matching merge path
for translations that arrive by hand rather than from the API, and a build-time
guard that fails when a language offered as translated falls behind the template
— with the remaining backlog recorded as named sections rather than absorbed into
a tolerance, so a new untranslated section fails even though the total is
unchanged.

The same guard now also checks that interpolated values survive translation
(previously tracked as a to-do): a translation may reorder the values or, where
the grammar already carries one, leave it out — Arabic's dual form means "two
days" in the noun itself, so restating the count there would read "2 two-days" —
but it can never introduce a value slot the English lacks, which renders to the
user as literal braces. That class of bug is invisible in review, because a
reviewer reading fluent Tamil does not see the `{{amount}}` that isn't there, and
it surfaces at render time in one language only, often on the sentence quoting a
number the user is about to sign for.

Review then found the one place the page still switched languages at the worst
possible moment. The declaration a user signs to recover tokens is fixed English
by necessity — its hash has to match a value stored in the contract, so
translating the signed bytes is impossible — and it was rendered in English
only. A reader of another language was therefore attesting, in a language they
might not read, that they had understood what they were attesting to. The signed
text is unchanged; a translation of it now appears alongside, labelled so which
of the two is authoritative is never in doubt.

That aid appears only when a translation for the reader's language genuinely
exists. Roughly three times as many languages can be selected as are currently
translated, and a translated language's text can also fail to load on a bad
connection; in both cases the page is English throughout. Presenting that English
under a label reading "in your language" would be a false statement made at the
precise moment the user affirms they understood what they read, so in that state
the aid is omitted entirely. It reappears by itself if the translation arrives.

Text that merely repeats the English word for word does not count as a
translation here either — a supplier can return the source text unchanged, and
nothing about the string itself gives that away. Nor does a translated
declaration sitting under an English label, since the label is what tells the
reader which language they are being shown. Both halves are in the reader's
language, or neither is displayed.

Review then found that the English wording of that aid was a second, independent
copy of the declaration itself, sitting in the copy catalog with nothing tying it
to the one the page actually signs. Two copies of the same sentence can drift,
and the drift would be silent: change the declaration to match a new contract and
the aid keeps explaining the old one while still being labelled as saying what
the user is signing. There is now one definition that both the page and the
catalog read, so the English can no longer diverge at all. The nine translations
cannot be derived from it, so the release gate pins the declaration's fingerprint
instead — change the declaration and the build fails until the translations are
re-authored. A stale reading aid is therefore not something that can ship.

Review also caught three strings belonging to these two surfaces that this change
had left for later: the browser-tab titles for the recovery and risk-access
pages, and the one-line description beside the Risk access entry in Settings.
They are translated now, so the two pages this release claims to finish are
finished.

Two translation-tooling scripts could also be stopped dead by a single damaged
locale file: whichever one sorted first would abort the run before any healthy
locale was reached, reporting a raw crash rather than naming the file. Both now
name the bad file and carry on with the rest — and the gap-fill sweep reports the
run as failed when it does, rather than finishing quietly. Skipping a file so one
casualty cannot stop the batch is not the same as pretending it was fine: the
sweep's whole claim is that every offered language now matches the template, and
a bundle it could not read is one it never checked.

Closes #1560. The larger backlog this change was expected to leave behind —
offset, tariff, early repay, transfer obligation, sale hold, loan sale and a
few strays — was filled separately while this work was in review, so what
remains is two keys: the pair of messages shown when an offer cannot be matched
because the creator's risk settings no longer cover the deal, or because the
deal needs a higher risk level than the vault allows. They are the only entries
left in the guard's allowlist, and each has to be removed as it is filled.

## Thread — The recovery live review stops failing on Cloudflare's own beacon (PR #1566)

The post-deploy review driver for the stuck-token recovery page fails the run if
anything tries to write while it is browsing — the review claims to be read-only,
so an attempted transaction or backend call underneath otherwise-green checks is
a finding in its own right, not noise.

One thing it was catching is not a write by anything we ship: Cloudflare injects
its own monitoring beacon into pages it serves, and that beacon posts. It is
correct to block it during a read-only run, and useless to fail on it — it says
nothing about whether the page under review tried to change anything, and it
fires on the marketing site the driver opens in a second tab, which is a
different app entirely.

Left alone, this would have made every future production run of the driver
report a failure that nobody could act on, which is the reliable way to get a
check ignored — and the real violation it exists to catch ignored along with it.
The beacon is now reported as expected and excluded from the verdict, as a
narrow exemption for Cloudflare's reserved edge path rather than a relaxation of
the rule. Any other blocked request still fails.

Confirmed on the run immediately after the guide fix reached production: all
fifteen checks pass, with the beacon listed as expected. Under the previous
behaviour that same run would have reported failure.

## Deep links into the user guide now land in every language, and a blind spot in the check that proves it

Two long-standing gaps in the guide are closed.

The Advanced guide's section on how a VPFI discount tier travels between
chains existed only in English. It is now written in all nine other languages.
It ends by pointing the reader at the fuller discount walkthrough, and because
that chapter is still English-only, each translation says so plainly rather
than sending the reader after something their edition does not contain.

The Korean Basic guide carried a section no other edition had, including the
English it was translated from: it described a withdraw control on the Rewards
page. There is no such control there — the same action lives on the VPFI page,
and the Korean Basic guide already describes it correctly in that chapter. The
stray has been removed. (The Advanced guide mentions the same action under
Rewards in every language including English, where it says plainly that it is
the same surface as the VPFI one. That is the source's own choice, present
everywhere, so it is not a divergence and is left alone.)

The English guide also introduced three points with the words "two things to
know". It now says three.

The more useful outcome is what closing those gaps exposed. The check that
compares editions worked by comparing the hand-written link targets each one
carries. That can only see a section that went missing while its neighbours
stayed — if an entire chapter is absent from a translation, every link target
it would have contributed is missing from both sides of the comparison at
once, and the check has nothing to compare. It reported all ten editions in
agreement while every one of the nine was missing a whole chapter, and two of
them were missing three.

The check now also compares how many chapters each edition has. The known
shortfalls are recorded so they cannot quietly grow, and a recorded shortfall
that has been fixed must be removed or the check fails — the record cannot
drift out of date in either direction. Translating those chapters is tracked
separately; it is roughly ninety-six thousand characters of translated output
across the nine languages, which is a translation project rather than a repair
to the check.

Chasing exactly what counts as a chapter turned up a defect on the live English
site, which is now filed on its own. The guide builds its contents list from the
link targets under each chapter, and drops any chapter that has none — so "How
VPFI Discounts Work" is printed on the Advanced page today but appears nowhere
in its contents list. A reader can only reach it by scrolling past everything
above it. Counting chapters the way the contents list does would have hidden
that, and would also have stopped reporting the chapter the nine translations
are genuinely missing, so the check counts what each file contains instead. The
difference between the two counts is the bug.

Counting chapters correctly turned out to be its own small lesson. It began as
a scan of the raw text for lines starting with two hashes, and review found a
new way for that to be wrong six times over: a code sample inside another code
sample, a heading separated by a tab instead of a space, an indented block that
only looks like a code sample, a heading hidden inside an HTML comment. Every
individual fix was right, and every one was followed by another case, because
what was being written was a Markdown parser — in a guard script, by hand. The
check now asks the same parser the website itself renders with, and all of
those cases stop being special: they are simply not chapters, along with the
ones nobody has thought of yet.

## Thread — The recovery guide link now actually lands on the guide (PR #1561)

The connected app's stuck-token recovery flow makes the user sign a declaration
stating they have read the Advanced User Guide's section on stuck-token
recovery, and links them to it. That link has been landing on the wrong place:
it opened the guide, but not the section. Users got the top of a very long
document and had to find the section themselves — while having attested they
had read it.

The cause was two id schemes quietly competing. The guide files mark their
sections with stable, hand-authored anchors that are identical in every
language, and a plugin correctly attached those to the right headings. But the
component that renders headings then rewrote each one with an id derived from
the heading's own text, discarding the anchor the plugin had just computed. The
anchor never reached the page. Now the heading keeps its text-derived id — the
guide's own contents list links to those, so it has to — and the hand-authored
anchor renders as its own marker immediately before the heading. Both kinds of
link work, and the off-site one keeps working in every language, which is the
whole reason those anchors exist: the text-derived id changes when the heading
is translated, the hand-authored one does not.

This surfaced because the post-deploy review driver for the recovery page was
hardened first, and its previous version had been reporting the link healthy.
It checked that the URL returned a success status — but the marketing site
serves its app shell with a success status for *every* unknown path, so that
check could never have failed, whatever the link pointed at. It now opens the
link and requires the attested section to actually be present on the page it
reaches.

Seven other checks in the same driver were tightened for the same reason —
each could report green while the thing it named was broken. The discoverability
gate (recovery is deliberately unlisted; the Help explainer is the only way in)
was looking for links whose *label* mentioned recovery, so a link added under
any other wording would have passed unnoticed; it now looks at where links
point. The robots directive was read from the page's own markup rather than
from the server response, which is what a crawler that runs no JavaScript
actually sees. Two checks raced the page instead of waiting for it, so a slow
but healthy deployment could be reported broken. The driver also discarded the
read-only guard's own record of blocked write attempts, meaning the run could
print "all checks passed" over an attempted transaction; those now fail the run.
And where the page correctly withholds the recovery form because the connected
wallet is flagged or has an unresolved attempt outstanding, that is now reported
as a skip rather than a deployment failure.

The anchor mechanism was also only ever installed on the user guide, even though
the same stable-link promise covers the overview and whitepaper — an author
adding one of those anchors to either document would have found it silently did
nothing. It now applies to all three. And the marker the browser actually scrolls
to had no allowance for the fixed header, so even once the anchor existed the
link would have landed with the section's own title hidden behind the navbar; it
now clears it by the same margin the headings use.

Five further checks in the driver were tightened in a second review round. The
Help deep link is now required to point at this app's own recovery route rather
than merely a path that looks like one — a link redirected to another site would
otherwise have been reported as the working entry point. The Settings scan waits
for that page to actually render, because it loads lazily and its placeholder has
no links at all, which made a deployment that *had* added the forbidden link look
clean. And the separately-opened guide page now reports its own errors, which the
run's closing claim about uncaught errors did not previously cover.

The marketing site deploys automatically from the default branch, so the guide
link starts working in production as soon as this lands — no separate release
step. The fix was verified ahead of that on the branch's own preview deployment,
built by the same pipeline that publishes the live site: the anchor is present,
it sits immediately before the section it names, and the section title lands
clear of the fixed header rather than behind it.

## Operators can now be told when a chain is sitting on more recycled VPFI than it uses

Each chain accumulates recycled VPFI from fees that land on it, and spends it
funding that chain's own reward claims. A quiet chain can therefore build up a
balance it has no near-term use for, while a busy one runs lean — and until now
nothing surfaced that difference. An operator had to go looking.

There is now a per-chain **surplus flag**. A mirror chain is flagged when the
recycled VPFI available to it exceeds a configured multiple of what it has
actually been budgeting per day, averaged over the trailing thirty days.
Alongside the flag, the same read reports the availability, the trailing
average, the threshold it was compared against, and the configured multiple — so
an operator can see *why* something is or is not flagged rather than only that
it is.

**It covers the mirror chains, and asking it about the canonical chain fails
rather than answering.** That is deliberate on two counts: the figure it would
produce for the canonical chain is a lifetime total rather than what is
currently available, so the flag would stay raised for funds already spent and
nothing could clear it; and the flag exists to surface candidates for moving
surplus *back* to the canonical chain, which the canonical chain can never be.
Its own recycled position is reported by the existing composition and backing
reads. An operator scanning for surplus should scan the mirrors.

**The flag moves nothing.** It is a signal, and only a signal. Deciding what to
do about a flagged surplus — including whether to move any of it — is separate
work, kept deliberate on purpose.

**It is off by default.** The multiple ships unset, and while unset nothing is
ever flagged. That is a deliberate choice rather than an oversight: there is no
threshold that is right for every deployment, and a warning that starts firing
before anyone has decided what it means is a warning people learn to ignore. An
administrator turns it on by choosing a multiple, and can turn it off again by
clearing it.

Two judgements inside the flag are worth stating, because they change which
chains it catches:

- It measures against what a chain **budgeted**, not what it managed to spend
  from its own balance. Those are the same number for a chain with plenty
  available, and they diverge exactly when a chain is running short — where a
  spend-based measure would make the warning *harder* to clear the worse the
  situation got.
- Days on which a chain budgeted nothing count as zero rather than being skipped.
  A single busy day in an otherwise idle month therefore reads as an idle month
  with one busy day, which is what it is — not as a month of steady demand.

A chain holding funds while budgeting nothing at all for the whole window is
flagged. That is the clearest case of the thing the flag exists to find, so it
is reported rather than treated as a figure that cannot be computed.

## Planned-surplus repatriation — the accounting core lands dark (#1568, part 1)

The recycling programme gained the ledger half of "Mode A" repatriation:
the books that let the canonical chain deliberately move a mirror chain's
surplus recycled value back home, without ever conflating that movement
with reward spending.

What shipped, in behaviour terms:

- The canonical chain can now issue a bounded, releasable **authorization**
  against a specific chain's surplus. Issuing one immediately stops that
  amount being offered to any later funding round — the safe direction: an
  instruction that is still in flight can never be double-spent by the
  daily mesh.
- An authorization ends in exactly one of two ways: the value **arrives**
  (the books close it, and any transfer-fee gap is recorded openly rather
  than silently absorbed), or the mirror **confirms cancellation** (the
  amount becomes offerable again). Merely believing an instruction was
  never executed releases nothing — belief is not evidence.
- Arriving value re-enters the canonical books as a **custody move**, never
  as new absorption — so the transparency figures that size reward budgets
  cannot count the same value twice.
- A mirror's own books gained the matching outflow record, so the
  cross-chain composition picture stays exact after a repatriation.
- The whole surface is **dark by default**: until the cross-chain transport
  for this path is deployed and explicitly configured, every entry point
  refuses to act, on every deployment.

The safety rule this enforces (and the reason the earlier plan wording was
corrected): a repatriation is tracked in its **own** ledger pair, never by
borrowing the counter that tracks reward consumption — borrowing it would
corrupt the identity the mesh watcher checks on every tick. The mesh
invariant suite now drives this new draw alongside hostile report
magnitudes, and the transparency views publish its raw figures.

The moving half — the actual cross-chain send/receive machinery and its
operational watcher checks — follows as its own change.

## Planned-surplus repatriation — the transport goes live end-to-end (#1568, part 2)

Part 1 shipped the books; this change ships the movement. The recycling
programme's "Mode A" repatriation can now actually carry a mirror chain's
surplus recycled value back to the canonical chain, under the
authorization lifecycle the accounting core pinned.

What shipped, in behaviour terms:

- The canonical chain can now **dispatch** an issued authorization to its
  target mirror as a cross-chain instruction. Dispatching is open to
  anyone and repeatable — the content comes entirely from the stored
  authorization, and the mirror records an instruction at most once — so
  a lost message never needs an operator to recover.
- On the mirror, a recorded instruction is **executed** by anyone willing
  to pay the message fee: the surplus leaves the mirror's recycle bucket
  (bounded so claim backing and the keeper reserve can never be taken),
  and the value travels home with a payload that names the exact
  authorization it answers. Execution happens at most once, permanently.
- Cancellation now works end-to-end: the canonical chain requests it, the
  mirror marks the instruction dead — even one that never arrived, so a
  late instruction lands on a closed record — and sends back a signed-off
  confirmation. Only that confirmation releases the authorized amount for
  re-offering, exactly as part 1 promised. A cancellation can never race
  an execution into doing both: the two outcomes share one record.
- The value returns over a **new, shared return channel** with its own
  send and receive endpoints on each side. Each kind of return traffic is
  its own wire protocol on that channel; a delivery of a kind a receiver
  does not yet understand fails cleanly and can be re-delivered after the
  upgrade — a partial rollout can never mis-book a return silently. The
  planned stranded-value recovery path ("Mode B") will join the same
  channel later with its own protocol.
- Deployment tooling deploys and wires the two channel endpoints per
  chain role, arms the Diamond's endpoints, and puts both under the same
  incident-pause guardian as every other cross-chain surface. Both
  endpoints also join the governance ownership handover ceremony, so
  after handover no single operator key retains upgrade or re-pointing
  authority over the channel.
- Authorizations and executions are bounded by the lane's **live
  transfer capacity, read from the transport itself at each check** —
  the canonical chain checks its inbound limit at issuance, the mirror
  its outbound limit before the irreversible execution step. The whole
  reference chain is resolved live (the transport's own token registry
  names the ACTIVE transfer contract, which is asked whether it even
  carries the lane before its limit is read), so a transfer-contract
  upgrade is picked up by the very next check, a REMOVED lane refuses
  rather than reading as unlimited, and there is nothing to arm,
  record, or keep in sync when capacities change. A single transfer
  above either capacity would be rejected permanently by the transport,
  so an over-capacity request — which could only ever strand its
  reserved amount until cancellation — is refused before it commits
  anything; an unconfigured transport reference refuses rather than
  passes.
- The incident tooling knows the new endpoints: the all-chains pause
  sweep and the testnet pause rehearsal both enumerate the return
  channel's sender and receiver, so an incident pause engages — and its
  completion check verifies — the channel's own containment, not just
  the surrounding surfaces'.
- The mesh watcher now understands repatriation: the availability figure
  it re-derives nets out live draws, a new check pages if authorized
  draws ever exceed what a chain reported holding, and the bucket
  composition picture counts repatriated value as a destination — while a
  deployment that predates this feature is reported as a visible coverage
  gap rather than a false alarm.

Operationally the surface stays **dark by default** on every existing
deployment: nothing moves until the channel endpoints are deployed and
explicitly configured on both sides.

## Every live review drive now says whether it found a defect or was simply unable to look

The live tier of the alpha02 review suite is a set of drives pointed at the
deployed site. Each one ends with a verdict, and the batch report collects
them. Two of those verdicts mean opposite things to whoever reads the
report: "this surface is broken" sends someone to fix the product, while
"this drive could not run" sends someone to fix the environment and then
review the surface, which is still unreviewed.

Only two of the fourteen drives actually distinguished them. The other
twelve reported both as a defect. An unreachable site, a dead price feed,
an absent set of test credentials, a sandbox with no usable browser, a
stale copy of the deployed addresses — all of them arrived in the report as
a product regression on the surface that happened to be under review. That
costs twice: someone hunts a bug that does not exist, and the habit of
seeing defects that are not defects trains reviewers to skim past the one
that is real.

All twelve now distinguish them, and the report says so rather than
implying it. The batch runner keeps its list of drives that promise the
distinction — the promise is what makes the vocabulary trustworthy — but it
now also names any drive missing from that list the moment the batch
starts, instead of silently downgrading its verdict later on.

**What counts as "could not look".** A drive's first page load is its
reachability check, so a site that never answers blocks it, while a route
that fails after the site has already served pages stays a finding — a
broken route is exactly the kind of regression these drives exist to
catch. One drive is deliberately outside that rule: the whole-site
evidence sweep is not a pass/fail check at all, so it records a route
that would not load in its report and carries on, exactly as it does for
console errors and slow responses. Whether its summary verdict should
start counting those is a separate question, recorded rather than decided
here. Reference data a drive reads rather than checks — the deployed
addresses, the contract interface descriptions, an artifact a flag points
at — blocks it, because a stale copy leaves the drive with nothing to
compare against. So does a configuration selector that names nothing, and
so does a test wallet without the funds the drive has to commit.

**The one that was hiding in plain sight.** The gasless-posting drive needs
funds in the maker's vault before it can post anything. Without them it
reported that the posting flow had regressed and told the reader to top up
the vault in the same breath — a defect claim and its own refutation, in
one line. It now blocks. The equivalent check was missing entirely from the
sibling order-posting drive, which would instead fail somewhere mid-post
with the underlying reason several steps behind it; that drive now checks
the balance before it even opens a browser, so an underfunded run costs
nothing and says exactly what it needs.

**Where the line was deliberately NOT drawn.** One drive resets a leftover
setting before it starts. Reading that setting can fail because the chain
is unreachable — that blocks. Writing it can fail because the chain
refused a change that should have been accepted — and that is evidence, so
it stays a finding. Reclassifying it would have hidden a real defect behind
a "re-run this later" verdict, which is the same mislabelling this change
exists to remove, pointed the other way.

**One rule that deliberately runs the other way.** A drive that checks each
of nine languages in turn opens a fresh browser for each one and collects
what it finds as it goes. If the browser fails to start on the sixth
language after a real translation fault was found on the second, saying
"could not look" about that run would be false — something was found, and
reporting otherwise would bury it. That drive keeps deciding its own
verdict: a real finding outranks a later setup problem, and only a run
that found nothing at all reports as blocked. The first pass of this work
removed that rule by accident, which is exactly the kind of quiet reversal
the review round exists to catch.

**How it was checked.** Each class of blocking condition was forced
deliberately — an unreachable target, a missing credential file, an
unusable browser, a corrupted address bundle, an emptied interface bundle,
an unfunded wallet, a mis-set selector — and every drive confirmed to
report "could not look". The opposite direction matters just as much: a
drive that blocked on everything would look like success in that test
alone, so each was also pointed at a page that genuinely was served but
carried the wrong content, and confirmed to still report a finding; and two
read-only drives were run against the real site and confirmed to still
pass. The batch report was checked to render all three verdicts distinctly,
including the new warning for an unregistered drive.

## The lending app's translation command now goes through the checked path

There were two translation programs in the repository doing the same job. One
had been improved steadily — it refuses a translation that invents or drops a
value placeholder, refuses a key the English source does not have, refuses an
empty string (which renders blank rather than falling back to English), refuses
a reply that came back short of what was asked for, can fill in only the
missing lines instead of rewriting a whole file, and writes in a way that
cannot leave a half-written file behind if it fails. The other was the original
it had been generalised from, and had learned none of that. The lending app
still used the original.

They had also drifted apart in what they protect. The older copy still guarded
the names of two contracts that were removed from the platform months ago,
while missing the word the recovery screen asks the user to type — a word that,
if it were ever translated, would leave the confirm button permanently
disabled for speakers of that language, because they would type what the page
asked for and it would never match.

The lending app now uses the shared program, and the duplicate is gone. Its
glossary and locale list come from the one shared definition, so a lesson
learned in one place is learned everywhere. The list of which languages the
lending app actually ships stays with the app, because that genuinely differs
between the app and the marketing site.

Nothing about which languages get translated changes: both programs already
defaulted to the same thing — languages that have no file yet — so this is a
change of which checks run, not of what work gets done.

## Thread — the two borrower settlement paths nobody was driving (PR #1589)

A coverage audit of the borrower's early-exit surfaces, run after the
#1529 merge, found that two of the six options the app offers had no
automated drive behind them from the app's own side. The contract rules
for both are well unit-pinned in Solidity — partial repayment alone has
around ten cases covering the floor, the full-principal rejection and
the boundary a wei below it — so the gap was never "is the rule right".
It was that no test drove the borrower's actual surface: partial
repayment had no fork spec, nothing in the frontend unit tier, and no
row in the coverage matrix recording the absence, while refinance had a
spec asserting only that its form RENDERS inside the grace window,
which passes just as happily against a flow whose submit reverts. Both
are shipped, reachable, fund-moving paths, so this closes the gap
rather than recording it.

Each new spec drives the real UI on an Anvil fork and takes its verdict
from the chain rather than from a success banner. The partial-repay
drive asserts the pair that actually distinguishes the behaviour — the
principal falls by exactly the amount typed AND the loan stays Active —
because either alone is satisfied by the wrong thing: a full repay also
reduces what is owed, and a no-op also leaves the loan open. Its chosen
amount is bounded against the contract's own live minimum-partial floor
and its full-retirement ceiling, so a risk-parameter change on the
forked chain fails inside the spec naming the cause instead of arriving
as an opaque revert behind a wallet confirmation.

The refinance drive posts the request through the borrower's form, has
a second lender accept it, and checks that the old loan closes as
Repaid while the replacement opens under the same borrower at the same
principal. Two of its assertions exist because mutation testing
contradicted the reasoning behind the first draft. The form's "posted"
confirmation turned out to be transient — the page-owned pending card
takes the story over immediately — so the spec now asserts the standing
surface, and cross-checks the request id it names against the chain's
own record of which loan the request targets. More substantially, the
draft claimed that comparing the new loan's collateral asset and amount
proved the collateral had carried over. It does not: the documented
failure mode, where the offer's creator does not match the borrower
stored at loan initiation, produces a fresh pledge of the same asset in
the same amount pulled from the poster's wallet, and sails through both
comparisons.

Balance invariance alone does not settle it either, which review caught
in a later round. The contract keeps a legacy branch that returns the
old collateral at acceptance, so a re-pledge nets to zero across any
window and looks identical from the outside. The spec therefore pins
both halves: the persisted carry-over flag, read off the chain request,
establishes which path was taken, and the borrower's collateral balance
— sampled before the request is posted and compared after completion —
establishes that nothing was pulled along the way. The balance half was
verified to catch a one-wei perturbation; the flag half guards a path
that is not reachable through this surface today, so it is a regression
guard rather than a mutation-isolated assertion, and it is described
that way rather than claimed as more. The rate ceiling and loan length
typed into the form are also read back, off both the request and the
replacement loan, so a form that quietly stopped persisting either
would fail here rather than posting a valid request on stale terms.

Supporting change: the shared direct-accept helper became side-aware.
It previously bound only the lender-offer endpoints, so a lender
funding a borrow request — which the refinance spec needs — was not
expressible. Rather than add a near-duplicate, the helper now derives
which leg the acceptor escrows and which endpoint of the creator's
range binds, mirroring the contract's own rule. The existing consumer's
suite was re-run unchanged to confirm no regression.

Closes #1587
Closes #1588

## Two chapters of the Hindi and Japanese guides were written but unreachable

The Advanced guide chapters on how liquidation actually works and on allowances
were already translated into Hindi and Japanese. Readers of those two languages
could not get to them.

The prose had been indented by two spaces, which in Markdown makes it a
continuation of the bullet point above rather than a chapter of its own. The
result was a hundred-odd lines of correctly translated material that the page
rendered as part of a bullet, that the contents list never offered, and that no
check objected to — the words were all there, in the right order, in the right
file.

Removing that indentation is the entire fix. Nothing was written, translated, or
reworded; the change is whitespace only, and the anchor set of both files is
byte-for-byte what it was. Both editions now carry eighteen chapters like every
other translation, and both chapters appear in the contents list where a reader
would look for them.

That leaves every language short of exactly one chapter, the same one — the
walkthrough of how VPFI discounts work, which exists only in English and is
genuinely a translation job rather than a formatting one.

## The app could report a language as fully translated while it still read in English

A check already existed to catch a language falling behind — it compares which
pieces of text each language has against the English original, and fails the
build when any are missing. It was doing its job: the count went from a hundred
and sixty missing pieces down to none.

But "has the text" and "has it in that language" are not the same question, and
only the first was being asked. A piece of text that exists but still holds the
English wording is, to the check, indistinguishable from a translated one. So
the moment the last missing piece was filled, every language read as complete —
while Hindi alone still showed nearly three hundred English strings to anyone
using the app in Hindi.

The check now asks the second question too. At the time of writing, 490 pairs
of language and text are recorded as a known, dated backlog so the number cannot quietly grow: a
piece of text that regresses to English fails the build, and one that gets
translated has to be struck from the record or the build fails as well. The
record can only shrink, and every entry in it is a translation someone still
owes.

That last sentence used to be a promise rather than a rule. The record lives in
the same place as the code, so a single change could introduce an English
string, add it to the record, and pass — the check that exists to catch the
regression could be widened by the change causing it. Both records are now
compared against the state of the branch being merged into, and a change that
adds an entry to either one fails. Moving an entry the other way — off the backlog and onto the list of text
that is correct as it stands — is a thing someone will need to do, because the
backlog was assembled by a machine and some of it is wrong. The word "Support"
is the same in German and French as in English, and both languages use it inside
sentences they did translate. Recording that judgement means adding it to one
list and taking it off the other, in one change, and the checks now permit
exactly that: a line may leave the backlog when the reasoned record accounts for
it, and not otherwise.

Removals are checked too, which is less obvious: a line
may only leave the record because the text was actually translated, and a change
that rewords the English while deleting the entry — leaving the language showing
the old wording — would otherwise erase the very evidence that the debt is still
owed. Nothing prevents someone editing the rule itself; what this stops is the
quiet version, where a line is added or dropped in a large diff under a heading
that says the file only ever loses entries.

What counts as "still English" is deliberately loose about everything that is
not vocabulary. Capitalisation, punctuation, spacing and invisible characters
are not a language, and neither is word order — a sentence whose words are all
English reads as English however they are arranged, and rearranging them is the
easiest way to look translated without being. Nine strings were doing exactly
that: six Korean ones — five buttons putting the English word "mint" after the
amount instead of before it, and a progress line reading "terms signing…" — and
three Hindi ones that had swapped two English words around, one of them closing
with the Hindi full stop on a sentence otherwise entirely in English. They are
now recorded as the untranslated text they are.

Deleting a word does not translate the ones left behind either. Hindi showed
"loan asset" where the English said "the loan asset", and Korean
"permission signing…" for "Signing the permission…" — English with the small
grammar words dropped, which is exactly what a hurried edit removes. Eight more
strings, now recorded. The reverse — text that keeps every English word and adds
others — is deliberately left alone: that has words from somewhere, and calling
it untranslated would invent work against a translation someone had started.

Repeating a word does not translate it either, and that one arrived last: a
label reading "Settings Settings" is longer than the English, and a check
counting words rather than looking at which words they are let it through. Reordering, deleting and
repeating are all just arrangements of the same vocabulary, and each had been
found separately before the shape common to all three was.

The question the check settles on is deliberately the narrow one — is every word
here a word from the English this text is meant to translate? — and not the
broader "is this English", which sounds better and cannot be answered without
knowing the languages involved. The question is asked of the letters rather than
the words, because where one word ends and the next begins is itself something
an edit can change: "Set-tings" is two fragments to a machine and mangled
English to a reader. So the check asks whether the letters can be cut, end to
end, into English words from the source — which covers reordering, deletion,
repetition and moved punctuation together, in any combination, instead of one
at a time. Digits are left out of that stream, because a number dropped into
the middle of an English word does not make it another language. The same
question is asked of the punctuation where there are no words at all: an
English full stop written twice is still an English full stop, and comparing
the two exactly had been calling it a translation — with the spaces taken out
first, because putting one between them changes nothing a reader would notice. Text that adds an English word the source did not have
still passes. The broader rule was tried and measured: treating every word in
the English as a dictionary would add seventeen entries to the backlog, and
almost all of them are correct translations that happen to share a word with
English — the French for "more", for "primary", for "one year". Seventeen
invented debts to catch one imagined case is a bad trade for a list whose whole
value is that every line on it is real work.

A small number of strings are correct even though they match — the product
name, and standard trading acronyms that are used untranslated everywhere.
There is also one heading where the French genuinely is the same two words as
the English in the other order, which no comparison of words can tell apart
from a rearranged English sentence; and the French words for notifications and
positions, which are spelled exactly as the English ones. Those last are worth
separating out from the backlog rather than leaving in it: the backlog is a list
of translations someone owes, and it can only be worked down by changing text.
An entry whose translation is already correct could only leave it by being
replaced with a worse synonym, which would make the list impossible to finish
honestly.

The same applies to the full stop that closes the consent sentence. Arabic,
German, Spanish, French and Korean all end a sentence with the same mark English
does, and in each of those languages the rest of that sentence is fully
translated — which is the evidence that the mark is a choice rather than
something nobody touched. Those five are recorded as correct. Hindi, Japanese,
Tamil and Chinese genuinely end the sentence differently and are still watched:
changing the Japanese ending back to the English one still fails. Those are listed separately, each with a
written reason, with the English wording it was granted against, and — where
the accepted text is not the English one — with that exact text, so that
rewording either side makes the exemption stale rather than letting it quietly
carry over to text nobody looked at again.

One more way a piece of text can read as English while comparing as
something else: swap a letter for an identical-looking one from another
alphabet, or hide a mark from one inside a word. A Cyrillic "e" in "Settings" is
a different letter to a computer and
the same shape to a reader, so the check saw a German word where the screen
showed an English one. Rather than keep a list of every lookalike character —
which is a list that is never finished — the check now records which alphabets
each language is actually written in, and rejects a letter from anywhere else.
Nine short declarations, and the whole class goes with them. It does not catch
a lookalike drawn from an alphabet the language genuinely uses, and the check
says so rather than implying otherwise. Accent marks are untouched, because the
marks that sit on ordinary letters do not belong to an alphabet of their own —
only ones that do are rejected.

The opposite shape is caught as well: text that contains no words at all where
the English is a sentence. A label replaced by a single ellipsis was accepted
before, because it plainly is not the English wording — and "not the English
wording" was the only question being asked. A reader would have seen punctuation
where a sentence should be. Three real cases turned out to be correct, and they
say something about how sentences get split for translation: an offer footer is
assembled from a lead, two links and a tail, and German, Spanish and French put
the closing noun in the lead, which leaves the tail as nothing but a full stop.
That is a written judgement now, recorded with the exact text it accepts.

Digits are not words for this purpose either. A label replaced by "123" counted
as having a word and slipped past — which is right when comparing what words two
texts share, and wrong when asking whether there is anything to read. The two
questions now use two tests. Nor do invisible letters: one Korean character is
simultaneously a letter, invisible, and part of the Korean alphabet, so adding
it to an ellipsis satisfied three separate rules at once while showing the
reader nothing. Every comparison here now drops invisible characters before
looking. Characters that are not letters, marks, numbers, punctuation or
spaces are handled the opposite way — they are rejected outright rather than
ignored, unless they are on a short list of symbols the copy actually uses:
twelve of them, counted rather than guessed.

That list exists because the alternative kept failing. Seven separate reviews
each found one more character that looks like something other than what it is —
a wide letter, a wide full stop, a zero-width space, a Cyrillic letter shaped
like a Latin one, a mark from another alphabet, an invisible letter, a control
character — and each fix closed exactly the one that had been found. The
eighth review produced two more, including a character that reverses the
direction of the text after it, so that a backwards word renders forwards and
reads as English. Listing what is allowed ends that sequence: anything else
fails without anyone having to think of it first, and adding a new symbol is a
deliberate edit somebody reviews.

Two kinds of entry live in that list and they had been treated alike, which
turned out to matter. Most are judgements about how things stand — the French
heading, the closing full stops — and if someone rewords them the entry should
simply lapse. But a handful are not judgements at all: the product name, the
standard trading acronyms, a template with no words in it. Those can never
legitimately differ, and when one was corrupted the check said the same thing it
says for the others — that the entry looked unused and its language list should
be narrowed. Doing as it asked made a misspelled product name pass. Entries of
that kind are now marked as never-changing, checked in every language rather
than only the ones listed, and a difference is reported as something to put back
rather than something to stop watching.

The same reasoning settled the last open case. Where the English text has no
words at all — four places, all punctuation — the marks are the entire content,
so "not the English marks" cannot mean "translated": a full stop followed by an
exclamation mark was passing as a Chinese translation. Every language is now
accounted for at those four places, either still showing the English or naming
the exact wording someone approved. Five needed writing down, and all five were
already correct: the Hindi and Tamil sentence endings, the Japanese and Chinese
ones, and the French way of numbering an item.

There are deliberately no rules-of-thumb about what is exempt. An earlier draft
excused anything with no letters in it, on the reasoning that punctuation cannot
be translated. That is simply untrue: the sentence ending is a full stop in
English and an ideographic full stop in Chinese — a different mark, not a wider
drawing of the same one — so the rule would have allowed a real piece of Chinese
to quietly revert to the English mark. Each exemption is now written down and
justified individually.

The same reasoning applies to the record itself. It stores the English wording
each entry was written against, because if the English changes the untranslated
text no longer matches it — and a check that treated that as evidence of
translation would erase the debt precisely when someone edits the source.

The failure message also stops giving the wrong instruction. The existing
suggestion — fill in whatever is missing — walks straight past text that is
present but untranslated, so following it would report nothing to do on a
language the check had just failed.

## A chapter of the user guide was on the page but not in its contents list

The Advanced guide's chapter on how VPFI discounts work was being printed on the
English help page and mentioned nowhere in that page's contents list. Readers who
navigate the way people actually read a long document — by scanning the contents
and jumping — had no way to reach it at all. It was only findable by scrolling
past everything above it.

The cause was quiet, which is why it lasted. The contents list is built from the
stable link targets attached to each card, and it dropped any chapter that had
none. That chapter's cards have none, so the chapter disappeared. Nothing failed
and nothing was logged; the page simply did not mention it.

A chapter with no linkable cards is now offered as its own entry, pointing at the
chapter heading. That is the durable half of the fix: the next chapter written
without link targets stays reachable instead of vanishing the same way. The
obvious alternative — adding link targets to that one chapter's cards — was
deliberately not taken, because the English guide would then carry targets none
of the nine translations have, which is its own kind of broken link. That chapter
is still untranslated, and it is tracked separately.

Two smaller things came along with it. The contents list now reads the document
the same way the page renders it, rather than by scanning the raw text for lines
that look like headings — so a heading written inside a code sample or a comment
is no longer offered as a section that goes nowhere. And a new check fails the
build if any chapter is missing from its contents list, using the same code the
page itself uses to build that list, so it cannot quietly agree with a future
version of this bug.

## Removing a duplicate that had already misdirected one fix

The older connected app carried its own copy of the documentation-rendering
components the marketing site uses — the piece that renders reference
figures inline in help text, the one that builds a page's contents list,
and the contents list itself. Nothing in that app rendered any of them. The
live versions live in the marketing site and are reached from four real
pages.

The duplicate was not merely unused, it was actively misleading. A recent
fix to a rendering fault landed in the dead copy first, because that is the
one a search for the component turns up first; the fault stayed live on the
pages readers actually see until review caught it. Both were eventually
fixed, but the trap remained: two files that look interchangeable, one of
which nobody renders, and no way to tell them apart except by knowing.

All three are gone, along with three markdown libraries that were listed as
dependencies of that app and imported by nothing in it — they had already
fallen to zero users, since the dead files only mentioned the library in
comments rather than importing it.

Nothing else changes. The marketing site's copies are untouched, and the
app's type checking, lint, full test suite and production bundle are all
unaffected.

## The referenced figures reached the pages, but not the other three surfaces

A separate change (#1615) fixed the reason the documentation's referenced
figures were reaching readers as raw token text, and recomputed the worked
examples that had drifted. This finishes the same job on the surfaces that
fix did not touch, all found while verifying it.

**The machine-readable copies.** The site publishes plain-markdown copies of
the same documents and advertises them for automated consumers. Those copies
were written out verbatim, so every one of the 420 placeholders in them
survived after the pages themselves were correct — an automated reader was
still being handed the internal syntax. They are now substituted from the
same shared values the pages use, so the two cannot disagree about what a
figure means.

**The language of the figures.** They were formatted in English on every
page regardless of the reader's language. On a German page, English digit
grouping turns a twenty-thousand-token threshold into something that reads
as twenty — a two-orders-of-magnitude misstatement rather than a cosmetic
one. Figures now follow the language of the document.

That turned out to be half a rule, which review caught. Some documents are
published in English whatever address the reader arrives at — the whitepaper
and the parameter reference have no translations — so following the URL's
language put German grouping, and on one route a different numeral script,
inside English sentences. Others fall back to English when a translation is
missing. Figures now follow the language of the document actually shown, and
pages that always show English declare it.

**The documentation search.** A third place substituted these figures, with
its own English-only copy of the values. A reader on a German page could not
find that page by searching for a figure visible on it, and result snippets
contradicted the page they led to. It now reads the same shared values,
formatted for the document being indexed.

**What keeps it from lapsing again.** The original fault was invisible to
type checking, to linting, and to any check that runs before publication. A
new check renders the real pipeline and asserts the outcome across every way
a document can produce a code span — thirty-seven assertions covering both
substitution paths, the deliberate escape hatch that lets the docs describe
this mechanism, unrecognised names staying visible rather than vanishing, and
the two paths agreeing with each other. Each was confirmed by reintroducing
the fault it guards against.

## Hovering a fee figure on the public site no longer says something is broken

The documentation quotes protocol parameters — the treasury fee, the loan
initiation fee, the VPFI hold tiers and their discounts — and each of those
figures carries a hover explaining where the number came from. On the public
marketing pages every one of them said the same thing: that the figure was a
fallback, and that a reading from the chain was pending or unavailable.

That described a failure that cannot happen there. The marketing site is
deliberately wallet-free and makes no chain reading at all, by design. So
nothing was pending, nothing was unavailable, and the number the reader was
looking at was the correct one. A reader curious enough to hover a fee — the
reader most worth keeping — was told the mechanism behind it was broken, and
invited to refresh and wait for a figure that would never change.

The hover now names the source the page actually has: a published value,
bundled into the site at release. The two other cases stay distinct, because
they are genuinely different things to tell a reader — a figure that came
from the chain, and a reading that was attempted and has not answered yet.
Which one applies is now something each surface declares about itself,
rather than something guessed at from an empty result, so a surface that
makes no reading can no longer be mistaken for one whose reading failed.

**The second half: keeping the published figures true.** Because these
numbers are fixed at release, nothing tied them to the protocol's own
definitions — they were correct only because whoever last changed a fee
remembered to change them here too. That has already gone wrong once: an
earlier fee retune left the sentences quoting it stale in several languages,
which is why these figures were collected into one place to begin with.
Collecting them fixed the many-copies problem, but a single copy can still
go quietly out of date.

Publication now fails if any published figure disagrees with the protocol
constant it claims to mirror — and "publication" means the path that
actually publishes, not only the optional validation command. The check runs
before the site is built, so the deploy command cannot produce pages from a
stale registry, and the continuous-integration job that runs it is now
triggered by changes to the protocol library itself. Without that second
part the check would have been skipped on exactly the change it exists to
catch: a pull request that retunes only a fee touches no site file at all.

It also verifies the *scale* each figure is published at, not just its
value. Marking a fee as a token count rather than a percentage leaves the
number identical and every value comparison green, while the page renders
two hundred where it should read two.

The comparison is against the protocol's own source
rather than a live deployment, deliberately: there is no production
deployment yet, the only readable one is a test network whose values are
changed for testing, and gating published wording on it would fail releases
for reasons that say nothing about what the protocol ships. The check also
fails — rather than passing quietly — when it cannot find the parameter it
is comparing against, because a check that silently compares nothing reports
success.

What this does not cover, stated plainly rather than implied: a parameter
changed by governance on a running deployment can still drift from the
published figure. Closing that needs either live readings on the marketing
site or a monitor watching a deployment, and both are decisions worth making
once there is a deployment worth watching.

## The worked examples in the documentation were computing fees at the old rates

The platform's two fees were raised some time ago — the fee on lender yield from
1% to 2%, and the fee charged when a loan starts from 0.1% to 0.2%. The
documentation's headline sentences carry a reference to the shipped figure rather
than a number typed into each of ten translations, so they said 2% and 0.2%
correctly. The worked examples underneath them did not: they still did the
arithmetic at the old rates.

The examples are now recomputed at the current rates, and the percentages that
were written out by hand in the surrounding prose have been replaced with the
same reference, so the next retune cannot separate them again. What cannot be
handled that way is the arithmetic itself: a total like "you receive 1,006.44" is
derived from a rate and has to be recalculated by hand whenever the rate moves.
That is now written down as something the documentation owes.

### Those references were not reaching the reader at all

While correcting the numbers we found that the references themselves had stopped
working. The documentation markdown marks a referenced figure with a small token,
and the renderer's test for "is this a token" had been written against a
behaviour the markdown library removed in an upgrade. The test could never be
true, so every referenced figure — the fee rates, the VPFI tier thresholds, the
discount percentages — reached the reader as the raw token text rather than as a
number, on every documentation page, in every language.

The renderer now recognises the tokens again, and it does so by asking the one
question that matters (is this span exactly one token) rather than by
re-deriving what kind of code span it is, which is what went stale.

Worth being precise about what these figures are, because the old wording
overclaimed: on the public marketing site they are the values shipped with the
build, not values read from the chain. That site deliberately holds no wallet
connection and reads no protocol state. The benefit is that a rate lives in one
place instead of ten — which is exactly the drift that caused this — but a
marketing page is only as current as its last deploy, and nothing in the copy
should tell a reader otherwise.

### A second arithmetic error, older than the rate change

Checking the arithmetic turned up a defect that predates the rate rise and was
present in every language. The example showed the lender receiving the repayment
minus a figure that was actually the yield fee **plus** the loan initiation fee —
but the borrower had already paid that initiation fee at the start of the loan,
and the example said so three paragraphs earlier. The lender was being charged it
a second time on paper.

Both the lender's total and the treasury's are corrected, and they are now the
figures the settlement code actually produces: the protocol works from the
unrounded interest, so the example states the unrounded figures too and says
plainly that the displayed amounts are rounded to the cent. A reader who checks
the sum and finds it a cent out now has the answer on the page instead of a
reason to doubt it.

## The user guides were still quoting the old fee on lender interest

The fee taken from lender interest was raised from 1% to 2% some time ago. The
overview pages were corrected recently; the two user guides were not, so a
reader who moved from one page to the other met two different numbers for the
same fee — in all ten languages. Seventy sentences across the basic and advanced
guides said 1%.

They no longer hold a number of their own. Each now refers to the same shipped
figure the rest of the documentation refers to, so the next time the fee is
retuned there is one place to change rather than seventy. The published
machine-readable copies of the guides resolve that reference too, so a reader
and a crawler see the same figure.

### And they were missing something more important than the number

A loan's fee is fixed at the moment the loan is created. That is deliberate: a
later change to the protocol's fee is not allowed to alter the economics of a
loan already running. None of the guides said so — they simply named a rate,
which reads as a promise about the reader's own position.

Quoting a live figure made that gap matter more, not less: after the next
retune the guides would have shown the new rate to everyone, including people
whose loans were opened under the old one. Both guides now say, where they first
introduce the fee, that the rate is fixed when the loan is created and a later
change leaves an open loan on the rate it started with.

### The administrator's knob reference

Still prints plain numbers, now 2% and 0.2% — deliberately. That page documents
where each knob *starts* before anyone tunes it, which is a different claim from
what the protocol charges today, and an operator reading it is trying to learn
precisely what a retune would be departing from. A live reference would have
quietly rewritten the documented default every time the figure moved.

### Figures that look identical and were left alone

Four were checked one at a time and are correct, because they belong to other
knobs entirely: the matcher's share of the loan initiation fee, the tolerated
divergence band between price oracles, the late fee charged on the first day
past due, and the pool fee tier the liquidity check deliberately excludes. The
Japanese and Korean guides additionally explain what a basis point is by calling
it one hundredth of 1% — a definition of the unit, not a statement of the fee,
and also untouched.

## The pre-deploy gate was running a form of the test suite that had been outgrown

Before contracts are deployed to mainnet, a preflight check runs the full test
suite and refuses the deploy if anything is red. The same check is what the
release-track workflow runs when a release branch or version tag is pushed. It is
the last thing standing between a broken build and a live deployment.

That check carried its own copy of the command that runs the suite. There is
also a dedicated script for running the full suite, and the two were written to
match — the preflight even carried a comment saying so.

They stopped matching. The test corpus is large enough to sit against a compiler
limit on how much can be compiled in one go, and the dedicated script was
reworked to run the suite in several smaller pieces so no single piece crosses
that limit. Its own notes record why: the single-pass form it used to use had
been fine for a while, then ordinary growth in the codebase pushed past the limit
again. The preflight's copy was never updated, so it kept running the form the
other script documents as no longer viable.

What made this worse than a slow build is how the failure would have presented.
Crossing that limit is a compilation failure, not a test failure — but the
preflight treats both the same way, so it would have reported that the regression
failed and the deploy should not proceed. The message would have been correct
about the conclusion and completely misleading about the cause, at the exact
moment someone is trying to ship. Nothing would have indicated that no test had
actually run.

The preflight now calls the dedicated script instead of duplicating it. There is
one implementation of the chunking, and it brings with it a guard that fails
loudly if any test file is not covered by one of the pieces — so a newly added
suite cannot be silently skipped by the gate either. The scope is unchanged:
the slow invariant suites are still excluded and still run as their own pass.

A side effect worth recording: the memory figure that made this gate a poor fit
for the hosted CI runners described the single-pass form. Running in pieces
bounds memory by the largest piece rather than the whole corpus, which makes the
fit structurally plausible where it previously was not. Plausible is not
measured, and nobody has measured it on a hosted runner — the pre-cutover
checklist that says to confirm this before the first release push still stands,
and now says what to measure.

The suite-running script also no longer assumes it is allowed to raise its own
I/O priority. That was a safe assumption on an operator's own machine, which was
the only place it ran; now that the release-track workflow reaches it, it checks
first and carries on without the boost where it is not permitted.

This does not change what runs per pull request, which stays the narrow
deploy-sanity and happy-path set, and it does not make the full suite a
per-pull-request gate. It only makes the pre-deploy gate do what it already
claimed to do.

## The administrator's knob reference described a protocol we no longer run

The knob reference has two copies: an internal one for operators and auditors,
and the published page at `/protocol-console/docs`. One is meant to be generated
from the other. They had quietly swapped roles — corrections kept landing on the
published copy, because that is the file anyone editing site content opens, while
the internal one went untouched for months.

The result was a documented workflow that had become dangerous. Running the sync
exactly as instructed would have overwritten the published page with the older
copy, reinstating a description of a cross-chain purchase flow that was removed
deliberately, and rewriting the cross-chain section back to a messaging provider
the platform migrated off. Nobody had run it, so nobody had noticed.

Both copies are now reconciled and identical, and the internal one is again the
source. Content that only it had — the graduated partial-liquidation bounds, the
loan-admission health-factor floor, the quote-time rate model, the automatic
lifecycle kill switches and the feature kill switches — has been carried across
to the published page, which was missing all of it.

Two sections were deleted rather than carried across, because the knobs they
describe no longer exist: the cross-chain purchase watchdog, and a staking yield
that was removed some time ago. Each was checked against the contracts
individually rather than assumed, which is how they were caught — one of them had
been about to be published for the first time.

The cross-chain description was rewritten rather than renamed. The published copy
had already been half-corrected: the headings named the current provider while
the text beneath still described the old one's peer mesh and its verifier policy,
and the chain identifiers were still described using the old provider's numbering
scheme. It now describes what is actually configured — the four owner-set maps on each
chain's messenger, including the channel registration a lane cannot work without
— and says plainly that transport security is operated by the provider and
uniform for every integrator, so there is no verifier selection to get wrong.
It also stops presenting the peer map as a forgery guard: no handler shipping
today checks the sender against it, and the description now names the boundary
that does hold.

### And a check so the two cannot drift apart again

A generated file that can be hand-edited without complaint is not generated, it
is forked — and the moment it forks, the generator becomes a weapon pointed at
whichever copy is newer. A new check compares the two on every change and fails
if they differ, naming the first line that disagrees and pointing the fix at the
source rather than the copy. The sync script now also warns, before it runs, that
it overwrites.

## Thread — The UX sweep now fails when a route never loaded (PR #1648)

The whole-site UX sweep in the live review tier is mostly an evidence
generator: it visits every route in three passes, captures full-page
screenshots, the console stream, network timings and a devtools probe,
and leaves the judging to whoever reads the artifacts afterwards. Until
now its exit code spoke to exactly one thing — whether the sweep had
stayed read-only. A route that never loaded was written into the report
and otherwise passed silently, so a run where a page timed out or errored
still reported PASS in the pre-release batch table.

That is coverage the run did not have. When a navigation fails the sweep
deliberately records null artifacts for that route, because the browser
would still be showing the previous page and a screenshot would describe
the wrong surface. So a failed route contributes no screenshot, no
landmarks and no devtools capture — and a PASS row next to it claims the
surface was reviewed when nothing about it was ever seen. The sweep now
accumulates those failures across every session and pass, publishes them
in the report next to a count of the routes it attempted, prints a
"Routes: N/M loaded" tally on every run whether or not anything broke,
and exits with the failure code if the count is non-zero. It still
carries on to the remaining routes after one fails — stopping at the
first bad route would throw away the evidence the sweep exists to gather.

"Never loaded" turns out to be three shapes, and only the first of them
looks like a failure at the time. The obvious case is a navigation that
throws — a timeout, a refused connection. The second is a route whose
document comes back with a 404 or a 502: the browser reports that as a
perfectly successful navigation, so it would have been counted among the
loaded routes and logged as a fast, quiet, clean visit. The third is a
route that redirects away, either because the server sends the reader
somewhere else or because the application itself navigates on load — the
page that finally answers is a healthy one, captures perfectly, and is
simply not the page under review. All three now count, and the wording
throughout is careful about the difference in what evidence each leaves:
only the thrown case has nothing to look at, because nothing committed
and a screenshot would show the previous page; the other two leave a
perfectly good record of the wrong thing.

Catching the redirect case exposed a quieter problem in the shared
launcher every live review driver uses. To work around a sandbox whose
gateway interferes with browser traffic, the launcher intercepts each
page request, fetches it itself, and hands the result back to the
browser. Its fetch was following redirects internally and returning the
final content — which was then served to the browser under the
originally requested address. The effect was that a redirect became
completely invisible: the page displayed another route's content while
both the address bar and the recorded response still read as the route
that had been asked for. No driver could have detected a redirect, and
the new check could never have fired. The launcher now hands the
redirect back to the browser and lets it follow, which is what would
have happened with no interception at all.

Two choices are worth recording. The failure is reported as FAIL rather
than BLOCKED, and is checked before the session-setup branch, on the same
precedence the read-only violation already follows: something the run
actually observed outranks a session that never started. And timeouts
count. The argument against was real — a 45-second budget against a live
testnet makes some timeouts environmental, and turning those into batch
failures re-creates the habitual-red problem the three-verdict contract
exists to remove. The argument that won is that a route which cannot load
in 45 seconds is a finding whoever caused it, and burying it in a report
nobody opens is how it stays one. If transient timeouts do become
habitually red, the fix is a smarter wait or an honest budget, not an
exit code that overstates what the run proved.

Everything else stays evidence. Console errors, slow responses, heavy
payloads and the horizontal-overflow probe are judgements a reviewer
makes from the artifacts, and none of them move the exit code.

Closes #1626.

## Selling a lender position no longer asks the seller for wallet liquidity they were never told to hold

**Task:** #1659

Selling a live lender position through a **resting listing** — where the seller
publishes an asking rate and a buyer takes it later — could not complete at all
once any interest had accrued on the underlying loan.

When a position sells, the interest earned so far is **forfeited** by the seller:
it is applied to any rate shortfall the buyer's terms create, and whatever is
left over goes to the treasury. That part was right. What was wrong was where the
money came from. Completion tried to collect the forfeited amount from the
seller's **wallet**, which requires the seller to have granted the platform
standing permission to take that asset. On the *direct* sale that is fine — the
seller is the one submitting the transaction, so the permission and the sale
happen together. On a resting listing it is impossible: the **buyer** submits the
transaction, and a seller cannot grant permission inside someone else's
transaction. The sale simply failed, and the buyer's acceptance failed with it.

Sales now settle **net**, exactly as the platform's own specification calls for:
the buyer's payment is held by the protocol for the moment it takes to settle,
the forfeited interest and any shortfall are deducted from it, and the seller
receives the remainder. Nobody is asked to source separate funds for money they
already owed out of the proceeds they are being paid. The seller's economics are
unchanged — they bear the same forfeit as before, and still receive the full sale
price minus what they owed.

This also removes a real divergence between the two sale routes. The direct sale
already settled net; the listing route had reimplemented the same arithmetic and
reached the opposite conclusion about who funds the forfeit. Both now follow one
rule, so they cannot drift apart again.

Two related notes:

- The extreme case where a seller's obligations would exceed the sale proceeds
  is refused up front with a clear reason, rather than failing deep inside a
  token transfer.
- The manual completion route, used only for recovery and driven by the seller
  themselves, is unchanged.

**Why it went unnoticed:** the shortfall is skipped entirely when no interest has
accrued yet, which is the case whenever a listing and its acceptance happen at
the same moment — true of every automated simulation and of the whole in-process
test suite, which additionally grants every participant unlimited standing
permission. A regression test now removes both of those crutches: it lets real
time pass and revokes the seller's standing permission before the buyer accepts.

## alpha02 — rates always display as percent, never raw basis points (PR #<n>)

The Offer Book's advanced detail line was the last surface that showed
interest rates in the protocol's internal unit — "900 bps" and
"rate band 0–900 bps". Those now read "rate 9%" and
"rate band 0%–9%", matching the summary line above them and every
other screen. Nothing is lost in the conversion: a whole-number
basis-point rate always divides into a percentage with at most two
decimal places, so the percent form is exact.

Raw basis points still exist in exactly two deliberate places, both
trader-oriented: the Rate Desk's hover tooltips (hovering a percent
shows the exact stored value) and its "rates are stored in basis
points" explanatory note. They never appear as a row's visible text.

Under the hood, three copies of the same bps→percent formatter (the
shared library one, one in the fee data module, one local to the
rental page) were consolidated into the single shared formatter, so a
future change to rate display precision happens in one place. The
translated copy catalog moved with it: every language's "rate band"
entry dropped its baked-in "bps" suffix (the interpolated values are
now pre-formatted percents), and the single-rate detail got its own
translated catalog entry.

## Thread — Translatable contract-revert messages in the connected app (PR #<n>)

The plain-language explanations shown when a transaction fails — the
friendly cause a contract revert decodes to, like "Health factor too low.
Add collateral to bring it above 1.5", "This offer has expired", or the
"the wallet could not estimate this transaction" guidance — are now
translatable in the alpha02 connected app. Previously these lived (in
English) inside the shared `@vaipakam/lib` decoder and reached the screen
already resolved, so they stayed English in every locale even when the
rest of the interface was translated — a visible patch of English on an
otherwise localized error banner.

The shared decoder keeps English as its single source of truth (so the
keeper bot, servers, and tests are unchanged), but now optionally accepts
a localizer: for each error it resolves a **stable key** — the Solidity
error name, or its 4-byte selector when no name resolves — plus the
English copy, and hands both to the caller's translator. The connected
app supplies one that looks the key up in the active locale's bundle and
falls back to the lib English when a language hasn't translated it yet
(never a raw error code or hex). The ~150 curated messages are seeded
into the translators' template automatically from the library's single
catalog, so the English is never duplicated app-side and can't drift.

Translating the messages themselves per locale is a backfill step (the
keys ship English-first and fall back until a locale's bundle is filled),
the same model the rest of the app's copy follows. This covers the
alpha02 connected app only; the older `apps/defi` surface is slated for
retirement and was intentionally left on the English default.

Follow-ups: the full decoder unit suite currently lives in the retiring
`apps/defi` and should be relocated to `@vaipakam/lib` as part of that
retirement so decode coverage isn't lost.

## Thread — alpha02 exposes every borrower early-repayment option (chooser + handover + offset)

The protocol has long offered a borrower six ways out of an active
ERC-20 loan before maturity — full repayment, partial repayment, direct
early close, handing the obligation to a replacement borrower (preclose
Option 2), offsetting into a new lender position (preclose Option 3),
and refinance — but the connected app exposed only a subset, and the
two preclose transfer paths not at all: a Basic-mode borrower saw a
single "Repay this loan" button, and even Advanced mode had no surface
for the obligation handover or the offset. This change closes that gap
in two halves.

First, discoverability: the borrower's loan page gains a "Ways to repay
or exit early" chooser card, rendered in both interface modes, that
names every path with its cost implication stated up front — the
path-specific interest-implication wording the functional spec requires
before any preclose signature (full-term versus day-by-day interest for
a close, accrued interest plus a lender rate top-up for a handover,
fresh lending capital plus the payoff for an offset). In Advanced mode
each row jumps to the matching tool; in Basic mode the advanced rows
share one explicit "switch to Advanced view" action, so the mode change
is always the user's own choice.

Second, the two missing flows now exist. The handover flow lists only
standing borrow requests the contract would actually accept (same
assets, an amount range covering the outstanding principal, at least
the loan's collateral, a term ending before the loan's due date, not
the borrower's own or a refinance-tagged request), quotes each
candidate's cost to the borrower, re-verifies everything live at
submit, and completes the transfer in one transaction. The offset flow
posts the linked lender offer with the loan's terms as editable
defaults, surfaces the two must-know disclosures before review (the
borrower position NFT is transfer-locked while the offer is open, and
the old loan's payoff is pulled automatically from the wallet when
someone accepts), and sizes a single token approval to cover both the
posting escrow and the worst-case completion pull. A live offset gets a
standing pending card — driven by the chain's own position lock, so an
offset made on another device still shows — with a completion-funding
watch, a restore-approval action, and a cooldown-gated cancel; the
repay-family surfaces warn (and the discretionary ones hold) while an
offset is open so the linked offer can't be silently stranded. Both
flows are covered by a new fork-tier spec that drives the handover to
an on-chain borrower change and the offset through post, lock, and
cancel.

Follow-up deferred: a fork-tier spec for the counterparty acceptance
that completes an offset atomically (needs a third funded wallet), and
a swap-to-repay (pay with collateral) surface, which remains contract-
only for now.

## Thread — alpha02: hardcoded UI strings and English formatters made translatable

Several user-visible strings on the connected app rendered in English
regardless of the chosen language, because they were hardcoded directly
in the page/component markup (never routed through the copy catalog) or
were produced by display formatters that always emitted English. This
was reported from the Chinese locale but affected every language,
including fully-translated ones.

Two causes were addressed. First, twelve hardcoded strings were moved
into the copy catalog with interpolation placeholders and their render
sites rewired: the "waiting for the other side to accept" offer line on
My positions; the "N locked · N free" balance breakdown on My vault; the
loan/rental detail rows ("collateral (borrower's)", the owed
"+ up to ~N interest" line, the "yearly · duration · due date" terms
line, and the "Confirm — <action>" button); the per-day rental price on
the Offers list; the Early-Exit offer row; and the "Connected to
<chain>" network-chip tooltip. Second, the duration, date, and
relative-time formatters were made locale-aware — duration unit words
(day/month/year, singular and plural) now come from the catalog so each
language supplies its own, and dates format with the active UI language
instead of a pinned US format. English output is byte-for-byte unchanged.

The new catalog keys were translated across all nine active locales
(zh, ta, de, fr, es, ar, ja, ko, hi). The existing regex-based
hardcoded-string guardrail did not catch these because they were
interpolation-interspersed JSX and template literals inside `{...}`
expressions — a known blind spot tracked for an AST-based detector.
Scope is limited to `apps/alpha02`; no other app, package, or contract
was changed.

## alpha02 — parametrized & inline copy made translatable (i18n interpolation)

Switching the connected app's display language previously left a large
class of text in English no matter how complete a locale's translation
was: parametrized catalog entries ("Due in N days", "You're on X, a test
network", the review-receipt lines) and interpolated notices built inline
in JSX ("You have N active positions", "Checking VPFI availability on
X…", every borrow/lend/rent receipt line). The i18n factory could only
translate plain string leaves — it passed function-valued catalog
entries straight through, and JSON locale bundles cannot carry
interpolation logic — so this text was English by architecture, not by
oversight.

This change makes all of it translatable. A new `tmpl(...)` catalog
primitive expresses a parametrized string as an i18next `{{var}}`
template (with locale-aware `_one`/`_other` plurals and `{{n, number}}`
number formatting) while keeping the existing positional call sites
unchanged. The i18n factory now binds each `tmpl` entry to its key and
resolves it through i18next, and the template exporter emits every one
into `en.json` so translators can localize it.

Every parametrized catalog function (about 105 of them) was converted,
and roughly seventy notices that were built inline in components — the
review receipts, the balance and availability hints, the claim-row
lines, the position summaries — were extracted into the catalog. The
handful of pre-submit guard errors thrown by the contract hooks now read
from the catalog too. Signing-critical text stays English by design:
EIP-712 domain names and the wallet-signed message bodies must match the
on-chain / backend verifier byte-for-byte, and chain and asset names are
proper nouns.

The hardcoded-string guardrail was extended to catch the exact blind
spot this class exploited — a backtick template whose literal text is a
real sentence — so a new interpolation-interspersed notice now fails CI
instead of silently shipping English. Running the extended check
immediately surfaced about fifteen more notices that a plain-text sweep
had missed, all now extracted.

The newly-added `{{var}}` keys ship English-first and fall back to
English in every locale until translated, tracked with the remaining
locale backfill (#1323). A separate follow-up covers the shared-library
contract-revert messages that alpha02 and the DeFi app display, which
live outside this catalog.

Part of the #1329 / #1323 extraction lineage; design in
[`docs/DesignsAndPlans/Alpha02InterpolatedCopyI18n.md`](../DesignsAndPlans/Alpha02InterpolatedCopyI18n.md).

## Connected app — expired offers render as expired instead of vanishing (PR #1517)

The lender-sale listing release taught the contracts to report an
offer's expiry as a first-class lifecycle state. The connected app's
chain-hydrated views (used whenever the indexer is unavailable or
behind) still knew only the four older states and treated the new one
as "unrepresentable", silently dropping the row — an expired offer
disappeared from lists instead of showing as expired. The app now maps
the new state directly to its existing "expired" presentation, which
the indexer-backed path already used. The fork-tier test harness had
the same gap in its stand-in indexer and failed loudly (a 500 emptied
the whole book on every list-driven scenario); it now maps the state
the same way.

## Connected app — the offset form's default term now survives the wallet window (PR #<n>)

The "exit by becoming a lender" (offset) form pre-fills the longest
replacement term that fits before the original loan's due date. That
bound is judged by the contract to the second, at the moment the
transaction executes — but the form computed the default at the moment
the page loaded. Right after acceptance the remaining term is a whole
number of days, so the default sat exactly on the boundary, and every
second spent confirming in the wallet (or simply network lag) pushed
the replacement maturity past the due date: the transaction was
refused as "terms do not meet lender-favorability requirements" even
though the user changed nothing.

The form now reserves ten minutes of headroom when sizing the default
and maximum term — headroom that is meant to be spent reviewing and
confirming — while the pre-submission rechecks demand only a small
one-minute buffer over the contract's own bound (enough for the
transaction to reach the chain). The suggested term therefore still
fits by the time it lands, without the recheck rejecting a term the
contract would still accept. Near a day boundary the sizing reserve
can shorten the suggested term by one day; a term that genuinely no
longer fits keeps producing the existing "must end before the due
date" explanation instead of a failed transaction.

## alpha02 — stuck-token recovery page (PR #<n>)

The main app's stuck-token recovery utility now exists on the alpha02
site too, rebuilt in its plain-language style. It returns ERC-20
tokens that landed in a user's vault address outside the app (a
mistaken direct transfer, or "dust" a stranger sent) to the connected
wallet — such tokens are never part of any deal and never affect
balances or positions.

The page is deliberately unlisted, exactly like the original: it has
no navigation or Settings entry, search engines are told to ignore
it, and the only way in from inside the app is a new explainer card
on the Help page that first spells out the danger — if the sender a
user declares turns out to be sanctions-listed, their wallet is
flagged and blocked from every new-position action (creating or
accepting offers, deposits, recovery and the like), not just from
this page. Existing loans can still be repaid and closed, and the
block lifts automatically if that address is later removed from the
sanctions list. That is the "dust poisoning" trap the explainer
warns about, and reading it before finding the button is the safety
design, not an oversight.

The flow itself keeps every deliberate speed bump: declare the token,
the sender (a wallet you control), and the amount — capped at the
provable surplus sitting in the vault beyond what the protocol
tracks; review the declaration next to the standing warning; type
CONFIRM to arm signing; sign a typed acknowledgement; and the outcome
is read from what actually happened on-chain, distinguishing a
successful return-to-wallet from the flagged-wallet outcome (which
the page explains honestly, including that the block lifts
automatically if the flagged address later leaves the sanctions
oracle's list).

One honest gate the original relied on documentation for is now
explicit in the page itself: recovery depends on the protocol's
screening service, and on a network where that service isn't
configured yet the page says recovery isn't available — instead of
letting anyone sign a transaction that could only fail.

The declaration a user signs states they have read the Advanced User
Guide's section on stuck-token recovery, so the review card — and the
Help explainer — now link straight to that section rather than leaving
the reader to find it.

Three post-submission cases are handled with the same care as the rest
of the flow. If the wallet replaces the transaction, the page follows the
replacement, so every result and every block-explorer link names the
transaction that actually went through — and it now pays attention to
what kind of replacement it was. Only a cancellation — the wallet
deliberately voiding the transaction — is reported as the definite
"nothing was recovered". Every other replacement is reported as an
outcome to be checked rather than as a recovery that never happened: a
plain fee bump re-sends the very same instructions at a higher price, so
it is still the recovery, and a replacement carrying different
instructions could equally be a second recovery for another token. If the
transaction was sent but its confirmation could not
be read, the page no longer offers a plain "start over" that would
throw the transaction away: it offers a "check the transaction again"
action instead, because a transaction that quietly went through would
let a second, unintended recovery be signed on a fresh form. Only once
the result can actually be read does the page move on to the matching
result and let a new recovery begin.

A submitted recovery is now remembered by the browser until it is
resolved. Reloading the page, switching accounts, or switching networks
used to wipe the record of a transaction that had already been sent and
put a blank form back in its place — the exact situation that could lead
to recovering the same tokens twice. The record is kept per wallet and
per network, so only the account that submitted it ever sees it, and it
is cleared the moment the result is known.

The "check the transaction again" action also copes with a wallet that
replaced the transaction. Looking for the original transaction can never
succeed in that case, so the page instead asks the network whether a
recovery was processed for the account at all. If one was, it says so
plainly and stops there — without claiming to know which of the two
possible results it had, since it cannot read that. If none was, the page
only says "nothing was recovered" once it can prove it, and never on a
failed reading: the network has to positively answer that it doesn't hold
the transaction, and the approval the user signed has to have expired, at
which point that transaction can never be accepted again. Until both are
true the page keeps the transaction pending and tells the user roughly
how long until it can give a definite answer — a momentary network
problem no longer reads as "it's gone", which would have handed back a
blank form over a recovery still waiting in the queue. A count that comes
back BELOW the one the attempt was authorised against is now treated as a
reading the page could not trust rather than as "nothing has happened":
that count only ever goes up, so a lower answer describes a stale or
inconsistent reply from the network, not the account. The attempt stays
pending in that case and the remembered record is kept, instead of the
page eventually declaring the recovery never ran and handing back a fresh
form on the strength of a bad read.

The "an attempt was processed" verdict is now a lasting lock rather than
a notice that vanishes on the next page view. That attempt may have moved
only part of the stuck balance, so the page remembers the verdict for the
same wallet and network and shows it again after a reload, instead of
letting a refresh hand back a fresh form. There is still an honest way
out, but it takes two deliberate steps: first confirm you've checked your
wallet, then confirm again on copy that spells out that the earlier
attempt already used up its approval and that what follows is a new,
separate recovery limited to whatever is still sitting in your vault.

Smart-contract wallets (a Safe and similar) are now told up front that
recovery can't be used from them. Recovery has to be authorised by a
signature from an ordinary wallet address, which those accounts cannot
provide, so the page says so instead of walking the user through the
typed confirmation and a transaction that could only fail. Everyday
wallets that have opted into the newer smart-account upgrade — the one
that adds features to an ordinary wallet without changing its address —
are explicitly not caught by that block: they still sign with the same
key, so recovery works for them and the page now recognises them as the
ordinary wallets they are instead of turning them away.

The page no longer waits for a transaction hash before it starts
protecting the user. From the moment the declaration is signed and the
send is handed to the wallet, the attempt is treated as possibly on its
way. A wallet that takes the send and never answers used to drop the
user back on an armed confirmation card, inviting a second signature
over a recovery that may already have gone out; now it lands on the
unresolved-submission card in its honest form — "we don't know whether
this was sent", no transaction link to offer, and a pointer to the
wallet's own activity list. Re-checking from there reads the network
directly: if a recovery was processed for the account it becomes the
same lasting lock as any other processed attempt, and if none was and
the signed approval has since expired, it can safely start over.

Two tabs open on the same wallet no longer work against each other. The
page re-reads its record of an outstanding submission immediately before
asking for a signature and refuses to sign while one exists, showing
that submission instead; a tab sitting on the form also picks up a
submission the other tab records, so both show the same state. And when
a submission is resolved and forgotten, only that submission is
forgotten — a newer one recorded in the meantime survives, instead of
being quietly wiped along with it. The same rule now covers updates, not
just forgetting: a wallet that takes a long time to answer can come back
after the other tab has already settled that attempt and started a new
one, and its late answer no longer overwrites the newer record — which
would have left the newer recovery unprotected the moment the older one
finished.

Turning a wallet's transaction prompt down is now treated as what it is.
Declining the transaction itself proves nothing was sent, so the page
returns to the review card with the usual "you rejected it" message and
forgets the attempt, instead of holding the flow on the unresolved-
submission card until the signed approval expires half an hour later.
Failures that only *look* like a refusal — a wallet that goes quiet, a
lost connection — still get the cautious pending treatment, because those
genuinely can hide a transaction already on its way.

The form also refuses the all-zero address. It reads as a valid address
to a simple format check, but it belongs to no one, so declaring it as
the sender you control was never a meaningful statement to sign; both
address fields now say so and stop the flow there.

If the browser refuses to store that record at all — private browsing,
storage switched off, storage full — the page now says so on the card
instead of carrying on as though the record exists. It doesn't block the
recovery; it warns that closing or reloading the tab will lose the
page's ability to pick the attempt back up, and that the right next move
is to check the wallet's activity before trying anything again.

Two smaller corrections. A wallet replacement is no longer reported as
"nothing was recovered" unless the wallet actually cancelled: a
replacement only means the transaction that mined carried different
instructions, and "different instructions" equally describes a second
recovery for another token — so anything short of a cancellation is now
reported as an outcome that couldn't be read. And when a re-check finds
the transaction was rejected but the page no longer holds the details
that were originally reviewed (the usual case after a reload), it now
returns a fresh, usable form carrying the reason instead of an empty
confirmation card.

The last-moment screening check on the connected wallet itself now fails
closed. Recovery's result is decided by that screening service, so a
wallet check the page cannot read is not permission to sign; an
unreadable check now leaves the same retryable blocked state an
unreachable availability check produces, rather than being waved through
as "clean".

Finally, the page now separates "this network has no screening service"
from "we couldn't reach it to find out". The first is permanent and is
still stated as such; the second says a check didn't answer, retries by
itself a few times, and offers a manual retry — so a passing network
problem no longer reads as a permanent verdict, or needs a page reload
to clear. That same distinction now holds for the last-moment re-check
the page makes just before asking for a signature: neither answer lets a
signature go ahead, but a check that simply didn't answer is reported as
a retryable problem with the retry route open, rather than as a verdict
that recovery will never work on this network.

The page now reserves its place before it asks the wallet for anything.
The record of an outstanding recovery is written the moment the page has
finished its checks and is about to open the signature prompt, not after
the signature comes back. Two tabs on the same wallet could previously
both look, both find nothing, and both go ahead — and because the two
attempts share the same approval counter, whichever finished second
could wipe the record protecting the other one's live transaction. Each
attempt now carries its own identity, so a tab can only ever clear or
update the record it created itself; a second tab that arrives while one
is outstanding is shown that attempt instead of being allowed to sign.
If the wallet comes back with a declined signature, the reservation is
released immediately — nothing was authorised, so nothing needs
protecting — and the same release happens when the prompt returns to
find the connected account or network has changed in the meantime, since
nothing was sent under the identity that made the claim. A prompt that
is simply abandoned — never answered, or left open when the tab is
closed — keeps its reservation until the ordinary re-check resolves it
at the deadline. That is deliberate: with no answer from the wallet
there is no way to know that nothing was signed, and holding the place
of an attempt that might be live is the safer of the two mistakes.

Results are now read from what the network actually recorded rather than
from what the user submitted. When a wallet replaces a transaction, the
one that mines can carry a different amount or a different declared
sender, and the page used to describe the original submission next to a
link showing something else. The amount, the token and the declared
sender on every result card now come from the event the transaction
emitted, falling back to the submitted details only for what the event
does not carry. If the result names a token the page has no details for
— possible only after a wholesale replacement — it says so plainly and
states the amount in that token's smallest units beside its address,
instead of dressing it up in another token's decimals.

The "confirmed, but we couldn't read what it did" card no longer
contradicts itself. It used to tell the user not to sign again and to
refresh the page, while offering a "start over" button directly beneath
and having already released the record. It now sends the user to the
transaction to see what happened and describes the button honestly: it
starts a completely separate recovery, limited to whatever is still in
the vault. The genuinely locked card — the one for a submission that has
not confirmed — keeps its "don't sign again" wording, because there the
warning is true.

Reading a token's details is now honest about failure. The page treats a
token that simply does not publish its decimal format as usable, taking
amounts in raw units, but it used to reach that conclusion from any
failed read at all — so a momentary network problem could make an
ordinary token look like it had no decimal format, and a user who typed
"1" would have signed for the smallest possible fraction of a token.
Only the token itself declining to answer counts now; a network failure
reports that the token's details couldn't be read and asks the user to
try again, which is the one outcome that cannot mislead them about what
they are signing.

Finally, the "an attempt was processed" verdict is written back only
while the page still holds the same attempt it started with, matching
the care already taken over every other write to that record, so it can
never convert another tab's outstanding recovery into a lock belonging
to an older one.

An automated end-to-end test drives the real contract on a forked
network: dust is minted straight into a vault, the Help explainer's
link is followed, and the recovery round-trips with the tokens
verified back in the wallet — after which a reload has to show a clean
form, proving a completed recovery leaves nothing behind to come back
(which now also proves the reservation taken before the signature is
released again by a successful recovery). A second test seeds a
remembered "an attempt was processed" verdict and confirms it survives a
reload, refuses to offer a plain start-over, and only releases after
both steps of the acknowledgement.

Only one tab can now start a recovery for a wallet. Two tabs open on
the same wallet could previously both look for an outstanding attempt,
both find none, and both go on to sign and send — the safeguards that
followed kept each tab from wiping the other's record, but nothing
actually picked a single winner. The page now takes the reservation
under a lock the browser shares across every tab of the site, so
exactly one tab may claim a wallet; a tab that finds the lock already
taken is told an attempt is already in flight, the same answer it gets
when it finds an existing attempt, and it does not sign. The lock is
held only for the instant it takes to record the reservation, never
across the wallet prompt, so a prompt left open cannot freeze another
tab. On browsers that do not offer such a lock, the page writes its
reservation and then reads it back before signing: a tab that finds
someone else's attempt there stops without signing.

The check that decides whether a wallet can use recovery at all now
answers for the wallet that is connected right now. It reads whether
the connected account is an ordinary wallet or a smart-contract wallet
(the latter cannot use recovery at all, because of how the signature is
authorised on-chain). Switching from an ordinary wallet to a
smart-contract one used to leave the previous answer on screen while
the new one was still being read, so the form could briefly appear for
an account that can never use it. The answer is now tied to the account
and network it was read for and counts only while those still match;
otherwise the page shows its ordinary "checking" line until the fresh
answer arrives.

The Advanced User Guide's own recovery instructions now link somewhere
that exists. Their first step pointed at a path that is not a page on
the guide's site, so a reader who followed the app's link out to the
guide had no way back into the flow. Every language edition of the
guide now links to the recovery page's real address on the app site.

An outcome card now belongs to the wallet and network it was produced
for. The cards that report how a recovery ended — it worked, it was
refused because the declared sender is flagged, or its outcome could not
be read — are shown ahead of every other check on the page, so that a
wallet flagged BY its own recovery still gets the explanation rather
than a generic block. That ordering meant switching directly from one
account to another (or from one network to another) briefly redrew the
previous wallet's outcome card, and the transaction link on it was built
from the network that had just been selected — a real transaction
pointed at the wrong network's explorer. Each card now records the
account and network it describes, and a card that does not match the
connected wallet is dropped the moment the page redraws: the user lands
on the ordinary starting state for the wallet they just switched to, and
the transaction link is always built from the network the card itself
belongs to.

A pending card is also released when another tab abandons the attempt.
Recovery is deliberately limited to one attempt per wallet, and every
tab open on that wallet shares one remembered record of it. When another
tab settles or cancels that attempt it removes the shared record, but a
tab still showing the "we're waiting to see what happened" card kept
showing it. That was worst for an attempt the user declined in the
wallet before it was ever sent: there is no transaction for "check
again" to find, so the card stayed put until the signed thirty-minute
window ran out. A tab now notices the removal and returns to a fresh
form — but only if the card it was showing describes the attempt that
was removed, and only when that card is still an unresolved one. A newer
attempt is left alone, and a settled verdict the user still needs to
read — it worked, it was refused, or an attempt was processed — is never
cleared out from under them.

The card that reports a blocked recovery now states the whole
consequence. When the declared sender turns out to be sanctions-listed,
the wallet itself is flagged and every new-position action is blocked —
creating or accepting offers, deposits, recovery and the like — while
existing loans can still be repaid or closed, and the block lifts
automatically if that address is later removed from the sanctions list.
The card previously said only that recovery had been locked, which
mattered more than usual: outcome cards are shown ahead of every other
check on the page, so this is the only status the user sees after the
transaction, and everything else they tried would have failed without
explanation. It now uses the same words as the standing warning on the
form and the Help explainer, so all three surfaces agree.

Releasing a stale pending card no longer depends on the tab being
awake at the right moment. A tab left in the background can process the
news of a removal only after the other tab has already started a new
attempt over it — and the page used to answer the question "does this
card still describe the outstanding attempt?" by looking at whatever the
shared record holds at that moment, which by then was the newer attempt.
It concluded the slot was still occupied, kept the stale card, and did
the same again when the news of the new attempt arrived, leaving that tab
stuck forever on an attempt that no longer exists. The decision is now
taken from what the change itself reports — which attempt left, and which
one replaced it — so the tab releases the card that went away and then
picks up the one that replaced it, in that order. The release stays
exactly as narrow as before: only an unresolved card belonging to this
wallet, only when the attempt that left is the one on screen, and never a
settled verdict.

A completed recovery now offers a way to start another one. The page
stays open on the result it just produced, and the record of the
finished attempt is already forgotten — but there was no button to clear
the result card, so a wallet holding unsolicited tokens from a second
sender had to reload the page or navigate away and come back before it
could try again. The completed-recovery card now ends with "Recover
another token", which returns an empty form in place. The blocked
outcome deliberately does not get the same action: a wallet flagged that
way is barred from new positions across the whole protocol until the
declared address is de-listed, so a fresh form there could only lead to
another attempt that cannot succeed — that card ends with the
explanation and the note that the block lifts by itself.

Some long-standing tokens are recoverable again. A handful of tokens
predating the final token standard publish their symbol in an older
format, and while the network returns it perfectly well, the app cannot
read it as a name. The page treated that as a failed reading and refused
to offer the recovery form at all, when the promised behaviour was
simply to fall back to a shortened address. Because the symbol and the
decimal format are optional decoration, any answer the network actually
delivers now falls back gracefully — only a failure to REACH the network
keeps the stricter treatment, which is the protection that stops a
momentary connection problem from making an ordinary token accept an
amount interpreted in its smallest units. For the older symbol format
the page now goes one better and reads it in that format, so these
tokens show their real ticker; that extra read happens only after the
normal one has failed, so nothing slows down for the tokens that publish
a symbol the usual way.

Releasing a stale card no longer depends on this tab having redrawn in
between. When another tab records an attempt and removes it a moment
later — the shape of a signature declined as soon as the wallet opened —
both pieces of news arrive together, before the tab that receives them
has had any chance to redraw. It was answering "is this news about the
card I'm showing?" from a picture of the screen that was one redraw
behind, so it still believed it was showing an empty form, skipped the
release, and was left sitting on a card for an attempt that had already
been withdrawn. The tab now answers from the state it has just taken on,
so the pair releases correctly however closely together it arrives.

The rule for reading a token's published details was also tightened: the
form now only falls back to raw-unit entry when the token itself gave an
answer it could recognise — declining, returning nothing, or answering in
an old format. Anything that merely failed to get an answer, including a
node refusing the request or rate-limiting it, is reported as "we couldn't
read this token's details" so the user can retry, rather than being taken
as evidence about the token.

## alpha02 — self-sovereign Risk access page (PR #<n>)

The main app's risk-access settings now exist on the alpha02 site too,
rebuilt in its plain-language style. A new wallet-gated page, reachable
from Settings, lets each user choose how risky the assets in their
deals are allowed to be. Everyone starts at the safest level
("Blue-chip only" — the most established, deepest-liquidity assets) and
nothing moves up unless the user explicitly raises it; the two higher
levels explain in plain words what they additionally allow, including
that deals with unpriced assets settle in-kind on a default.

The page is honest about enforcement: on the current network the
protocol's enforcement switch is off, so it says the choice is saved
on-chain and that whatever level is ACTIVE at the time is what applies
once enforcement turns on — a saved higher choice that is still
cooling down, or that a risk-terms change re-locked, does not spring
into force just because enforcement was enabled.

The trust rules the main app's version earned through review carry
over: the level controls never render over a failed read (choosing a
level blind could restart a safety cooldown), a chosen-but-not-yet-
active level is labelled as "cooling down" versus "risk terms changed —
confirm again" only when the supporting on-chain reads are trustworthy,
and the one-click re-confirm is offered only in the terms-changed case.
Strict mode — an opt-in that adds one extra deliberate confirmation to
every mid-tier deal — is shown here too, with one honest limit: this
app can't collect that extra confirmation yet, so turning strict mode
ON is not offered (it would lock the user out of their own mid-tier
deals once enforcement is on). Turning it OFF always works here — the
recovery path for anyone who enabled it in the main app — including
the note that a recent turn-off keeps the extra confirmation in force
through the safety cooldown.

The page ships with unit tests for the state classification and an
automated end-to-end test that drives the real contract on a forked
network: raising the level, lowering it back, and disabling strict
mode from a vault that had it enabled.

## Connected app — risk-level copy stops fighting the page layout (user feedback 2026-08-03)

The Risk access page listed the levels safest-first, top to bottom —
but its cooldown note said "moving down is instant, moving up may
wait", using an invisible risk-ladder metaphor where "up" means
riskier. On screen, the riskier choice sits LOWER, so the words and
the layout pointed in opposite directions. The note now names the
thing itself ("choosing a safer level applies instantly; choosing a
riskier level may wait out a short safety cooldown").

The notice shown after picking a riskier level was reworded the same
way, and now also stops overstating what happened: instead of
announcing the level as raised (or as already in use), it says the
riskier level is saved, and that it applies immediately — or, where a
safety cooldown is configured, once that cooldown finishes. That
matches what the vault actually does: the choice is recorded straight
away, but it is selected-and-pending rather than in force for the
whole cooldown window.

## alpha02 — extract the display strings the .tsx guardrail can't see

Switching the connected app's display language still left three
prominent surfaces in English even for a fully-translated locale: the
**Activity feed** (every row read "Offer created", "Loan started",
"Loan repaid", … from a hardcoded label map), the **loan-status
badges** shown on every position and history row ("Repaid",
"Defaulted", "Closed", "Being settled", "Past due"), and the **Claim
Center** batch labels ("Loan #N — your proceeds", "surplus after
liquidation", …). The cause was the same extraction gap #1329 chased,
but in a blind spot: these strings live in plain `.ts` modules
(`lib/activityView.ts`, `lib/loanState.ts`, `data/claimAll.ts`), and
the hardcoded-string guardrail only scans `.tsx`, so they never had a
catalog key and no locale could translate them. A user-facing "notice"
in the alerts card (shown when the alert service is mid-rollout) was
hardcoded the same way.

Every one of these now routes through the `copy.*` catalog. The pure,
unit-tested modules stay framework-free: `activityView`/`loanState`
keep an English fallback label and expose a stable key/state that the
rendering component resolves through the catalog, and `claimAll` takes
its label strings as an injected argument (defaulting to the English
source, so its existing tests and callers are untouched). The catalog
grew by ~60 string leaves — 48 activity event labels, six loan-status
words, eight claim phrases, and the alerts notice.

Parametrized labels ("Due in N days", "Loan #5 — your proceeds",
"Interaction rewards — X VPFI") remain English for now: the i18n
factory does not yet translate function-valued (interpolating) catalog
entries — the same platform limitation every existing `(n) => …`
helper has — so they are deliberately deferred, not missed. As with
#1329/#1330 the newly-extracted keys ship English-only and fall back to
English in every locale until translated (tracked in #1323 alongside
the remaining locale bundles).

The Activity label set also now covers every event kind the indexer
attributes to a wallet's own feed — nine reward / VPFI-vault / roll /
settlement-breakdown kinds (e.g. "Rewards claimed", "VPFI deposited to
vault", "Loan rolled over") that previously fell through to a humanized
English label in every locale.

To stop the activity-label map from silently drifting back out of the
catalog, a unit guard (`lib/activityView.test.ts`) now fails the build
if any `ACTIVITY_LABELS` kind lacks a matching `copy.activity.labels`
entry (or vice-versa), and — Codex #1343 r1 — if the label set doesn't
cover the indexer's full attributed-event set (the `pluckActivityRefs`
cases) — the same "can't drift" contract the notification and indexer
event maps carry.

Part of the #1329/#1323 extraction lineage (the `.ts`-module leg);
does not close #1323, which still tracks the locale bundle backfills
and parametrized-string translation.

## Indexer — Durable Object write diet + relaxed cron backstop (PR #<n>)

The hosting free plan caps how many Durable Object storage rows the
indexer may write per day, and the cap was being exceeded — almost
entirely by bookkeeping that wrote the same values over and over. Two
changes bring usage well under the cap:

- **Write guards**: the per-chain ingest object's trigger and loop
  bookkeeping now read-compare-skip before every storage write. An idle
  "anything new?" ping — the overwhelmingly common case — previously
  spent several storage rows re-writing an unchanged chain id, an
  unchanged scan target, and a reset of a counter that didn't exist;
  it now writes nothing beyond the single unavoidable alarm arm.
  Genuinely changed values still persist exactly as before, batched
  into one write.
- **Cron backstop relaxed to every 5 minutes**: on-chain events reach
  the indexer through webhooks, which trigger an immediate scan — event
  freshness (offers, loans, the notification bell's event rows, the
  push rail) does not ride the cron. The cron is the time-driven
  backstop (due-date reminder sweep, market-expiry sweep, config
  refresh backstop), and those duties tolerate minutes. Connected apps
  learn the new cadence automatically — the rail reports its expected
  scan cadence and clients size their "is the live rail healthy?"
  window from the reported value — and the keeper's loan-health pass
  had its freshness tolerance widened to match, so health warnings keep
  minting.

Two review-round refinements keep every latency property that the old
schedule provided: the every-minute tick still exists and drives the
LEGACY fallback path (so an incident rollback away from the new ingest
plumbing keeps its old per-chain freshness), and a webhook whose block
hasn't reached the safe confirmation depth yet keeps being retried by
the ingest object itself (a slower self-driven retry lane) instead of
waiting for the next cron. A production follow-up reshaped HOW the two
cadences coexist: the hosting free plan also caps cron schedules at
five per account — all five already in use — so instead of a second
schedule, the single every-minute schedule remains and each tick
decides by its own timestamp whether the 5-minute ingest work runs
(minutes divisible by five) — behaviourally identical, one trigger
slot.

What users may notice: nothing on event-driven updates (webhook-fast as
before). The purely time-driven inbox reminders (due-date, grace,
health-band) and market-expiry cleanup can now land up to ~5 minutes
later than before — well inside their hours-to-days windows. The
autonomous keeper and agent keep their every-minute schedules; they do
not touch the capped storage, and the keeper's liquidation latency is
unchanged.

## Contracts — conditional risk-tier setter closes a two-device race (PR #<n>)

Changing a vault's risk level from two devices at nearly the same time
had an unfixable-in-the-app race: each device checks the current state
before asking the wallet to sign, but the wallet-confirmation window is
unbounded, so the second transaction can land after the first already
moved the state — and re-submitting a just-raised level restarts its
safety cooldown while charging for a transaction that changed nothing
useful.

The risk-access facet now offers a conditional variant of the tier
setter, in both direct and gasless (relayer-submitted) forms. The
caller states two observed values — a per-vault change counter that
every tier write advances, and the platform's current risk-terms
version — and the contract applies the change only while both still
hold; otherwise it reverts with the CURRENT values (nothing changes),
which is the app's cue to refresh and re-present. The change counter
means even a lower-then-re-raise sequence that lands the visible state
back where the caller saw it is still detected as movement, and the
terms-version binding means a governance terms update between the
caller's reads and the transaction can never be silently re-affirmed.
For the gasless form the observed values are inside the signed
message, so a relayer cannot alter or strip them. The unconditional
setter remains for compatibility; semantics of an applied change are
identical, cooldown and anchor re-stamp included. A read-only view
exposes the change counter for apps to plan against.

Apps adopt the conditional variant once this lands in a deployment
(tracked with the follow-up that filed it); nothing changes for
existing integrations until then.

## Operator runbooks can no longer cite a directory that was removed

Review kept finding the same mistake in the operator documentation, in a
different document each time: a reference to a directory that no longer exists.
It is not the kind of mistake care prevents — nothing tells the person renaming
a directory which prose mentions the old name — so it is now checked by a
machine on every change, and the check **blocks** rather than warns.

The application directory was renamed some time ago and one hundred and
forty-seven mentions of the old name survived across thirty-nine documents. An
operator following one looks for something that is not there, usually at the
moment they can least afford to.

Seventy-two of those references — every one in the operator runbooks — are
corrected here rather than merely recorded. Where the old location simply moved,
each citation now names the new one. Where the thing itself was deleted, the
surrounding instructions were rewritten to say so: the deploy documentation had
operators syncing a second copy of the deployment addresses and running an
export step for a component that no longer exists, both of which were removed
when the background workers were split apart.

### Why it blocks instead of reporting

An earlier version of this change did not block. It carried a recorded list of
every existing problem and reported only when a document got worse, because the
backlog was assumed too large and too historical to clear.

That assumption turns out to be false where it matters. The platform is not yet
live, and the operator-facing part of the backlog was seventy-two references
across six documents with knowable answers — so it was fixed. With those
documents clean, the recorded list, the machinery that policed it, and the
follow-up task to eventually turn the warning into a gate all became
unnecessary. The check now demands zero, which is a stronger promise than the
recorded list ever made, and it is roughly seven hundred fewer lines of
machinery to trust.

What it covers is the operator runbooks specifically — where a wrong path costs
somebody real time, and where the cleanup has actually happened. The design
notes and closed to-do entries still hold older references, and some of those
must not be rewritten at all: the document that records the removal of a
component has to name the component it removed. Clearing what should be cleared
is tracked separately, and finishing it is what allows the check to cover more.

### One rule, and the reason it is only one

Three further checks were built alongside this one and deliberately held back:
whether a cited path exists at all, whether documents use the current form of an
application address, and whether a credential is written into a command line
where others can read it. Each was set aside on its own merits over several
rounds of review, and only afterwards did the common cause become clear.

All three ask a question of the form "is this thing absent or wrong", which
means they fire on anything the reader hands them that they cannot account for
— including fragments of text that were never a reference in the first place.
The part that finds candidate references in prose is deliberately imprecise,
because doing that job precisely means implementing the whole markdown language,
and eleven rounds of review demonstrated that approximating it converges on
nothing. Every one of those rounds' false alarms arrived through a question of
that shape.

The rule that shipped asks the opposite kind of question — "does this text
contain one of these two known-dead names". Review then sharpened the claim
behind it: a garbled fragment *can* trip the rule, but only when the garbled
text genuinely contains the dead name — in which case the document really does
mention something that no longer exists, and the alarm is true. What the rule
cannot do is raise an alarm about nothing; the worst an imprecise reader causes
is a miss. That trade is deliberate: a check that cries wolf is one people learn
to ignore, and then it protects nothing at all.

The same round of review found that commands were being read too coarsely —
an instruction like "change into the old directory and deploy" slipped past
because the whole command was treated as one name — and that three of my own
corrections had replaced a stale instruction with a wrong one, including a
database-migration command that does not exist and a credential rotation that
would have left a revoked token live. All are fixed, each verified against the
scripts and configuration they describe rather than against what sounded
plausible.

That distinction is now written down as the standing rule for adding a check
here, so the next person does not have to rediscover it over eleven rounds.

### One correction, kept in view

An earlier draft of this note claimed every broken link in the main
specification had been repaired. Three of them point at test files that exist
nowhere under any name, and repairing those means guessing whether each was
renamed, removed, or never written. They are left alone rather than quietly
deleted. Overstating what a check delivers is the same fault the check exists to
catch, so the correction sits here rather than somewhere quieter.

## Indexer — deep backlogs now drain in hours, not days (PR #<n>)

During the July outage recovery, catch-up speed was bounded by the
ingest loop's shape: a routine timer tick asked only "anything new?",
so one bounded chunk of blocks was scanned and the loop parked until
the next five-minute tick — even when hundreds of thousands of blocks
remained. Base Sepolia took ~14 hours to drain a ~340k-block backlog;
Arb Sepolia's ~1.5M-block backlog projected to about a week.

Now, when a scan completes successfully but stopped more than one full
pass-budget short of the chain's safe head, the loop re-arms itself on
the existing 30-second slow lane instead of parking. Only successful
passes qualify — an erroring chain keeps its bounded retry budget, so
this can never turn into a retry storm — and the extra bookkeeping is
one alarm write per draining pass, only while genuinely behind. At the
drain rate this enables, a week-long backlog converges in hours.

The decision runs at the shared completion point of EVERY successful
scan, however it was triggered. A webhook-driven scan already
self-drives toward its known target block; what changes for it is the
tail: where reaching the target used to park the loop uncondition-
ally, a pass that met its target while still more than one full
pass-budget behind the safe head now keeps draining on the same slow
lane. The headline win is the disaster-recovery lane — where no
webhook tells the loop how far behind it is — but operators should
expect the loop to keep consuming its one-alarm-per-pass budget after
ANY trigger while a genuine backlog remains, and to park only once
within a pass-budget of the head. An immediate webhook trigger that
arrives while a drain pass is finishing keeps its immediacy — the
drain re-arm never overwrites an earlier-firing alarm.

## Indexer stats routes report deploy provenance

The backend Workers had no externally visible build marker, so "is the
merged code actually live?" required dashboard access — the frontends
have long answered it with a footer build hash. The indexer's two
stats routes now include the deployed version's id and creation timestamp
(from the platform's version-metadata binding), covering automatic
and manual deploys alike. One curl now answers what is deployed.

## Indexer — a mis-pointed RPC now fails loudly, never silently (PR #<n>)

During the July ingest outage, the final silent phase came from an RPC
URL that answered for the wrong network: its chain was shorter than
ours, so every scan concluded "nothing new" and exited cleanly — no
error, no log line, no cursor movement — while the tail showed only
healthy-looking ticks. Diagnosing it took a day of correlating public
API staleness, database cursors, and log silence.

Two guards close that class:

- Before scanning, the indexer now asks the RPC which chain it serves
  and compares. A mismatch logs one unmistakable error line naming the
  expected and reported chain ids — deliberately no part of the RPC
  URL, not even the hostname, since some providers embed the access
  credential there; the expected chain id alone identifies which
  per-chain RPC secret is mis-pointed — and the scan is skipped as a
  retryable failure, so it can never masquerade as "caught up". A
  verified pairing is remembered per running instance, so the
  steady-state cost is one extra call per deployment restart. A
  transport hiccup on the probe is not treated as a verdict, but it
  does not let the scan proceed either — an endpoint whose identity
  was never established could be the mis-pointed one, and scanning a
  wrong chain whose history is LONGER than ours would advance our
  position past real blocks and permanently skip them. The pass is
  skipped as the same retryable failure and the probe simply re-runs
  next pass.
- Separately, if a scan finds the chain head sitting far BELOW our own
  stored position — never a healthy state — it logs a loud stale-or-
  mis-pointed-RPC warning instead of quietly treating it as caught up.

Had these existed in July, the whole hunt would have been one log
line: "RPC for chain 84532 answered eth_chainId=1 — mis-pointed
RPC secret".

## The off-chain backup service is now called "warm"

A naming change, not a behaviour change. What was described throughout as the *archive* service — the scheduled job that copies off-chain data to separate storage nightly, and the storage bucket it writes to — is now called **warm**. Nothing about what it does, when it runs, or what it stores has changed.

**The shared database is not part of this.** It keeps its existing name, and every service still reads and writes exactly the database it did before. That is deliberate and is explained further down: a database cannot be renamed, so adopting the new name would mean moving to a different database — a change to where live data goes, which does not belong in a renaming. If you are looking for which database to point something at, the answer is unchanged.

**The word was carrying two different jobs, and only one of them moved.** "Archive" was naming both the *service* and the *things it stores*. The service is renamed; the stored objects are still archives, and are still called that. So the bucket and the Worker change name, while an archive file is still an archive file — renaming those would have produced phrases like "warm bytes", which is worse than what we started with.

Three things deliberately left alone:

**Historical records.** Dated release notes and archived document snapshots still say "archive", because that is what the system was called on those dates. Rewriting them would make those records claim something untrue about the past.

**A different sense of the same word.** The deploy scripts archive local artefacts into a timestamped folder when redeploying from scratch. Same word, unrelated meaning, untouched.

**Third-party code.** Nothing under the vendored dependency trees was modified.

### What an operator needs to do

The names in the repository are only half of it — the live resources they refer to still carry the old names, and two of them cannot simply be relabelled.

The **storage bucket** cannot be renamed at all: those names are permanent once created. A new one has to be made and the old one retired. Because the platform is pre-live, nothing in the old bucket needs preserving, so this is a create-and-switch rather than a migration — but it is worth being explicit that the retained older copies of each backup do **not** come across, since those are what a recovery would draw on.

The **shared database is deliberately NOT switched by this change.** It cannot be renamed — the platform offers no way to change an existing one's name, so moving to the new name means moving to a new database — and that is a change to where live data is written, which does not belong in a naming change.

Two things made bundling them unsafe rather than merely untidy. The application services redeploy automatically when this lands, so merging would have performed the switch immediately, with no opportunity to sequence it. And the irrecoverable rows were copied ahead of time, so anything written between that copy and the switch would exist only in the old database and be lost when it is retired.

So the replacement database exists and is fully prepared — created, every schema step applied, and the handful of genuinely irrecoverable rows copied and checked — but nothing points at it. The services continue reading and writing the database they always have. Switching over is its own deliberate step, and it needs a fresh copy of those rows taken *after* the last writer has moved, compared for equality, rather than the early copy that is there now.

**A check now enforces that the database is named in one place.** Backing the rename out of the database was itself done twice: the first attempt reached the four service configurations but not the deploy commands, the operator runbooks, or the restore steps — which would have applied schema changes to one database while the services read another. Neither half looks wrong on its own, and nothing fails: the deploy succeeds, the service starts, and the schema it needs is simply somewhere else. So the name is now declared once and verified everywhere it is used, including in the copy-paste blocks operators run by hand and the commands inside package scripts. A partial rename — the exact shape that got past the first attempt — now **blocks the merge** rather than being something a reader has to notice.

That check reads commands, not prose. A sentence in a design document describing the database by name is still only as good as the person who wrote it.

Two more limits worth stating plainly, because a check believed to cover more than it does stops people looking. It matches commands that **name the database directly**; one script builds its command by assembling the name instead, and that one is covered by checking the constant it uses — but a *new* script doing the same thing would have to be added to that list by hand, and nothing detects the omission. And it verifies that every place agrees on one name; it cannot tell you that name is the *right* one.

The **Worker** is created fresh under the new name, and the old one is then deleted — not merely stopped, because a stopped Worker still holds its scheduled slot from a limited pool.

There is one spare slot, so the replacement can be created before the old one goes. (An earlier draft of this note said the pool was full and the two could not coexist; counting the live triggers showed four of five in use, the fifth being held for a service that is not yet deployed. It is worth borrowing during the switch and is free again afterwards.)

**Do not delete the old Worker until the new one has actually run.** A fresh Worker inherits none of the old one's configuration — not the encryption key, not the storage credentials, not the alert channel. So the order is: create it, configure it, watch a scheduled run complete, and only then retire the old one. Deleting first leaves no working backup at all, and the gap would not announce itself.

**The alert channel is the one setting that will NOT stop the Worker if you forget it**, and an earlier draft of this note said the opposite — that it refuses to run until every setting is present. That is true of the storage credentials and the encryption key, and deliberately not true of the alert credentials: a backup that runs unwatched is better than one that refuses to run because its notifier is unconfigured, so a missing alert channel produces a log warning and the backup proceeds.

That is the right trade, and it is a trap here specifically, because the step above uses "an alert arrived" as the signal that the replacement works. If its alert credentials are missing, **no alert arrives and the backup ran perfectly well** — indistinguishable, from the channel alone, from a Worker that never ran. So verify the alert settings are present on the replacement explicitly rather than inferring them from silence, and confirm the run itself in the Worker's own invocation log before retiring anything.

**"An alert arrived" is not that proof, and an earlier draft of this note said it was.** During the changeover both services run on the same nightly schedule and report through the same channel, and the success message did not say which of them sent it. So the old service's alert could be read as the new one's — and acted on by deleting the only one that was actually working. The alert now names the storage bucket it wrote to, which is the one thing that differs between them; so does the failure alert. There is a third alert — the one fired when the Worker cannot start because a setting is missing, which is the likeliest way the replacement fails — and that one cannot name a bucket, because an unset bucket is among the things it reports. It names the Worker instead. All three are now attributable. Check that line says the *new* bucket before deleting anything; if it does not, the replacement has not run yet regardless of how many alerts arrived.

The encryption key deserves its own line. It must be generated locally and kept somewhere outside the hosting provider, because the entire point of it is that losing the provider does not lose the ability to read the backups. A key that exists only as a provider secret is not a backup key; it is a second copy of the same single point of failure.

One provider-side loose end to check rather than assume. The hosting provider can be configured to build a Worker automatically from a directory path recorded on its side; where such a configuration points at the old directory, it will start failing once the rename lands. That does not disturb the running service, which keeps operating from its last successful build — it only means a red build on the provider's dashboard until the project is repointed or replaced.

**It has now happened, and this paragraph took three attempts to get right.** The first draft said the build would fail and show as a red check on every pull request — asserted, not checked. The second looked at the checks reporting on pull requests, found only the indexer's, and concluded no such check existed here. That was the right instinct applied to the wrong sample: the automatic build for the old service reports on **pushes to the main branch**, not on pull requests. Once the rename merged, it went red there — visible on the merge commit, invisible on every pull request that preceded it.

So the loose end is real and is currently outstanding. What has *not* changed is the advice: do not attribute the red mark by timing alone. Open the project, check whether its configured root still points at the removed directory, and read the build log. A genuine build, typecheck or deploy failure in a correctly repointed project produces exactly the same red mark, and only the log separates them.

The lesson worth keeping is the sampling one. "I checked and it does not report" was true of the surface I looked at and false of the one that mattered — a build configured to run on merges was never going to appear in a pre-merge check list.

Until those steps are done the running system is unchanged and unaffected; the repository simply describes it by its new name.

## Thread — RL-1: interaction-reward claim-to-vault delivery (PR #TBD)

The VPFI recycling loop-closure design (`VpfiRecyclingLoopClosureDesign.md`,
ratified 2026-07-16) found the reward loop open at the distribution end:
every claimed interaction reward paid straight to the claimant's wallet and
exited the sink system entirely unless the user manually re-deposited it.
RL-1 closes that leak. A direct wallet (EOA-style) claim now delivers the
payout into the claimant's own per-user vault by default, where it
immediately counts toward protocol-tracked balance and VPFI fee-discount
tier standing — the Jupiter-ASR-style "reward re-enters the system at
claim" pattern, without any lockup (vault withdrawal stays available at all
times).

The delivery is powered by a new Diamond-funded vault credit primitive: the
Diamond pays the reward from its own pre-funded balance directly into the
claimant's vault proxy and then runs the same recording tail a normal
deposit runs (tracked-balance increment plus a post-mutation tier rollup),
so the credit is never clamped out as unsolicited dust. The tier rollup on
this path is deliberately broadcast-free — a claim never inherits the
cross-chain tier push's failure modes; the push rides the user's next
balance mutation. Delivery never reduces claim availability: if the vault
credit cannot complete (no vault yet, a pending mandatory vault upgrade, or
a tier-bookkeeping failure), the whole vault-side unit rolls back atomically
and the claim pays the wallet exactly as before — never a double-pay, never
partial vault state.

Contract callers keep the raw wallet-style transfer they always observed
(the aggregator adapter and backstop vault forwarders are additionally
hardwired to it), and every caller can pick the venue explicitly via a new
explicit-delivery claim entry — so a Safe or account-abstraction wallet can
opt in to vault delivery. A new per-claim delivery event (stamped with the
claim day) makes vault-delivered claims observable for the upcoming RL-2
loop-closure dashboard metric. Functional spec §4 gains the "Claim delivery
venue" rules in the same diff. Follow-ups per the design's §9 plan: RL-2
(loop-closure metric + vault-debit observability event), RL-3 (365-day
claim horizon), RL-4 (allocation register, Phase C′), RL-5 (absorption
bootstrap sequencing).

## Thread — RL-2: loop-closure metric — retention ledger + VaultVpfiDebited observability (PR #TBD)

Second delta of the recycling loop-closure design (RL-2, ratified
2026-07-16). With RL-1's claim-to-vault delivery live, this makes the
loop's health measurable: how much of the distributed interaction-reward
VPFI actually stays inside the sink system.

One small contract change: the Diamond now emits a dedicated debit event
whenever protocol-tracked VPFI leaves a user's vault through the single
tracked-balance decrement chokepoint — wallet withdrawals, notification
tariff pulls, fee pulls, and future perk spends all route through it.
Without this signal, vault outflows were invisible off-chain and any
retention accounting would overstate loop closure.

The indexer gains a per-user reward-retention ledger driven by the RL-1
delivery event and the new debit event: deliveries credit it, debits
decrement it rewards-spent-first (clamped at zero — later personal
deposits never re-inflate it), and every effect applies exactly once even
when scan ranges overlap. A new read endpoint serves the two ratios the
design pins: the daily flow ratio (per-user same-day netting, so one
user's spending never cancels another's retained delivery, and a
claim-and-spend-same-day counts once — the metric is a conservative lower
bound that can never overstate closure) and the cumulative stock ratio.
Zero-distribution days report "not applicable" rather than a misleading
zero. The absorption term is defined but reads zero until the governor
stack's recycle-bucket accounting lands (PR-3a), so no re-baselining
happens later. The endpoint is the metric's canonical surface until the
transparency-dashboard card (#1218) gives it a display home. Functional
spec §9 gains the metric's intended-behaviour rules in the same diff.
Closes #1303.

## Thread — RL-6: legal evidence pack + rewards copy-rules release gate (PR #TBD)

The recycling loop-closure design (RL-6, ratified 2026-07-16) found the
stack's legal argument asserted from first principles but the external
precedent set recorded nowhere in the repo. This lands the evidence pack
as a new appendix in the VPFI tokenomics research doc: the Fuse no-action
letter (SEC Corp Fin, 2025-11-24 — the first no-action relief for a
rewards token, recorded with the counsel-letter-versus-staff-response
attribution and its partial-analogy scope preserved), the Corp Fin
protocol-staking statement (2025-05-29 — cited only for the
determinism/no-operator-discretion property the loop must keep, never as
applicable to token-holder rewards), and a condensed production-protocol
benchmark table. The "hand any future counsel two documents" package is
now explicit: release 33-11412 plus the Fuse letter, benchmark as
context.

The design's four copy rules (usage rebate / fee discount / program
longevity — never yield, APY, income, deflation, scarcity, or price; own
activity, never passive holding; no market touch; deterministic
bookkeeping) are restated as a release-gate checklist in the same
appendix, and the project instructions now require every PR touching a
user-facing recycling/rewards surface to pass it before merge — under
33-11412 issuer representations are the dominant factor, making this the
cheapest legal insurance in the program. Docs-only; no code, spec, or ABI
surface touched. Closes #1304.

## Signal-gated freshness graduates: the legacy-timers hatch is removed

The read-diet rollout shipped with a build-time escape hatch that
could pin the connected app back to its old fixed-timer refresh
behaviour without touching the server side. The design gated the
hatch's removal on a live post-deploy review: pushed updates observed
end to end on the deployed testnet, including a position NFT changing
hands and the new holder's claim surfacing from the live signals.
That review passed, so the hatch is gone.

Nothing changes for users. The rail-down fallback — plain polling at
the old cadence whenever the push rail cannot prove itself — remains
the permanent safety net; it is the same posture the hatch pinned,
reachable automatically instead of via a build flag.

## RPC read-diet PR D — scoped push hints with causative context

Final slice of the read-diet design. Push invalidation frames now
carry a bounded list of the loan and offer ids the scan actually
touched, plus the causative linkage for creations (which offer was
consumed and who the parties are). A tab whose wallet provably has
nothing to do with a frame skips refreshing its own-position surfaces
for it; shared surfaces (books, tape, activity) refresh as before.

The contract is truncation-honest end to end: hints only ever narrow
work when they are complete. A busy scan past the id cap, any event
whose affected row cannot be identified centrally (position-NFT
transfers, signed-offer lifecycle), an older worker without hints, a
malformed field, or a tab that cannot derive its own id sets — all of
these degrade to today's coarse behaviour. Scoping can only remove
redundant refreshes, never suppress a needed one. The launch cap is a
conservative guess; a follow-up tracks re-tuning it from real
per-scan volume once rehearsal load exists.

## Thread — Search/AI discoverability for www + alpha02, and alpha02 multi-language foundation (PR #TBD)

The marketing site and the connected app were both client-rendered
single-page apps, which meant search engines saw thin pages and the
JavaScript-less crawlers behind AI tools (GPTBot, ClaudeBot,
PerplexityBot and similar) saw essentially nothing. This thread makes
both surfaces first-class citizens for search and AI ingestion, and
lays the full multi-language foundation for the connected app.

**Marketing site (vaipakam.com).** The deploy pipeline now prerenders
every marketing route in every translated locale (110 pages) to static
HTML after the build, so any crawler receives the full rendered page —
headings, copy, per-locale title/description/canonical/hreflang —
without executing JavaScript. Every page also carries Open Graph and
Twitter Card tags (link unfurls on X/Discord/Telegram now show a real
card), and structured data was added: organisation and website
identity on the landing page, the FAQ as a machine-readable Q&A set
(rebuilt per locale), and article metadata on the overview, user
guides and whitepaper. For AI tools specifically, the canonical docs
are now published as raw Markdown under stable `/docs/*.md` URLs and
indexed by a root `llms.txt` (plus a one-fetch `llms-full.txt`) — the
emerging convention AI crawlers check. Prerendering is deliberately a
deploy-time step, not part of the plain build, so CI and typechecks
need no browser; a prerender failure still leaves a fully deployable
SPA build.

**Connected app (alpha02).** The app now states an explicit indexing
policy: generic product surfaces (home, borrow, lend, rent, offer
book, rate desk, VPFI, NFT verifier, help) are indexable with
per-route titles, descriptions and production-origin canonicals, while
wallet-scoped pages (positions, claims, vault, activity, settings,
faucet) are excluded via noindex both in-page and at the header layer,
so a JS-less crawler sees the same policy. A generated robots.txt and
sitemap ship with every build. The indexer Worker's root URL, which
previously answered 404, now returns a self-describing catalog of the
public keyless JSON API — so AI agents and integrators discovering
Vaipakam via llms.txt fetch supported endpoints instead of scraping
the app.

**Multi-language (alpha02).** The i18n machinery that already served
the marketing site was hoisted into a shared workspace package
(`@vaipakam/i18n`) — locale registry, do-not-translate glossary, RTL
handling, detection chain and translate tooling now exist exactly once
— and the marketing site was migrated onto it with no behaviour
change. The connected app is wired end-to-end: its centralized copy
catalog now resolves through the translation layer at read time (zero
changes at the ~900 call sites), a Language card in Settings offers
the first wave (English, Spanish, Chinese, Hindi, Japanese), the
choice persists across the `.vaipakam.com` subdomains, and
right-to-left locales flip layout before first paint. Per the
operator's direction, no machine translations were committed: all 33
non-English locales ship as placeholder bundles that render English
until translated, with a generated `en.json` template (drift-checked
in CI) for translators to mirror and a documented promotion recipe per
locale.

Follow-ups deferred: converting parametrized copy strings (function
values) to interpolation keys so they become translatable; locale URL
prefixes + hreflang on alpha02 once the first translated bundle ships;
registering both hosts in Google Search Console / Bing Webmaster Tools
(operator-side).

## Operator runbooks reconciled against the month's changes (docs-only)

Folding a month of threads into one file made it possible to ask a
question no single PR was in a position to ask: does what the operator
runbooks say still match what the protocol does? Four answers were no.
Each was checked against the contract source rather than against another
document, because a runbook that was derived from a stale runbook is how
these drift in the first place.

**The administrator's fee reference described the retired fee path.** It
said the loan-initiation fee is "paid by the borrower in VPFI at loan
start". Since the peg-custody retirement, a new loan takes no VPFI into
custody at all — the fee is charged in the lending asset and the
borrower's hold-tier discount is applied directly to it at acceptance.
The same paragraph said tier discounts "can take the borrower's
effective fee to zero"; they cannot, because the discount is clamped at
half. Both are the kind of error that reads as harmless until someone
reconciles a treasury balance against it. The matcher kickback section
inherited the same wrong denomination and has been corrected alongside,
with a note about the one place the event and the transfer legitimately
disagree.

**The same document told an auditor the treasury-fee guard was tighter
than it is.** It described the cap as "conventionally 10% … without ever
crossing into 'majority of interest goes to treasury' territory". The
compiled ceiling is 50%. That is a defensible cap — it is a sanity
bound against a mis-denominated write, and the timelock is what makes it
survivable — but it is not the reassurance the sentence was offering. A
document whose stated purpose is to let a reader reason about a
compromised admin has to state the real ceiling.

**Nine governance knobs shipped this cycle into a document that claims to
cover every one of them.** The recycling margin, both tariff
coefficients, the Full-tariff kill switch, the reward haircut, the
per-user daily share cap, the allocation-register weight, the claim
horizon and the surplus multiple are now written down with their
defaults, their bounds, and the reasoning behind each bound — along with
the arming and topology knobs beside them. The single most important
thing recorded is that **this group does not share one sentinel
convention**: a stored zero means reset-to-default on four of them, dark
on two, and is rejected outright on one. An operator who assumes a
single convention across the group either arms something nobody decided
to arm or leaves something off they meant to arm.

**The incident runbook still said cross-chain alerting did not exist.**
It was written when the LayerZero watcher was retired and nothing had
replaced it, and it was true then. The recycling-mesh watcher has since
gone live and it pages. A responder holding a Telegram alert would have
found a section telling them the alert they were holding could not
exist. There is now a response procedure for that rail — what the
CRITICAL and advisory findings mean, what to check before acting, and
the two containment levers that actually exist (stopping the keeper's
reward passes, and pausing cross-chain ingress). It also records what
not to do: none of the recycling knobs repairs an inconsistent ledger,
and two of them make things permanently worse if written during one. The
retired section's claim has been narrowed to what is still true — the
transport-level gap — rather than deleted, because that gap is real and
still tracked.

**The per-chain verification checklist gained the governor's posture.**
Its reward-plumbing section predates the mesh entirely. It now also
checks the recycling ledgers and, mostly, checks that the dark things
are still dark — finding the Full tariff or the claim horizon armed on a
chain where nobody armed it is the finding, and the checklist now says
so.

Not fixed here, and worth naming: the repository's own contributor
guidance still quotes the pre-freeze treasury fee in its constants
summary. It is one line, outside the operator runbook set, and left for
its owner.

## The fee freeze reached the code in July and the documentation in August (docs-only)

The rev-8 fee freeze doubled both headline fees — the loan-initiation
fee from 0.1% to 0.2% of principal, and the treasury cut from 1% to 2%
of lender interest — and, separately, moved the borrower's fee out of
VPFI custody into a direct reduction of the lending-asset fee at
acceptance. The contracts have behaved that way since July. A sweep of
everything that quotes those numbers found the documentation had not
caught up, in one place that mattered more than the rest.

**The connected app and the marketing site were quoting the old fees to
users, in ten languages each.** The landing page's summary line and the
FAQ's fee entry both carried "0.1% Loan Initiation Fee + 1% Yield Fee",
along with the derived claim that a borrower receives 99.9% of the
offered amount. Sixty strings across twenty locale files now say 0.2%,
2% and 99.8%. The late-fee line beside them was checked and left alone:
1% on the day of miss, 0.5% per additional day, capped at 5%, all still
correct.

Worth noting why this drifted at all, because the fix is only half a
fix. The newer alpha02 surface does not quote fees as text — it
interpolates them from live values, so it cannot go stale. The two
older surfaces hardcode them into translated copy, and a registry
introduced for exactly this problem (with a build-time guard proving
its ten published figures still match the protocol constants) covers
the documentation path, not the locale files. The guard is green and
was green throughout; it simply does not look where this drift lived.
Extending it to the locale catalogues is not done here.

**The repository's own guidance was telling every future contributor the
wrong constant.** The contributor guide and the contracts README both
listed the treasury fee at 1%, so anyone — human or agent — reasoning
from them would have reasoned from a stale number. Both now carry the
live values, and both now record the thing that makes this fee subtle:
the rate is resolved per loan from the value stamped at its origination,
with a deliberately frozen 1% fallback for loans that predate stamping.
Collapsing that fallback into the live knob would silently reprice every
grandfathered loan at repayment, which is why it is called out rather
than tidied away.

**Design records were treated differently from live documents, on
purpose.** A research note that compared Vaipakam's cut to Aave's, an
architecture decision record about time-weighted discounts, and a
redesign's "current state" table all quote the old figures — correctly,
for when they were written. Rewriting them would destroy the argument
each was making. Each now opens with a note saying which figures are
historical and what the live ones are. The glossary, the treasury
explainer, the swap-to-repay reference and the workflow walkthrough are
live documents rather than records, so those were corrected outright,
including recomputing eleven worked examples that had a lender receiving
1049.5 USDC where they now receive 1049.

Left alone deliberately: the dated release-notes archive, the older-docs
backups, the dated findings reports, and a captured audit artifact.
Those are records of what was true on a date, and a record that gets
edited to stay current is no longer a record.

## Desk order ticket — the fill mode you picked is the one that gets posted

The rate desk's order ticket shows the fill mode in force, and posts it.

A gasless lend order can only ever fill as one whole loan, so the ticket
switches the default "Partial" to "AON" and disables the Partial chip in that
mode. Previously the ticket stored one mode and corrected it a beat later,
which left a moment where the ticket claimed partial fill in a mode that cannot
serve it — and everything read off that claim during the moment, including the
order preview and the fee estimate, described an order that could not be
posted. The mode shown is now derived from the terms rather than corrected
after the fact, so the chip and the order always agree.

While making that change we introduced, and then fixed before release, a worse
version of the same problem: the correction was applied to every mode instead of
only to Partial. A lender who chose "IOC" — immediate-or-cancel, which the
ticket still offers in this mode — would have seen AON highlighted and signed an
AON order, and the rule that an IOC order needs an expiry would have stopped
applying to it. Only Partial is converted now, matching what the posting path
itself does, and the automated desk test drives the IOC case so the same
substitution cannot return unnoticed.

Separately, switching between lending and borrowing, or between posting on-chain
and posting by signature, now clears the risk-and-terms tick immediately rather
than a moment afterwards. Those switches change what is being agreed to, and the
tick has to fall with them. For a signature-only post this matters more than it
looks: there is no second checkpoint after the signature, so the terms on screen
when the box was ticked are the only record of what the user agreed to.

## Connected app — two stale-value hazards in the notification bell and the recovery form (PR #TBD)

The connected app's lint configuration keeps React's hook rules visible as
advisories and promotes each one to a hard error only once the existing code
is clean against it, so the standard is raised deliberately rather than
declared and then ignored. This is the second such group: the rule that
checks an effect or memo actually declares the values it reads.

Four reports, two underlying causes, both the same shape — a value that
could not be declared as the dependency it already was.

The notification bell derived its row list with a fallback to an empty list
on every render. The list the server sends is stable between renders, but
the fallback produced a brand-new empty list each pass, so the unread count
was recomputed and the mark-all-read action rebuilt every time the component
rendered, whether or not anything had changed. The derivation is now
memoised, so both settle when the feed does.

The asset-recovery page resets itself to a blank form in two places: when the
connected wallet or network changes, and when another browser tab writes a
recovery record for the same account. That reset helper was redefined on
every render, which meant the two effects could not name it as a dependency
without re-running the reset on every render — so it went undeclared, and the
effects were, on paper, reading a value they did not admit to. The helper is
now stable (it only clears form fields, so it never needs to change), and
both effects declare it. Behaviour is unchanged: the resets still happen
exactly when identity changes or another tab writes.

Also removed four suppression comments that no longer suppress anything —
their rules are switched off in this configuration, so the comments were
telling future readers a check was being waived when none was running. The
one explaining why a regex deliberately matches control characters keeps its
explanation, as a plain comment.

With the group at zero, the dependency rule is now enforced as an error, so a
future effect that quietly reads an undeclared value fails the build instead
of joining a backlog. Refs were promoted the same way in the previous slice;
purity and set-state-in-effect remain advisory and are tracked in #1520.

No user-visible behaviour changes.

## Connected app — time-based readouts now advance on their own (PR #TBD)

Several parts of the connected app compare against "now": how long ago the
indexer last ingested, whether an offer has expired, whether a risk-tier
cooldown has lapsed. All of them read the clock while the screen was being
drawn, which sounds harmless and is not — it means the value was fixed at
whatever moment React happened to render, and then stayed there. A freshness
note could sit at the same age indefinitely, an offer already past its expiry
could keep occupying a tenor chip and a rung of the rate ladder, and a
cooldown that had in fact elapsed could keep reporting as still counting,
until something unrelated on the page forced a redraw.

These surfaces now read the time through a small shared clock that advances
every thirty seconds, so each of them reaches its own threshold on its own:
the age keeps counting, the expired offer drops out, the cooldown lapses on
screen. Thirty seconds is deliberately coarse — every one of these thresholds
is measured in minutes or longer, so a finer tick would cost redraws without
changing anything a user could see.

The order ticket is the one place that deliberately keeps reading the clock
exactly rather than on the tick. Its preset expiries ("24 hours", "7 days")
are relative to the moment you post, and the ticket already promised to
re-resolve that deadline fresh at submit so a form left open does not post a
stale one. The validation you see while filling the ticket in now follows the
ticking clock, while the deadline actually submitted is still resolved to the
second. As a side effect the preview numbers are steadier than before: each
recalculation used to take its own reading, so a preset expiry differed
slightly every time the preview was rebuilt.

With these cleared, the rule that forbids reading such values mid-render is
enforced as an error, joining the two rules promoted in the previous slices.
One suppression remains, on the submit path described above, and it records
why: the check cannot tell that the code runs from a button press rather than
during drawing, and following the tick there would be the regression.

Behaviour worth watching after release: anything that shows an age or hides an
expired row should now change without being prompted. The tick is real time
passing, which is why it is verified on the deployed site rather than in the
unit suite.

## Frontend correctness — the ref-during-render lint group, judged site by site (PR #TBD)

The alpha02 app lints against the React hooks plugin's newer rules, with
most of them left advisory while the existing code is worked through
deliberately. This clears the smallest of those groups — reading or
writing a ref while rendering — and turns it into a hard error so it
cannot come back.

The group was expected to be the one most likely to contain real
user-visible bugs. It turned out to be almost the opposite: five of the
six sites are deliberate, and converting them to ordinary state would
have introduced defects rather than removed them. Two of them gate whether
a submit button may be used at all when a security warning is showing;
they compare the live warning against the fingerprint the user actually
consented to, and they read it during render precisely because the effect
that clears stale consent does not run until after the screen has been
painted. Moving that comparison into state would delay it by one render —
briefly permitting a signature against a warning nobody agreed to, which
is the exact window the check exists to close. The others are a
notification panel's "new" dots, which are supposed to survive the read
cursor advancing underneath them, and a rate-ladder change highlight,
which by definition needs the previous snapshot. Each now carries a note
explaining why it stays as it is, so the next reader does not helpfully
"fix" it.

The sixth was a genuine problem and is fixed: a component recorded the
connected wallet address into a ref while rendering, for a background
sync channel to read later. A render that React abandons or double-invokes
could leave that ref holding an address the interface never actually
committed to, and the sync channel would then scope its work to the wrong
wallet. The value is now recorded after the render is committed instead,
which cannot be late for this consumer.

Closes #1520 in part — the three larger rule groups (impure work during
render, state set inside effects, and stale effect dependencies) remain
advisory and are the next slices. Their counts had drifted upward since
the issue was filed, so the issue's table was corrected as part of this
work.

## Connected app — a network switch no longer shows the previous chain's listing marker (PR #TBD)

Three hooks track a "pending" record the user created from this device — a
position listed for sale, a posted offset offer, a posted refinance offer.
Each remembers the record's id locally so the app can offer to cancel it, and
each re-read that local memory whenever the wallet switched network or the
loan changed.

That re-read happened *after* the screen had already been drawn, so for one
frame the app displayed the previous chain's remembered id. On a network
switch that meant briefly offering a cancel action against an offer belonging
to a different chain. Clicking in that window would have failed rather than
cancelled the wrong thing, but it was still a control the user should never
have been shown. The re-read now happens while the screen is being computed,
before anything is painted, so the stale frame no longer exists. Seeding the
value once at startup would not have fixed this on its own — it would have
frozen the first chain's id and never noticed the switch, which is exactly
what the after-the-fact re-read was there to catch.

Four related places in the same hooks were reviewed and deliberately left as
they are, each now recording why. Three of them reconcile the device's memory
against what the chain actually reports — the memory is written to storage and
also decides which record the app re-verifies, so making it a purely computed
value would leave the app checking a record it had just disproved. The fourth
is the "your listing ended elsewhere" notice, which has to outlive the
condition that raised it: the moment the notice is shown the app clears the
stale memory, so a computed value would appear and vanish in the same instant
instead of waiting to be dismissed.

This is the first of several passes over this class of finding; the underlying
check stays advisory until the remaining cases are judged.

## The fee figures on the public pages now follow the protocol, not the release

The documentation quotes several governance-tunable figures — the fee on lender
interest, the loan initiation fee, the VPFI discount tiers and their thresholds.
Each is written once and referenced from every sentence and every translation
that mentions it, so there is one place to change rather than seventy.

On the public site that reference had nowhere to resolve to. It fell back to the
value shipped with the build, which meant the figures were only ever as current
as the last deploy: after a governance change the pages would keep stating the
old rate until someone remembered to edit it. That is exactly the drift that had
just been cleaned up across the overview pages and both user guides.

They now resolve against the protocol's published configuration. A change to a
fee reaches the public documentation on its own, in every language, without a
release.

### Without giving the marketing site a wallet or a chain client

The site has no wallet connection and no contract code in it, and that is worth
keeping — it is the surface a stranger loads first, and it should stay light. So
the figures are read from the configuration the platform already publishes for
this purpose, the same source the connected app consults first for the numbers it
displays. One small request, no contract interfaces added to the page.

The trade is honest and worth stating: this follows a governance change within
roughly the time it takes to be observed and published, rather than being read
from the chain at the instant you load the page. For a fee rate on a
documentation page that is the right granularity.

### And the tooltip no longer reports a failure that never happened

Hovering one of these figures used to say the value was a compile-time default
because a chain read was "pending or unavailable" — on pages where no read was
ever attempted. A reader curious enough to hover was told something was broken
about a page working exactly as designed.

The tooltip now says where the number actually came from, and the two cases are
genuinely different: a figure that tracks the published configuration, or the one
shipped with this page when that configuration could not be reached. The second
still happens — during a redeploy, or if a published figure is too old to trust —
and a page always renders either way, because a documentation page that fails to
show a number is worse than one showing a slightly older one.

The machine-readable copies of the docs keep resolving their figures at build
time. A static file has no runtime and cannot follow a change; leaving the
reference unresolved to signal that would just serve a crawler a placeholder
instead of a number.

## Thread — Relative links in published documents now fail the build (PR #1654)

Markdown under the marketing site's content directory is rendered by the
single-page app at a route, so a link written relatively is resolved by
the browser against that route rather than against the repository. A
reference to a neighbouring runbook file therefore asks the site for a
path that has no route and no published asset — and because the site is
configured to serve the app shell for anything it does not recognise, the
reader gets a page with a success status instead of the document they
clicked, and no error anywhere.

That failure is invisible from both sides, which is why this adds a check
rather than only a correction. In the repository the link looks right and
works. On the site it produces a page rather than a missing-page error,
so nobody reports it — a reader who lands on the app shell assumes they
misread the link. A one-off sweep would fix today's instances and none of
tomorrow's.

The constraint worth stating, because it is what rules relative links out
entirely: the same bytes have to work in two places. A contributor
reading the file in the repository needs a link that resolves there; a
reader on the site needs one that resolves over the web. Only an absolute
address satisfies both. The check therefore accepts absolute web
addresses, mail links, in-page anchors and site-absolute routes, and
rejects everything else. Whether a site-absolute route actually exists is
a separate question with a separate failure mode and is tracked
separately.

A sweep of all four published document sets — the admin runbook, the
whitepaper, the user guides and the overview, thirty-two files across ten
languages — found exactly one offender, in the admin runbook, pointing at
the flash-loan liquidator rollout runbook. It now uses an absolute
address. Because that file is a mirror of a canonical copy kept elsewhere
in the repository, the correction was made to the canonical and
re-synced; the check knows about that relationship and, when it finds a
problem in a mirrored file, names the canonical as the place to fix it
rather than sending someone to edit a generated copy.

The check reads the documents with a real markdown parser rather than
matching text, so a link shown inside a code block or inline code — being
displayed, not followed — is not reported, and a reference-style link is
caught at its definition. It also refuses to pass when it finds no
documents at all, so a moved content directory cannot read as a clean
result forever.

Closes #1639.

## The last of the LayerZero residue, and the CCIP variables that were never written down

The cross-chain layer has been Chainlink CCIP only since T-068, and the
contracts themselves are clean — what remains of LayerZero in
`contracts/src` is commentary explaining why a thing is shaped the way it
is, and there is no LayerZero dependency left for anything to import.
The residue was all in the layer around the contracts: the deploy
scripts, the artifacts they stamp, and the file an operator copies before
a deploy.

**The operator config was the serious one.** `.env.example` still shipped
a LayerZero endpoint for six chains, a peer-setter block, and the entire
fixed-rate VPFI buy stack — receiver, adapter, executor options, refund
timeout, and per-chain payment tokens — for scripts that have all been
deleted. Nothing read any of it. Meanwhile it documented **none** of the
CCIP variables the current deploy actually needs, four of which have no
default and abort the run when unset. An operator following the template
would have carefully filled in variables that do nothing and then had
their deploy fail on ones nobody told them about. Both halves are fixed:
the dead blocks are gone, replaced by short notes naming what was removed
so a stale `.env` gets deleted rather than translated, and the CCIP
router, RMN proxy, token-admin registry, registry module owner, lane
chain ids, guardian and rate-limit knobs are now written down with their
defaults.

Two smaller traps came out of the same file. It set `REWARD_VERSION`
twice, and the second one won — since the reward-messenger proxy is
CREATE2-addressed off that value, an operator following the template
would have landed the proxy at a different address than intended. And it
named `BASE_EID` and `REWARD_EXPECTED_SOURCE_EIDS`, which nothing reads,
while omitting `BASE_CHAIN_ID` and `REWARD_EXPECTED_SOURCE_CHAIN_IDS`,
which the reward wiring genuinely requires. Chains are keyed by EVM chain
id now; an endpoint id is not a thing that can be translated.

**A LayerZero endpoint id was still being stamped into every new
deployment.** The artifact writer had an endpoint-id lookup table and
wrote the result to `addresses.json` on each deploy. It was kept as
"inert chain metadata", but nothing read it, and the typed deployment
loader that consumers import already documented the field as removed —
so the code, the data and the documentation disagreed three ways. The
resolver and the stamp are gone, the field is out of the six per-chain
artifacts and the consolidated bundle, and the loader's description now
matches. The genuinely-still-needed LayerZero-era keys are untouched and
explained: the deploy scripts still read `rewardOApp` as a fallback,
because two testnet chains were deployed under that key and their
artifacts are the record of it.

**The environment variable naming the old transport is now the old
name.** `REWARD_MESSENGER_PROXY` is what the reward wiring reads;
`REWARD_OAPP_PROXY` still works as a deprecated fallback, so nobody's
existing `.env` breaks.

Also removed: the event-category linter's allowlist for LayerZero
inherited events, which listed five contracts that no longer exist and
could never have matched anything.

**The guard that was supposed to prevent this has been widened.** A
pre-deploy check already scanned the deploy scripts for LayerZero
residue, and it worked — nothing it looked for got through. It simply
did not look at `.env.example`, which is not a deploy script but is what
an operator copies, and it deliberately tolerated the endpoint id. It now
covers both, plus the endpoint variables, the peer-setter variables and
the buy-receiver id, while still allowing a comment to *name* a retired
variable — a note that says "this is gone, do not carry it forward" has
to be able to say what it is. The widened guard was tested against a
deliberately reintroduced variable before being trusted.

The deploy runbooks were reconciled rather than rewritten. The Base
Sepolia cookbook had no status banner at all and opened by quoting an
endpoint id; it now says plainly that it is a pre-migration document and
points at the two scripts that replace it. The BNB banner already
existed but claimed the current deploy still produces a buy adapter,
which it has not since that surface was removed. The main deployment
runbook's dead reward-proxy section is now marked dead in place, so
someone arriving from the table of contents sees it without having to
scroll back to the banner at the top.

**One thing this sweep was wrong about, and corrected.** An earlier draft
of this note repeated the cutover runbook's warning that the handover
script does not rotate the CCIP stack to the governance timelock, leaving
it a manual multisig step. That warning is out of date and the script
does rotate it — messenger, token pool, rate governor, reward messenger,
mirror token, both remittance receivers and both return endpoints, each
handed to the timelock, with contracts absent on a given chain skipped
and any the signing key does not own reported rather than passed over.
The stale warning has been replaced with what the script actually does.

What remains true is that the handover is **two legs**: the script sends
the transfer, and the timelock must then accept, scheduled and executed
through the governance Safe. The mainnet wrapper's own header said the
Safe should call accept — it cannot, because the timelock is the pending
owner, so that instruction is corrected too.

**Three defects in the first cut of this change, caught in review.** All
three were in the new material rather than the removals, and two of them
would have broken a deploy:

- The CCIP variables were documented under the names the Forge scripts
  read, not the names an operator sets. `deploy-chain.sh` resolves a
  per-slug `CCIP_ROUTER_<SLUG>` and exports the bare name itself — and
  treats a hand-set bare `CCIP_ROUTER` as a hard error precisely because
  that is how one chain's router gets wired into another chain's deploy.
  The template now shows the per-slug form.
- The template pre-filled the canonical Base chain id with the testnet
  value. Mainnet only forces the real value inside its configure phase,
  so the earlier contract-deploy and lane-wiring phases would have used
  whatever was in the environment — and the mirror-chain preflight checks
  only that the value is *set*, not that it is right. A copied template
  would therefore have wired a mainnet mirror to the testnet reward hub.
  It now ships unset so the preflight stops and the operator chooses.
- The environment rename introduced a regression of its own: the deploy
  wrappers clear the old variable name before injecting the address they
  resolved from the artifact, and the new name — which takes priority —
  was not being cleared. A value left in an operator's `.env` would have
  outranked the wrapper and tripped the mismatch check on multi-chain
  runs. Both wrappers now clear and populate the current name.

A second review round found four more, again all in the new material:

- Only the router and RMN entries had been converted to per-slug names;
  the two CCT registry addresses were still documented bare, and the
  wrappers resolve all four the same way. Fixed.
- The template's advice for the reward-messenger override — "populate
  once, reuse everywhere", inherited from the CREATE2 bootstrap — is
  false today. That deploy path is gone: the messenger is created with an
  ordinary deploy, no script reads the version variable that used to salt
  it, and the committed artifacts hold a different address per chain. So
  a single reused value makes the agreement check abort. The variable is
  removed, the override is documented as best left unset, and the two
  deploy wrappers stop telling operators to bump a version that no longer
  does anything.
- The widened guard did not scan the files that can actually recreate the
  endpoint-id stamp — the artifact writer, the deploy script that calls
  it, the committed artifacts, the consumed bundle. Those two patterns
  were therefore decorative: they could never have matched, and the guard
  would have reported success for residue it structurally could not see.
  The scan set now covers them, and that was verified by putting the
  field back into an artifact and watching the gate fail.
- The runbook's "adding a new chain" checklist still told operators to
  edit the deleted endpoint-id resolver — a procedure that cannot be
  completed. It now names the CCIP selector resolver and the per-slug
  infrastructure variables that go with it.

The pattern across both rounds is worth recording: every defect was in
something newly written, not in anything removed. Deleting dead code is
low-risk; describing what replaced it is where the mistakes were.

A third round found seven more, and this is where the loop earned its
keep — two of them were factual claims this change had itself introduced
or repeated. The default list of chains the reward aggregator expects
reports from omitted the canonical chain itself and one live mirror,
which would have dropped Base's own interest out of the global
denominator and made the mirror's reports arrive from an unknown source.
The template's per-chain infrastructure stanzas stopped after four of the
six supported testnets. The runbook still asserted a version variable
must match across chains, three paragraphs from the note explaining that
nothing reads it. The spell's header still pointed at a deploy phase no
wrapper dispatches. And the comment exemption added in the previous round
recognised only shell comments, while the scan set had just grown to
include Solidity files — so a migration note reading `// lzEid was
removed` would have failed every preflight, and the obvious fix under
time pressure is to delete the note rather than the residue. The
exemption is now per-language, verified against four cases: a Solidity
comment naming the field passes, Solidity code declaring it fails, an
artifact key fails, a shell comment passes.

A fourth round found two, both about completeness rather than
correctness. The per-chain infrastructure stanzas covered the testnets
but not a single mainnet slug, so the template was unusable for the
deploy it matters most for; all six mainnet slugs now have their four
addresses. And retiring the LayerZero event category from the linter
broke a documented invariant: that taxonomy is a closed list maintained
in two places, and the specification still declared the retired category
valid and counted fifteen leaves. Both sides now agree on fourteen, and
the rule is restated to cover retiring a leaf, not only adding one — the
direction that was left implicit is exactly the one that went wrong.

A note for whoever picks up the event taxonomy next: the linter reports
229 violations against that closed list, none of them related to this
change. They are years of newer categories — reward-governor,
reward-compensation, buyback-intent and a dozen more — that were used in
the contracts without being added to either the specification or the
allow-list. That is a real reconciliation and is not attempted here.
