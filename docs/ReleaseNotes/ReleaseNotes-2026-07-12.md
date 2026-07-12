# Release Notes — 2026-07-12

This release folds a week of work, led by the **spec-vs-code conformance
hardening** (umbrella #998) from the 2026-07-05 review: the offset preclose is
redesigned to settle only at completion (#1001), the NFT-rental late fee now
scales with the overdue rent (#1004), sanctioned-locked proceeds release
fail-closed (#1006), the interaction-reward daily cap is enforced per day
(#1008) and every loan terminal now closes reward accounting durably and
re-anchors it to the live position-NFT holder (#1067), offer collateral/lending
bounds are re-checked on modification (#900), sanctions freezes are enforced
centrally across every payout channel (#998 S10), forced-close/liquidation
accounting is hardened (#998 Tranche 4), and the dashboards now show
fallback-pending (still-curable) loans (#940). Alongside it: the new **Rate
Desk** trading-terminal (phases 1–3, ending in gasless signed orders), a batch
of **alpha02** UX/trust fixes (RPC diet, ENS endpoints, plain-language contract
errors, faucet + asset-picker polish), and infra work (defi test-suite repair,
an indexer ingest-stall fix, the RiskPreview facet split, deploy-preflight
checks, and an error-selector drift guard).

## Offset preclose (Option 3) redesigned to settle at completion, not at posting (#1001 / #998 S3)

The "offset with a new offer" preclose — where a borrower exits their loan by
posting a lender offer that a new borrower takes — used to pay the outgoing
lender their full amount (principal, accrued interest and any shortfall) the
moment the offer was *posted*, and then leave that money parked while the offer
waited to be matched. That parked payment was the root of a whole family of
problems: cancelling the offer stranded it (the lender could later be paid
twice), and any other action on the loan while the offer sat — the lender
selling their position, the loan being repaid or liquidated, the obligation
being transferred, or the offer's own terms being edited — could misdirect or
double-count it.

The flow has been redesigned around a single principle: **nothing about the
original loan's settlement changes until the offset actually completes.** A
posted offset is now just a pending intent. Posting moves no settlement money at
all — the outgoing lender is paid their full due only at the instant a
counterparty accepts, computed from the loan's live terms at that moment (so the
accrued interest covers the whole time the loan actually ran, and the shortfall
reflects the replacement offer's current rate), and deposited to whoever holds
the lender position at that time.

Consequences of the redesign:

- **Cancelling is trivially loss-free.** With nothing parked, cancel just
  releases the borrower's position lock and refunds the borrower's own new-offer
  capital. There is no reservation to unwind and the outgoing lender was never
  pre-paid, so a later close-out of the loan pays them exactly once.
- **The double-pay and the interleaving hazards are gone by construction.**
  Because the loan's lender-side state is untouched until completion, a lender
  sale, a repay/default/liquidation, or an obligation transfer that happens while
  an offset is posted can no longer corrupt a half-settled payoff.
- **Term edits can't shortchange the lender.** The payoff is computed from live
  terms at completion, so lowering the replacement rate after posting simply
  raises the shortfall the borrower owes — the outgoing lender is always made
  whole.
- **The outgoing lender is now paid for the full elapsed time.** Previously the
  accrued interest was frozen at posting time even though the loan kept running
  until completion; it is now measured at completion.

To keep the pending offset from racing a concurrent change to the same loan,
three actions are refused while an offset is live (until it completes or is
cancelled — it is short-lived): listing the lender position for sale,
transferring the borrower obligation, and editing the linked offset offer (the
offer is immutable once linked, its terms pinned to the loan it offsets). A loan
may still hold only one live offset offer at a time.

One trade-off is intentional: the borrower must hold the payoff funds (and
standing approval) at *acceptance* time rather than at posting. If they don't,
the acceptance simply reverts and the original loan is left untouched — never
partially settled.

Closes #1001 under the #998 spec-conformance umbrella.

## NFT-rental late fee now scales with the overdue rent (PR #<n>)

The late fee on an overdue NFT rental used to be computed on a single day's
rental fee, so a renter forty days late on a large rental paid the same penalty
as one a single day late on the same rental — the fee never scaled with the size
of the obligation, contradicting the specification (which has always described
the rental late fee as a percentage of the *overdue rental amount*). This fixes
the code to match: the rental late fee is now based on the rent still owed on the
remaining term (the per-day fee times the remaining rental days), so the penalty
tracks the actual debt. The corresponding repayment-preview quote was updated in
lockstep, so a late-rental repayment preview matches what settlement charges.
ERC-20 loans are unaffected — their late fee was already correct.

The fee is now paid out of the borrower's pre-paid rental *buffer* (the small
safety margin collected up front alongside the rental prepayment) rather than out
of the rental prepayment itself. Without this, a fully-overdue full-term rental —
whose entire prepayment is consumed by the rent owed — could not complete a late
repayment at all, because any positive late fee would exceed the remaining
prepayment. Drawing the fee from the buffer, which exists for exactly this
purpose, lets the repayment always settle; any unused buffer is refunded to the
borrower. The late-fee cap is clamped to the loan's OWN pre-funded buffer amount
(the value snapshotted when the rental was originated), not the live global
buffer setting — so even if governance changes the rental-buffer percentage
between a loan's origination and its repayment, the fee can never exceed what
that specific loan actually pre-funded, and the late close-out cannot brick.

This is one of three deferred #998 spec-conformance findings; its approach was
ratified in the Tranche-5 deferred-trio design doc after three rounds of review.

Closes #1004.

## Sanctioned-locked proceeds now release fail-closed (PR #<n>)

When a loan closes out — a repayment, a default, a health-factor or discounted
liquidation, an internal match, a swap-to-repay, a preclose, an early-withdrawal
sale, or a fallback distribution — and the party the payout is owed to is on the
sanctions oracle, the protocol does not revert the close-out (that would trap the
honest counterparty). Instead it parks the flagged party's share in their own
vault, frozen behind the claim gate, and lets the close-out complete. Until now
that claim-time freeze relied on the ordinary sanctions screen, which is
deliberately *fail-open*: if the sanctions oracle is unreachable, the screen lets
the caller through so an infrastructure blip can never brick honest activity.

That left a narrow but real hole: while the oracle was down, a party who had been
confirmed sanctioned at close-out could withdraw their frozen proceeds anyway,
because the fail-open screen waved them through. A related laundering path existed
too — transfer the frozen position to a fresh, clean wallet during the outage and
have that wallet claim.

This change closes both. At close-out, whenever the intended recipient (the
current holder of the position, resolved live) is affirmatively flagged, the
protocol records *that specific address* as the frozen claimant for that loan
side. At claim time, if a side carries such a marker, the release must pass a
second, *fail-closed* screen on the recorded address: an unreachable or unset
oracle now blocks the release instead of allowing it, and the recorded party
must be proven de-listed before the funds move — regardless of who holds the
position now, which defeats the transfer-and-launder route. Ordinary claims,
which were never frozen, carry no marker and keep the fail-open behaviour, so a
genuine oracle blip still can't freeze an honest claimant. The marker is set only
on an affirmative flag, so a close-out that happens *during* an outage (when the
flag can't be confirmed) records nothing and stays fail-open — we never freeze a
party we never confirmed as sanctioned. Once a marked release passes cleanly, the
marker is cleared so a later re-lock stays possible.

Two further gaps are closed here. First, the **refinance** close-out is now fully
covered: refinancing a loan whose lender position is held by a flagged wallet used
to *revert* — the old lender's proceeds could not be deposited into a flagged
vault, which bricked the honest borrower's refinance entirely. It now parks those
proceeds the same way every other close-out does (frozen behind the claim gate)
and records the fail-closed marker, so the refinance always completes. Second, the
same authoritative flag that freezes a closing holder now also enrols them in the
confirmed-flagged registry that backs the fail-closed *position-movement* gate — so
a party frozen at close-out cannot later shuffle a still-open position to a clean
wallet during an outage. Together these mean the freeze can rely on a single
recorded address per loan side, with no chain of intermediary holders to track.

Because the platform now keeps a registry of wallets confirmed flagged while the
oracle was reachable, the freeze decision itself is hardened against outages: a
close-out that lands *while the oracle is down* still freezes a party who was
**previously confirmed** — the marker is stamped, and where a close-out would
otherwise pay a surplus straight to that holder it is parked instead. Only a
wallet that was *never* confirmed stays fail-open during an outage, so an oracle
blip can never freeze an honest, never-flagged claimant.

A final class of payouts is now covered: the **mid-loan servicing payments** that
go to the lender *immediately* rather than through a later claim — the daily
NFT-rental fee, the periodic-interest auto-liquidation proceeds, and the ERC-20
partial-repayment principal-plus-interest. These historically used the same
fail-open screen, so a lender-position holder confirmed flagged at close-out could
still be paid their servicing share during an oracle outage — and because the
money left immediately, the fail-closed claim gate could never recover it. Each of
these paths now makes the pay-or-freeze decision with the same outage-hardened,
registry-aware logic: a clean or never-confirmed holder is paid inline exactly as
before, but a frozen holder's share is diverted into the loan's stored lender
vault, credited to that loan's lender accumulator (so the eventual claim folds it
in), reserved against the stored lender's other spend paths, and marked
fail-closed — the flagged holder's own wallet receives nothing, and the funds only
release once that holder is proven de-listed. Discretionary, holder-initiated
actions (such as early-withdrawal options) keep the hard-block behaviour; only the
must-complete Tier-2 servicing payouts are parked.

The freeze survives an oracle outage; a de-listing (oracle back up, address
cleared) releases the funds. No behaviour changes for any unflagged party.

Closes #1006.

## Interaction rewards: the daily cap is now enforced per day, not per loan window (#1008)

The platform gives out a small VPFI interaction reward for participating in a
loan, and that reward has always been meant to carry a **daily** ceiling — a
cap of 0.5 VPFI for every 0.001 ETH of eligible interest, on each side, each
day. That ceiling is the main defence against "wash-farming" the reward pool.

Until now the code applied the ceiling **once across a loan's whole reward
window** rather than day by day. The practical effect was a loophole: a day
where a participant's share of the pool spiked far above the ceiling could be
quietly netted against other days that sat below it, so the spike leaked
through instead of being trimmed. The reward paid could exceed the sum of the
individual daily caps.

This change closes that loophole. The cap is now applied **per day**: each
day's reward is trimmed to the ceiling on its own, and only the trimmed amounts
are added up. A quiet day's unused headroom can no longer absorb a high-share
day. For anyone who was always under the ceiling, nothing changes; only a
genuine over-cap day is now trimmed, exactly as the rule always intended.

**How the daily ceiling is priced.** The ceiling depends on the ETH price and
the governance cap setting. Those are now read **once, when a day is finalised**
(rather than at the moment someone claims), and the same finalised value is
shared across every chain so the cap is identical everywhere. A consequence
worth stating plainly: a change to the cap setting applies to days that have not
been finalised yet — it does not retroactively re-price days that are already
finalised. If the reward system's price feed is briefly unavailable when a day
is finalised, that single day is left uncapped rather than blocking
finalisation; the outage cannot spill onto other days.

**Cross-chain funding stays exact.** The amount of VPFI shipped to each mirror
chain to fund its claims is trimmed by the very same daily ceiling, rounded up
just enough that a mirror can never end up short of what its users are owed —
so the cap no longer leaves unspendable VPFI stranded on a mirror.

There is no change to how or when a user claims, and no reward already earned
is reduced beyond the trimming the daily rule always intended. The platform is
pre-live, so there is no historical reward balance to migrate.

Part of #998. Implements `docs/DesignsAndPlans/S13InteractionRewardCloseoutAndDailyCap.md`
Part 1. Closes #1008.

## Interaction rewards: durable, holder-accurate close-out at every terminal (#1067)

The platform gives out a small VPFI interaction reward for participating in a
loan. Each loan carries two reward "entries" — one for the lender side, one for
the borrower side — that accrue while the loan is open and are settled when the
loan ends. This change makes that settlement correct at **every** way a loan can
end, and makes the reward follow the **person who actually holds the position**.

**The reward now follows the live position holder.** Lender and borrower
positions are transferable NFTs — a position can be sold or moved before the
loan closes. Previously, when a loan closed, its reward entry could still be
anchored to whoever originally opened the position, even if they had since sold
it. Now, at the moment a loan reaches any terminal, each still-open reward
entry is re-pointed to the current NFT holder before it is closed — so the
reward is settled to the same party the loan's funds are settled to. This
re-anchoring is centralised in one place that every close path flows through
(normal repayment, default, liquidation, preclose, prepay-sale), so no single
path can forget it. An entry that was already closed earlier (a "frozen" slice
that a prior holder already earned) is never moved to a later holder.

**Every terminal now closes the reward durably.** Several ways of ending a loan
were not closing the reward accounting at the terminal itself, leaving it to be
inferred later from the loan's status. That inference could be dropped by a
subsequent status change and quietly pay a borrower who should have forfeited.
The reward is now closed **at the terminal**, durably, for:

- **Liquidation via internal match** — the borrower forfeits their reward
  durably; the lender keeps theirs.
- **Prepay-sale finalisation** (both the loan-keyed and offer-keyed parallel
  sale) — a proper close; neither side forfeits.
- **Full repayment by daily NFT-rental deduction** — a proper close.
- **The claim-time fallback→default force** — when a distressed loan that had
  been held in a curable "fallback pending" state is finally forced to default
  at claim time, that terminal now forfeits the borrower reward (and any
  up-front borrower fee) exactly as the other default paths do. Because
  "fallback pending" is reversible, neither was settled on the way in; both are
  now settled here, where the loan truly ends.

**Behaviour a participant can observe:** a lender who buys a loan position and
then sees it repaid or defaulted now receives (or forfeits) the reward on the
same basis as if they had held it from the start; a borrower whose position is
liquidated no longer keeps an interaction reward the rules meant to forfeit.
There is no change to how or when a user claims. The platform is pre-live, so
there is no historical reward state to migrate.

Internally, the per-holder membership lookup used by re-anchoring is now O(1),
so centralising the re-anchor onto the fund-critical close path adds no
per-close scan. On the two facets that sit at the contract-size limit
(ClaimFacet, RiskMatchLiquidationFacet) the reward close is fired as a
best-effort internal hook — reward bookkeeping never blocks a fund-moving
close, matching the existing pattern.

Part of #998. Implements `docs/DesignsAndPlans/S13InteractionRewardCloseoutAndDailyCap.md`
Part 2. Closes #1067.

## Thread — defi unit-test suite repaired + non-blocking CI lane (PR #1088)

The `apps/defi` Vitest suite had silently rotted to 256 failures across 38
files because no CI job ever ran it — module-resolution and API drift piled
up unnoticed after the app migrated from ethers to viem, shared libraries
moved to `@vaipakam/lib`, and the marketing pages moved to `apps/www`. This
change repairs the whole suite (now 531 passing / 6 skipped / 0 failing
across 56 files) and adds a CI lane so it can't rot invisibly again.

The bulk of the work was structural and shared-cause: the test harness now
mirrors the app's real provider tree (so page hooks that resolve the read
chain no longer throw), i18n is initialised in tests (so assertions on
user-visible copy match real English instead of raw keys), every dead
`ethers` mock was removed — the per-file `vi.mock('ethers', …)` stubs and the
shared `test/ethersMock.ts` helper are all gone, so the suite no longer masks
a reintroduced ethers dependency — and the read paths were rewritten against
the viem model (`readContract` / `getLogs` / `getContractEvents` / multicall),
moved-module imports were re-pointed, and assertion drift was triaged
case-by-case to distinguish deliberate app evolution (renamed fields, reworked
copy, new consent gates, wallet-gated pages) from genuine regressions. The
Vitest config now also discovers source-colocated `src/**/*.test.*` files, not
just the central `test/` suite, so a colocated test can't silently sit outside
the run.

Two genuine app bugs surfaced during that triage and were deliberately left
visible rather than papered over — their covering tests are skipped with a
`REGRESSION` marker and filed as follow-ups: a connected user's chain-switch
error banner is wiped instantly by an over-eager "clear errors once
connected" effect (#1090), and a lender can never reach the Early-Withdrawal
control on their own loan because it is nested inside a borrower-only
"repay" card gate (#1091).

The new `defi-vitest.yml` lane runs the suite on every PR touching
`apps/defi` or the shared packages it consumes and reports pass/fail counts,
but is intentionally **non-blocking** (drift-warn only) for now — it warns in
the Actions summary without gating merges. Now that the suite is fully green
it can be promoted to a blocking required check in a follow-up. No app or
runtime code changed here — this is tests + CI only. Closes #1076.

## Thread — two defi UI regressions fixed: chain-switch error banner + lender early-withdrawal reachability (PR follows)

Two genuine bugs that were surfaced (and deliberately left visible) during the
#1076 test-suite repair are now fixed, and their covering tests un-skipped.

**Connected-user error banner (#1090).** When a connected wallet's chain
switch failed or was rejected, the red error banner never appeared — the
"clear transient errors once connected" effect in the wallet context was keyed
on both the connection status and the error itself, so it wiped *any* error the
moment one was set while already connected. Since only a connected wallet can
trigger a chain switch, the "Chain switch rejected or failed." message was
erased on the very next render before it could be shown. The effect now fires
only on the disconnected→connected transition (tracked via the previous
status), so it still clears a stale pre-connection error once you connect, but
an error raised *while* connected — a rejected chain switch, an RPC failure —
now stays on screen.

**Lender early-withdrawal reachability (#1091).** A lender viewing their own
active loan could never reach the Early-Withdrawal control. The entire loan
actions card was gated on the "repay" availability flag, which is false for the
lender (repaying your own loan is disallowed), yet the lender-only
Early-Withdrawal action — and the public Trigger-Default action, which a lender
can also invoke once a loan is overdue — were nested inside that repay-gated
card. The card now renders whenever *any* of its actions is available, while
the repay-specific section stays gated on the repay flag so it remains hidden
from the lender (who cannot repay their own loan). Lenders can now reach their
early-exit control, and either party can reach Trigger-Default on an overdue
loan.

Both are app-behaviour fixes in `apps/defi`; no contract changes. Closes #1090
and #1091.

## Risk-access preview cluster split into its own facet + intent-preview floor parity (PR #<n>)

The self-sovereign risk-access surface was carried by a single internal
facet that had grown to the very edge of the protocol's per-facet code-size
limit, leaving no room for future work on that surface. This change splits it
into two: the original facet keeps the state-writing controls (a vault opting
its own risk tier up or down, granting per-pair consent, the governance terms
levers) and the plain state read-outs, while a new sibling facet takes over the
read-only "preview" surface — the dry-run checks the app and keeper bots call to
learn, without spending gas, whether an offer accept, a keeper match, or an
auto-lend intent fill would be allowed, plus the two internal gate assertions
the match and obligation-transfer paths already delegated to it. The behaviour
of every one of these entry points is unchanged; only their home moves. Callers
reach them through the same single protocol address as before, so no integration
sees a difference. The split frees a large amount of head-room on both facets so
future risk-access work has somewhere to land.

Riding along on the freed head-room, this also closes a small divergence between
the auto-lend intent **preview** and the live fill it predicts. For a collateral
that can never back a new loan at origination — an asset configured to admit no
borrow, or one demoted to the no-borrow tier under depth-tiered risk — the live
fill is rejected up front with a clear "collateral below the required floor"
reason. The preview, however, was only doing a lighter floor check that such a
collateral could slip past, so it would report a different, later reason than the
one the fill actually raised. The preview now applies the same no-borrow guard the
live path does, so a solver or the app sees exactly the outcome the fill would
produce. This was deferred earlier only because the extra check did not fit under
the code-size limit; the split is what makes it affordable.

Also repaired in the same change: two test suites that exercise adjacent surfaces
were using collateral thinner than the offer-admission floor introduced by the
earlier floor/ceiling work, so they had started failing; their collateral is now
set above the floor (they test plumbing, not the bound). A larger signed-offer
matcher suite with the same root cause is tracked as a separate follow-up.

Closes #1104.

## Confirmed-flagged wallets can't move a position during an oracle outage (PR #<n>)

The platform screens sanctioned wallets against an on-chain oracle. That screen
is deliberately *fail-open*: when the oracle is unreachable it lets activity
through, so a vendor outage never freezes the whole platform. But for the narrow
act of **moving a loan-position token** (a plain transfer, or selling/transferring
a position through the sale and obligation-transfer flows), fail-open left a hole:
a wallet that had been confirmed sanctioned could move its position during an
oracle outage, which is the manoeuvre a determined actor would use to shuffle a
frozen position through intermediaries and eventually cash it out from a clean
wallet.

This change adds a small on-chain registry of wallets that were **confirmed
flagged while the oracle was reachable**, and has the position-movement checks
consult it **fail-closed**: a registered wallet cannot move a position even while
the oracle is down. The registry is filled automatically whenever the protocol
observes a flagged holder on a normal (non-reverting) path — when a flagged
wallet is caught trying to sell a position (the buyer is registered), and when a
disowned vault's stuck-token recovery reveals a flagged source — and can also be
synced by anyone through a new permissionless `refreshSanctionsFlag` call, which
both registers a freshly-listed wallet and **clears** a wallet the oracle now
reports clean (a de-listing lifts the restriction). All registry updates come
only from an authoritative, reachable-oracle read, so an outage can never wrongly
clear a still-flagged wallet, and an authoritative-clean move self-heals a stale
entry. (Registering the flagged *holder* of a closing position is owned by the
sanctioned-proceeds fail-closed release, #1006, which records the same holder at
close-out; the operator refresh is the backstop until that lands.)

Behaviour is unchanged for everyone else: when no oracle is configured the
registry is ignored entirely, and a wallet never previously observed as flagged
is not blocked during an outage. A flagged buyer is treated by *how* they are
acquiring the position: on the **direct buy-offer sale** — a value-receiving
acquisition — the transaction now reverts cleanly, blocking a flagged wallet from
buying in; on the **accepted-sale completion** path a sale still **completes** with
the flagged buyer's proceeds frozen (the existing "frozen, not seized" treatment),
and the flagged buyer is registered. On both paths a flagged *seller* offloading a
position is blocked. A de-listed wallet regains full movement.

This is the foundation that lets the sanctioned-proceeds fail-closed release
(#1006) rely on a single recorded frozen claimant per loan side: because a flagged
holder can no longer hand the position off mid-outage, no chain of distinct
flagged holders can form.

The full user-initiated movement surface is covered — plain transfers, the two
lender-sale vehicles, and the borrower-side obligation transfer. (A separate,
pre-existing size-limit item on the preclose facet — the direct-preclose lender
payoff to a flagged stored lender — remains tracked in #1124; it is unrelated to
position movement.)

Closes #1123.

## Thread — Rate Desk phase 1: the trading-terminal page (PR TBD)

The alpha02 connected app gains its first pro surface: the **Rate Desk** at
`/desk`, an Advanced-mode page that presents one lending market — a lending
asset / collateral asset pair at a chosen duration — the way a trading
terminal presents an order book. Lender offers appear as asks (each lender's
minimum rate), borrower requests as bids (each borrower's maximum rate),
aggregated into a rate ladder with remaining sizes and cumulative depth,
with the quoted mid and spread in the header. An order ticket beside the
ladder posts limit-rate offers without leaving the page, with the
good-till-cancel / good-till-time expiry presets and the Partial / AON / IOC
fill modes the contracts already supported but no UI exposed. Tapping a
ladder row pre-fills the ticket; hitting the top of the book deep-links into
the existing guided accept flow. A tape panel shows the market's recent
executed fills (secondary-sale bookkeeping loans are excluded — a loan-sale
is not a fresh rate print), and bottom tabs show the wallet's open orders
and live positions with health-factor badges.

The open-orders tab ships the **first amend-in-place UI**: an unaccepted
offer's creator can change its rate, size, or collateral in a single
transaction (the contracts' offer-modification surface from issue #193,
until now reachable only by cancelling and re-creating). Amends that grow
the escrowed amount surface an approval precheck first, since that path has
no signature-approval variant. Held-but-not-created offer positions render
read-only, matching what the contracts authorize.

The indexer gains the small read surface the desk needs: a market-discovery
endpoint listing every pair-and-duration market with live offers (the
desk's pair chips derive from it), market filters on the recent-loans and
active-offers feeds so a market's tape and book fallback never depend on a
capped global page, and sale-vehicle markers recorded at ingest. Markets are
deliberately ERC-20-on-both-legs only — NFT and rental offers stay on the
Offers page, since token identity cannot be merged into a fungible ladder.

Design source: `docs/DesignsAndPlans/ProRateTerminalDesign.md` (ratified,
PR #1128). Closes #1129. Follow-ups: phase 2 (executed-rate chart + History
tab, #1130) and phase 3 (push-invalidation keys, crossable-band preview,
signed-offer book, #1131); the desk's live-review driver lands with the
post-deploy review per the DoD.

## Thread — Rate Desk phase 2: executed-rate chart + History tab (PR TBD)

The Rate Desk gains its **executed-rate chart**: for the selected market,
the desk now draws the rates at which loans actually initiated, bucketed
over a chosen interval (hourly, four-hourly, or daily) and range (a week
to all history). The chart is governed by the design's thin-market
honesty rules, stated here in user terms: it draws only where fills
actually happened — a quiet week renders as a visible gap, never an
interpolated line; when the visible range holds only a handful of fills
(fewer than ten) the chart drops candle shapes entirely and presents the
individual prints as a stepped line with per-fill markers, saying so in
a note, because candlesticks built from two or three trades would be
theatre; hovering a bucket always discloses how many fills and how much
principal it aggregates, never bare open/high/low/close; the order
book's current quoted mid can be overlaid but is drawn dashed and
labelled "quoted mid" — a resting quote, visually never blended with
executed rates; and there is no daily percent-change ticker — the header
shows the last executed fill's rate and age instead, since a %-change
over two trades is noise sold as signal. A market with no fills says so
plainly rather than showing a fake series. On phones the chart (and
tape) sit behind a Book|Chart toggle so the ladder-and-ticket loop stays
the primary view.

The desk also gains a **History bottom tab**: every loan the connected
wallet ever participated in — any market, any status, newest first, with
role badges (lender / borrower) and links to each loan's detail page.
This closes a real gap: the existing position views key on who currently
holds a position, so a lender whose loan was repaid and claimed — or
whose position token moved to a new owner — simply vanished from every
current-holdings read. History is permanent by design: repaid, defaulted
and closed loans stay listed with their final status.

Server-side, the indexer gains the two reads behind those panels: a
per-market executed-rate candle endpoint (only buckets that contain
fills; principal totals kept precise as decimal strings; secondary-sale
bookkeeping rows excluded — a loan-sale is not a fresh rate print) and a
historical-participant endpoint backed by persisted participation rows
recorded when a loan starts and appended whenever a position token
changes hands, so participation is append-only history rather than a
mutable pointer.

The fork-tier e2e suite covers the new surfaces: the indexer stub now
answers both endpoints live from the fork's own chain state, and a new
scenario spec proves the honest-empty chart, the sparse-tape mode with
its fill-count note and last-fill header, the quoted-mid labelling, and
History's all-status persistence (a repaid loan stays listed with its
badge flipped). The chart's decision math was already unit-tested; the
spec pins the user-visible honesty surfaces.

Closes #1130. Follow-ups: phase 3 (push-invalidation keys, crossable-band
preview, signed-offer book, #1131); the desk's live driver — post, amend,
cancel, plus a chart and History pass against the deployed site and real
indexer — runs with the post-deploy live review per the DoD.

## Thread — Rate Desk phase 3: live updates, crossable band, gasless signed orders (PR #1131)

The Rate Desk gained its phase-3 liveness and crossing surfaces
(Closes #1131). The desk now updates live: the indexer's realtime push
channel carries the desk's query roots, so when anyone else's action
lands on the book — a new offer, an amend, a fill — the ladder, markets
list, tape, chart and history refresh within seconds of ingest instead
of waiting out the 30-second poll, and a rate level whose depth changed
plays a brief highlight flash so the change is visible rather than
silent. The poll keeps running underneath as the backstop; a deployment
without the push channel behaves exactly as before.

When the book is crossed AND the protocol itself confirms the
top-of-book pair can actually settle, the ladder's mid row shows a
"matchable" band naming the midpoint rate and amount, with an Execute
button anyone can press — execution is permissionless and the caller
earns the protocol's matcher fee share. The honesty rule is strict in
both directions: a crossed book whose offers cannot actually match (for
example, amount ranges that never overlap) shows no band at all, and
the band is also hidden whenever the governance kill switch for
matching is off or its state is unknown.

Posting from the order ticket gained a gasless mode: instead of sending
a transaction, the maker signs the order once and the signature is
published to the indexer's new signed-offer book — posting is free, and
nothing is escrowed until someone fills it. Gasless lend orders always
post as a single whole fill (all-or-nothing): a signed lend order
carries one fixed collateral requirement, so it cannot honestly be
sliced into partial fills — the ticket disables the Partial choice in
that mode and says why, rather than publishing signed depth that
partial fills could never actually consume (gasless borrow orders are
unaffected; they already post as a single fixed size). Signed orders merge into
the ladder alongside on-chain offers wearing a "Signed" badge, and any
taker can fill one in a single transaction (the taker pays that
transaction; the maker's side moves from their vault's free balance at
that moment — the ticket warns, without blocking, if the vault doesn't
currently cover the commitment). The maker's own signed orders for the
selected market are listed under Open orders, where revoking one is an
on-chain cancel — the one signed-order action that costs gas, because
an off-chain delete would merely hide a signature that anyone who saved
it could still fill.

The indexer worker backs this with the signed-offer book itself: a
public post endpoint that verifies each order's signature locally
before accepting it (spam can't reach the chain-read budget), rejects
orders the chain already knows as consumed, stores the exact replay
payload, and a market-scoped read endpoint takers consume; lifecycle
handlers retire rows as fills, cancels and nonce burns are indexed. The
fork-tier e2e harness mirrors both routes (with signature verification
against the real Diamond domain) and a new Playwright spec drives the
whole loop — post gasless with zero transactions, discover on the
ladder, fill on-chain, watch the row leave the book — plus both sides
of the crossable-band honesty rule. Follow-ups: a live gasless
post-and-cancel pass and a push-invalidation observation ride the
rate-desk live driver on its next post-deploy run.

## Thread — S10 sanctions freeze is now enforced centrally, not path-by-path (PR #<n>)

The fail-closed release of sanctioned proceeds (S10, shipped in #1006) worked
by a convention every close-out had to remember: whenever a loan terminates and
leaves a party a *deferred* payout — a repayment refund, a liquidation surplus,
an internal-match residual, a fallback distribution — that close-out had to
stamp a "frozen-claimant" marker on the current position holder so a sanctioned
holder can't quietly withdraw during an oracle outage. Because it was a
convention, it was whack-a-mole: the #1006 review kept finding the *same*
missing-marker bug on a *different* close-out path in nearly every round. This
change makes the rule structural instead of remembered.

Every loan now runs its terminal status change (to Repaid, Defaulted,
InternalMatched, or into the fallback-pending state) through a single internal
**lifecycle host** that performs the validated transition *and* records the
fail-closed marker for both the lender and the borrower position holder in one
place. The dozen close-out paths that previously each stamped their own markers
now route through that host, so the marker can no longer be forgotten by a new
path — adding a terminal transition automatically gets the freeze. Observable
behaviour is unchanged for everyone: a clean holder is never frozen, a
genuinely-flagged holder is frozen exactly as before, and the transition rules
themselves are identical. (The host resolves the *current* holder the same way
the old per-site code did, so a transferred position still freezes the right
wallet.)

To guarantee the rule can never silently regress, a new pre-deploy /
continuous-integration guardrail scans the contract source and fails the build
if any close-out writes a deferred claim (or a mid-loan held-for-lender credit)
without a matching frozen-claimant register beside it. The guardrail carries a
small, reasoned allow-list for the genuine exceptions (a helper whose caller
does the register, or a bookkeeping row that carries no real payout). While
wiring the guardrail up it surfaced one pre-existing gap — the borrower
obligation-transfer top-up funded the lender through a non-locking deposit with
no marker, which could both brick the transfer for a flagged lender and leave
the credit releasable fail-open — and that gap is closed here as well.

This lands the deferred-claim half of the central-enforcement design
(Invariant A). The remaining half — the same structural treatment for *inline*
holder payouts and the collateral-sale settlement path (Invariant B) — is
tracked as a follow-up. Relates to #998; implements
`docs/DesignsAndPlans/S10CentralEnforcement.md`. Closes #<n>.

## Thread — S10 sanctions freeze now covers the inline-payout & collateral-sale channels (PR #<n>)

The S10 central-enforcement work (#1132) made the sanctions freeze **structural**
for one class of close-out: *deferred* payouts, where value sits waiting in a
claim record until the holder withdraws it. This change completes the picture by
covering the two remaining channels — the *inline* holder payouts and the
prepay-collateral-sale settlement — that pay a position holder immediately rather
than parking a claim for later. Together with #1132 this closes the S10 design's
"Invariant B."

**A build-time guardrail for inline payouts.** The register-coverage guardrail
that #1132 added (it fails the build if a close-out writes a deferred claim
without recording the fail-closed marker beside it) now has a second scan. This
one walks every production contract and flags any function that looks up the
current holder of a position and then pays that exact holder directly, unless the
payment goes through the sanctions-aware "pay-or-freeze" helpers or carries an
explicit freeze guard. Crucially the scan follows the payment even when the
"who is the holder" lookup and the actual transfer live in *different* functions
(a resolve-here, pay-there split), which is exactly the pattern a naive text
search would miss. A small, reasoned allow-list carries the three deliberate
exceptions — the discretionary partial-swap path (which hard-screens its payee),
the borrower's own-collateral return on an obligation transfer, and the
parallel-sale settlement (covered by the sync mechanism below). Any *new* path
that forgets the treatment now fails the build.

**A committed sanctions sync for collateral-sale listings.** The
prepay-collateral sale settles inside a marketplace order that pays the current
position holders directly, the instant before the loan flips to settled. Because
that settlement is atomic, a screen that merely *reverts* on a flagged recipient
would roll its own record back with the revert — so a first attempt during a
sanctions-oracle outage could block while leaving no trace, and a later attempt
could pay fail-open. This change adds two permissionless, non-reverting sync
entry points — one keyed by loan, one keyed by the sale offer (the pre-loan sale
surface has no loan to key on) — that anyone (a keeper, the counterparty) can
call. Each reads the live recipients the order pays, records any confirmed-flagged
recipient in the fail-closed registry, and cancels the listing so it can no longer
fill. The record persists because it is committed by this separate call, not
inside the atomic fill.

**A fail-closed backstop at the fill.** As defense in depth, the marketplace
fill screen and the parallel-sale settlement now consult the committed registry
in addition to the live oracle read. So even during an oracle outage, a recipient
the registry already knows to be flagged is barred from being paid — while an
honest, unflagged holder still settles normally through a brief oracle blip
(the check does not hard-fail on outage, only on a known-flagged recipient).

Observable behaviour is unchanged for everyone clean: a clean holder is never
barred and a clean listing is never cancelled (the sync self-heals a stale
marker on a clean read). Only a genuinely sanctioned recipient is frozen out.
Relates to #998, #1132; implements `docs/DesignsAndPlans/S10CentralEnforcement.md`
§2 Invariant B + Keystone. Closes #1144.

### Indexer: Base-Sepolia ingest stall fixed — offer modifications no longer wedge the scan (#1149)

The chain indexer's handler for offer modifications tried to save a
"maximum collateral" figure into a database column that was never
created. The database rejected the write, the scan treated that as a
retriable failure (by design — a failed scan must not skip events), and
the Base-Sepolia ingest cursor wedged in place, retrying the same
failing window every tick from 06:57 UTC on 2026-07-10. The book, tape
and history surfaces on that chain silently stopped receiving new
on-chain events (the fault was dormant since 2026-06-30 and only fired
once an offer modification actually appeared in the scan window).

Fixed by dropping the phantom column from the modification update — the
platform stores and displays the modified offer's amounts, rates and
collateral floor, none of which changed. Recovery needs no operator
action beyond the normal deploy: once live, the stuck scan window
succeeds and the cursor catches up on its own.

A new automated guard now prepares every database statement in the
indexer against the exact schema the migrations produce, so a statement
referencing a table or column that doesn't exist fails in CI instead of
wedging production ingest. The indexer's test suite — which previously
ran only on developer machines — is now wired into the blocking
per-change CI gate, closing the coverage gap that let this fault ship.

## Offer collateral floor / lending ceiling is now enforced at creation and modification (PR #<n>)

The protocol derives, for any liquid-both-legs ERC-20 offer, a minimum collateral
a lender may require (so the worst-case fill can clear the loan-admission Health
Factor) and a maximum principal a borrower may request against their posted
collateral. Previously this bound was only *intended* to run at offer creation
and was, in practice, not enforced at all: it sat behind a configuration flag
that the platform never enables, and even with the flag on it read an
offer-amount field that had not been populated at that point, so it never
actually rejected anything. There was also no equivalent check when an existing
offer was modified in place, so a lender could post a compliant offer and then
edit it into a shape a fresh creation would have rejected.

This makes the bound real and consistent. The floor/ceiling is now enforced
whenever an offer is liquid on both legs — the same scope as the runtime
loan-admission gate — and it is applied identically at offer creation, at every
in-place offer modification, and at internal-match slice materialization, sharing
a single definition so the three paths cannot drift. It no longer depends on any
configuration flag. Offers on illiquid or NFT legs are unaffected (they follow
the mutual-consent illiquid path). In the depth-tiered risk regime, collateral in
the no-borrow tier is rejected up front at creation/modification instead of only
at acceptance, so an offer that could never become a loan now fails fast.

The read-only intent match preview keeps its non-reverting, structured-error
contract — the shared bound math is exposed to it as a check that returns a
failure code rather than reverting, so solvers and preflight callers see the same
outcome the execution path would produce.

Observable effect: an offer whose collateral is too thin (lender) or whose
requested principal is too high for its collateral (borrower) is now rejected at
creation or modification with a clear collateral-floor / lending-ceiling error,
rather than being posted and only failing later at acceptance.

This is the last of the three deferred #998 spec-conformance findings; its
approach was ratified in the Tranche-5 deferred-trio design doc after three
rounds of review.

Closes #900.

## Dashboards now show loans that are pending a failed-liquidation cure (#940)

When a loan's liquidation cannot complete on-chain, it enters a **fallback-pending**
state. That state is not the end of the road: the borrower can still cure it —
by adding collateral or repaying in full — right up until the lender claims. It
is treated as an *active* loan everywhere in the protocol.

The connected app's dashboard, however, was leaving these loans out. The "Your
Loans" panel, the unified both-sides table, and the headline active-loan counts
all filtered on the strict "Active" status and silently dropped fallback-pending
loans. A borrower who relied on the dashboard could therefore not see a loan that
was counting down toward a permanent default they still had the power to prevent —
and miss the cure window.

The dashboard read views now use the same "active set" definition the rest of the
protocol uses (Active **or** fallback-pending), so a fallback-pending loan appears
in the loan lists and the counts like any other open loan. No behaviour of the
loan itself changed — only what the dashboard chooses to show.

Part of the 2026-07-05 spec-vs-code conformance review. Closes #940.

## Thread — #998 Tranche 4: forced-close / liquidation hardening (PR #<n>)

This tranche closes four spec-conformance findings on the forced-close
(HF-liquidation, time-based-default, and in-kind fallback) paths. They share
the same code neighbourhood, so they ship together.

**#915 (M7 / spec-review S12) — periodic-settled interest was double-counted
on every forced close.** When a periodic-cadence loan misses a payment, a
settler auto-liquidates the shortfall and credits the paid interest to
`interestSettled` while the loan stays active and its accrual clock keeps
running. The voluntary-close paths already credit that amount, but the forced-
close paths read the raw accrual and did not — so a loan later liquidated,
time-defaulted, or fallback-closed charged the borrower (and paid the lender)
that interest a second time. All four sites now credit `interestSettled`
(saturating): the single/split HF liquidations and the HF metric via the shared
`currentBorrowBalance`, the time-based default inline, the in-kind fallback
split, and the preclose Option 2 obligation-transfer. (The offset Option 3 and
refinance paths already netted it.)

Two paths that re-originate a still-active loan in place — the Option 2
obligation transfer (to a new borrower) and a routine partial liquidation (on
the reduced residual) — restart the interest-accrual clock. Crediting
`interestSettled` there without clearing it would let the same credit be
subtracted a second time on the re-originated loan's next settlement, underpaying
the lender. Both now zero `interestSettled` at the clock restart, since the
settled interest belongs to the closed pre-reset accrual window.

**#1005 (S9) — a swap try-list with no attemptable route could force a healthy
loan into the fallback.** A permissionless caller could invoke `triggerLiquidation`
or `triggerDefault` with an empty adapter list — or, more subtly, a non-empty
list whose only entries are governance-disabled venues (which the failover
helper silently skips) — and the swap helper returned "no routes", dropping the
loan straight into the full-collateral fallback (a 3%+2% premium, in-kind lender
recovery) with zero DEX routes ever attempted. The failover helper now counts
the routes it actually attempts and reverts (`NoEnabledSwapRoute`) when none
were — covering the empty and the all-disabled case in one place, for every
failover caller. The forced-close collateral withdrawal rolls back atomically.

**#1009 (L-g) — the treasury handling fee is now subordinated to full lender
recovery.** On an underwater liquidation the old waterfall took the 2% treasury
handling fee (and the liquidator bonus) off the top before paying the lender, so
the lender funded the treasury's fee on a loan that was already taking a loss.
The liquidator bonus stays first-priority (it is the necessary keeper liveness
incentive), but the treasury handling fee is now taken only from surplus above
the lender's full recovery — on an underwater close it collapses to zero, so the
treasury never profits while the lender takes a loss. Over-collateralised closes
are unaffected. Applied identically to the single-route, split-route, and
time-based-default paths.

**#1010 (L-h) — the time-based default now pays the caller the liquidator
incentive.** The HF liquidation paths pay the caller a dynamic incentive
(6% − realized slippage, capped 3%); the time-based-default swap paid nothing,
leaving permissionless default-triggering economically unmotivated. It now pays
the same incentive via a shared curve helper. The time-based default is a Tier-2
close-out that is deliberately permissionless and must not brick (the unflagged
counterparty has to be made whole), so the trigger itself is never sanctions-
gated. But the bonus is a new value payment, so — like the Tier-1 HF-liquidation
bonus — it is withheld from a sanctioned caller: a sanctioned wallet can still
trigger the default (the close-out completes), but earns no bonus (the withheld
amount stays in proceeds and flows to the lender/borrower via the waterfall).
The bonus is intentionally not KYC-gated, unlike Tier-1, since KYC is off on
retail and this Tier-2 path must not add a gating revert.

To keep the three god-facets under the EIP-170 bytecode limit while absorbing
these changes, the liquidator-incentive curve and the interest-netting credit
were factored into small shared `LibEntitlement` helpers, and the two duplicated
liquidator-KYC blocks in `RiskFacet` were folded into one private helper.

Closes #915, #1005, #1009, #1010 (umbrella #998).

# ENS name lookups stop hitting a rate-limited default endpoint (alpha02)

The address-to-name display sugar (a wallet address with an ENS name
shows the name instead of hex) resolves on Ethereum mainnet, which is
not one of the app's working networks. That lookup client had been
riding the chain library's built-in default endpoint — a free shared
server that started answering "too many requests" the moment a list
page's first paint asked for a name per counterparty row. The failure
was cosmetic (the short hex form always renders when a lookup fails)
but wasteful and noisy.

Two changes, in the same spirit as the RPC diet:

- **The name-lookup client now uses explicitly chosen endpoints** —
  the same operator-overridable Ethereum RPC setting every other
  chain read uses, with a second public endpoint behind it so a
  throttled primary degrades to the fallback instead of to a dropped
  name. The library default is never contacted, and the CI guard that
  watches a parked page's traffic now also fails if it ever is.
- **Each address's name is resolved at most once per session.** Names
  effectively never change mid-session, so re-resolving on every
  screen revisit was pure waste — results are now kept for the whole
  session, and a failed lookup is not retried in a loop.

Nothing visible changes: named wallets still show their names, and
everything else shows the short hex form as before.

## Thread — alpha02 unit tests + a deterministic dynamic-faucet-label test (#1111)

The #1103 faucet change (labelling the relabelled second-liquid row from the
token's live on-chain `symbol()`) shipped with only an e2e smoke assertion. On
the Base-Sepolia fork that slot's symbol IS `mUSDC` — the same string the old
UI hard-coded — so the e2e test couldn't tell a genuinely dynamic label apart
from a regression back to a hard-coded one.

This adds a minimal **unit-test harness to `apps/alpha02`** (a `node`-environment
Vitest, no jsdom/React-Testing-Library) and moves the symbol-resolution logic
into a pure helper (`resolveMintSymbol`). The new `mintSymbol.test.ts` feeds a
deliberately non-`mUSDC` symbol and asserts it flows through to the button label
("Mint 10,000 tLQ2") — something a hard-coded `mUSDC` label could never
reproduce — and asserts the unresolved case falls back to the generic "test
stablecoin" label rather than a specific ticker. The suite runs in the existing
`defi vitest` CI gate (which now also covers `apps/alpha02`), so it can't rot
unrun.

No behaviour change — the faucet renders exactly as before; the resolution
logic was extracted verbatim into a tested helper. Closes #1111.

## Thread — plain-language contract errors + every error captured for support

When a transaction was rejected by the contracts, the app used to surface the
raw Solidity error name (e.g. `MaxLendingAboveCeiling`) in the pre-sign dry-run
footer, and — when the wallet's gas estimation swallowed the revert selector —
a misleading "oversized gas limit / missing approval / stale build" message on
the actual submit. A naive user hitting an under-collateralised borrow (asking
for far more than their collateral supports) saw both, with no readable
explanation of what actually went wrong.

Contract errors now translate to plain language everywhere they surface. The
shared error decoder maps the errors a normal user can actually reach —
borrow/lend/accept/repay bounds like "your collateral is too low for the amount
you want to borrow", consent and health-factor gates, self-trade, duration
caps, and so on — to friendly copy, and ANY other error falls back to a
humanized sentence built from its name instead of a hex blob. The mapping is
keyed by the stable error NAME rather than its 4-byte selector, so a
signature-level contract change can't silently break a message. The pre-sign
dry-run footer and the submit-error banner both read from this, so the review
step and the failure share one voice.

The misleading gas message is defused two ways: the offer flow now prefers the
dry run's concrete reason over the generic gas copy when the wallet estimation
strips the selector, and the generic copy itself was reworded to point at the
review-step reason first rather than only the approval/stale-build guesses.

Finally, a failed transaction is now recorded in the diagnostics sink that
feeds the support drawer and the pre-filled issue report — previously only a
render crash was captured, so a tx that reverted left no trace for support.
Every kind of error the user can hit now lands there.

No contract or ABI changes. The decode/humanize logic is unit-tested; the
end-to-end rendering is verified live against a real testnet revert per the
live-review definition of done. Closes the borrow-error UX follow-up.

# RPC diet — the app stops streaming chain polls (alpha02)

A live measurement on the deployed site showed one open tab — signed
in or not — issuing about 3,700 chain-RPC calls per hour: the live
block-refresh layer's HTTP fallback polled the block number every
second-and-a-bit, and each new block dragged the Offer Book's nominal
30-second refresh cycle down to about five seconds, log-scans
included. Four changes bring a parked tab down to a handful of calls
per minute, with near zero once you look away:

- **Block-driven live refresh is now push-only.** The per-block
  refresh layer runs only when a WebSocket RPC is configured for the
  chain (a true subscription — no request cost per block). Deploys
  without one — including today's — no longer block-poll at all; the
  ordinary 30-second refresh, the instant refresh after your own
  actions, and the indexer push channel carry freshness instead.
  Operators can restore the seconds-fast third-party freshness at any
  time by setting the chain's WebSocket URL — no code change.
- **Hidden tabs hold no subscription.** Previously a hidden tab
  stopped refreshing but kept the block poller running; now the
  watcher itself is off while the tab is hidden.
- **Idle sessions back off.** A visible tab with no interaction
  (taps, keys, scrolling all count) for two minutes stretches every
  periodic refresh to a quarter of its usual pace. The first
  interaction after an idle stretch immediately refreshes the
  transaction-driven data (offers, positions, claims, balances) and
  restores the normal pace; configuration-style data follows at its
  next tick, and returning to the tab refreshes everything on focus
  as before.
- **One static read stopped repeating.** The VPFI token address —
  which changes only through an explicit governance registration or
  rotation — was re-read every 30 seconds, and for signed-out
  visitors it was the only chain call in the cycle; it is now read
  once per session per network. The two governance events stay
  honest: a not-yet-registered result is never cached, and the
  rotation recovery flow clears the cache before it refreshes.

Nothing visible changes: pages render the same, your own actions
still reflect instantly, and the block-driven refresh returns
automatically wherever a WebSocket RPC is configured. A CI check now
fails if a parked Offer Book tab ever streams block polls again, and
a committed live audit driver measures the deployed site's real
traffic against the same budget.

# Asset pickers list the faucet test tokens, and every dropdown gets a real menu (alpha02)

Two changes from the same user request (2026-07-06):

- **On test networks, the borrow / lend / rent asset pickers now list
  the faucet's test tokens** (tLIQ, tLQ2, mWETH, tILQ, tILQ2) as
  first-class choices, each clearly badged as a faucet test token.
  Before this, the faucet page would mint them but the pickers made
  people paste the contract addresses back by hand — the exact
  address-hunting the curated-first picker exists to avoid. The
  addresses come from the same deployments source the faucet page
  reads, and the badge keeps them impossible to mistake for real
  assets. Chains without faucet tokens (all mainnets) are unchanged.

- **Every dropdown in the app is now a properly designed menu instead
  of the browser's built-in one.** The old dropdowns rendered the
  operating system's stock option list — visually flat, single-line
  only, and clashing with the app's light/dark themes. The new menu
  matches the app's look in both themes, supports a second line
  (asset rows show the contract address under the symbol) and badges,
  marks the current choice, and animates gently (respecting the
  reduced-motion preference). Keyboard behaviour matches the native
  control: arrows move, typing jumps to a match, Enter/Space picks,
  Escape closes — and screen readers get the standard combobox/
  listbox semantics.

Nothing about what the dropdowns DO changed: the same choices, the
same paste-an-address escape hatch on asset pickers, the same
selection behaviour everywhere.

## Thread — early under-collateral warning on the borrow terms step (#1112)

A borrower whose collateral is too low for the amount they want to borrow was
only told so at the **review** step — after clicking all the way through
details → terms → review — where the pre-sign simulation surfaces the
contract's `MaxLendingAboveCeiling` / `MinCollateralBelowFloor` /
`InitLtvAboveTier` revert as plain-language copy. For a naive-user flow that's a
step too late: the amount and collateral are entered on the *terms* step, so the
warning belongs there.

The terms step now runs the same read-only `createOffer` `eth_call` the review
step does — with the risk-and-terms consent **forced true in the preview
payload only** (never signed), so the consent gate (which is ticked at review)
doesn't mask the collateral check while the user is still editing amounts — and
shows an inline warning the moment the borrow is under-collateralised. It warns
**only** on under-collateral reverts; every other pre-sign failure (self-trade,
duration cap, a still-incomplete form, an allowance the submit path grants
first) stays silent here and is still caught by the review-step simulation, so
the terms step never cries wolf. The check is advisory — it never blocks the
"Continue to review" button — and the message is decoded from the contract's
own revert, never a client-side re-implementation of the risk math.

Scoped to the borrower's own post flow. The decision logic (which reverts count
as "under-collateral", and the no-crying-wolf exclusions) is unit-tested; the
observable inline warning is verified live per the definition-of-done, matching
how the existing friendly-contract-error UX is covered (a genuine
under-collateral revert isn't reproduced by the Anvil fork). Closes #1112.

## Thread — DeployTestnetMocks validates reuse/override env before broadcasting (#1102)

The testnet-mocks deploy script ran two view-only guards — the
`FAUCET_SWAP_ADAPTER` reuse probe (`owner()` version gate + the price-aware
`tokenUsdPrice8` getter check) and the `MWETH_USD_FEED` live-feed freshness
validation — **inside** the broadcast block. On a misconfigured rerun (a stale
or incomplete live feed, or a pre-#1095 swap adapter passed by env), the script
would broadcast every other mock deployment first and only *then* revert,
leaving orphaned mock contracts on-chain and burning operator gas.

Both checks are now a **pre-flight** block that runs before `startBroadcast`:
they're pure staticcalls, so a bad config fails fast with zero on-chain writes
and an actionable message. The state-writing pieces they feed — the static
snapshot feed deploy and the fresh swap-adapter deploy — stay inside the
broadcast, driven by the values the pre-flight resolved (`wethQuotePrice8` and
whether to reuse `swapAdapter`). The happy path is unchanged; only the failure
ordering moved, so a correctly-configured deploy behaves exactly as before.

Testnet-tooling only — no contract `src/` logic, no facet ABI, no mainnet
surface. Closes #1102.

## Thread — error-selector table is now drift-guarded, and a mis-mapped ERC-20 error fixed (#68)

The shared error decoder (`@vaipakam/lib`) turns a contract revert into
plain-language copy by looking the revert's 4-byte selector up in a
hand-maintained table. Because those selectors were transcribed by hand
(`cast sig`, to avoid shipping a hashing library in the app bundle), the table
could silently drift — a fat-fingered selector, or a Solidity-side signature
change, would quietly mis-decode or fall through to a raw hex blob.

A new drift guard makes the table self-verifying. Every selector is now
recomputed from its own signature and must match, and every mapped name that
the Diamond can actually revert with is cross-checked against the compiled
contract ABI. Its first run surfaced a real, pre-existing bug: the selector
`0x94280d62` was labelled `ERC20InvalidSender` when it is in fact
`ERC20InvalidSpender` (the approval path), so a genuine `ERC20InvalidSender`
revert (the transfer path, selector `0x96c6fd1e`) had no entry at all and
showed the user raw text. Both are now mapped correctly — an invalid-sender
revert reads "Invalid sender address for the token transfer." and an
invalid-spender revert reads "Invalid spender address for the token
approval." A second, older orphan (`0x0857e728`, a "repayment exceeds owed"
message that matches no error anywhere in the current contract surface — not in
the compiled Diamond ABI nor in any source-side error declaration) was
**retired** (#1108): it was dead copy that could only ever mislabel a future
selector collision, so it was removed rather than kept indefinitely.

Guard-only for the contracts (no `src/` logic changed); the user-visible
effect is that the two ERC-20 approval/transfer errors now decode to correct,
distinct copy instead of one wrong label plus one raw blob. The guard runs in
the `@vaipakam/lib` unit suite, which now gates CI, so this class of drift
can't recur silently.

## Thread — faucet second-liquid row labels from the live token symbol (#1103)

The testnet faucet's second liquid token is the slot that gets **relabelled**
(the pre-#1095 `tLQ2` became the `$1` mock-USDC). Its row title and Mint button
were hard-coded to "mUSDC", so during the narrow window where the shipped
frontend bundle still points that slot at the pre-relabel token (before an
operator reruns the mock deploy + the deployments sync), the row would advertise
"mUSDC" while a click actually minted the old token.

The row now reads the token's **live on-chain `symbol()`** and labels the title
("Mock USD Coin (<symbol>)") and the Mint button ("Mint 10,000 <symbol>") from
it. This mirrors what the faucet already did at mint time for the success toast
and `wallet_watchAsset`, so the pre-click label can no longer disagree with what
the click mints. Until the read resolves — or if it errors — the row shows a
**generic** label ("Mock USD Coin (test stablecoin)" / "Mint 10,000 test
stablecoin") rather than asserting a specific ticker it hasn't confirmed, so a
slow or failed read can't re-open the very stale-label window this closes. The
other faucet rows keep their static tickers because those slots aren't
relabelled.

Testnet-faucet-only, cosmetic, transient — the mocks are currently deployed
with mUSDC live, so the label is already accurate today; this hardens the
redeploy-transition window. Closes #1103.

## Thread — realistic testnet faucet prices (mUSDC $1 + ETH-priced mWETH)

The testnet faucet's liquid tokens were all priced identically at $2,000, so
loan math on the test network was unrealistic — one unit of any token was
worth one unit of every other, and a borrow of "1,500 tokens" against "0.1
tokens" looked absurd rather than instructive.

The faucet tokens now carry distinct, realistic USD prices. The second liquid
token is relabelled to look like USDC — "Mock USD Coin" (mUSDC), priced at $1
— and mWETH is priced like real ETH, defaulting to $3,000 and configurable at
deploy time. An optional override lets an operator seed mWETH's price from the
network's real Chainlink ETH/USD feed — the deploy reads that feed once and
pins mWETH to the real ETH value at deploy time (it does not keep tracking the
feed afterwards; an operator reruns the deploy to refresh it — see the
static-snapshot note below for why). tLIQ stays at $2,000. Together these give a
wallet three liquid assets
at three realistic price points, so health-factor, LTV, and liquidation
behave the way they would with real assets.

Because the faucet tokens now carry distinct prices, the mock liquidation swap
venue also had to price cross-asset swaps at the fair ratio (selling 1 mWETH
for ~3,000 mUSDC) rather than a flat 1:1 — otherwise every liquidation on an
unequal pair would miss the oracle-derived minimum output and fall into the
full-collateral fallback. Its proceeds float is now sized in dollar terms so
the low-priced leg (mUSDC) can actually cover selling a high-priced asset into
it.

mWETH is priced from the real ETH/USD feed **at deploy time** and then held
**static** — the deploy takes a one-time snapshot of the live feed and wires
that fixed value into the price feed, the AMM pools, and the swap venue. This
was a deliberate choice: pointing the pools at a *live* ETH feed would make
them fail the oracle's value-balance guard the moment ETH moved a few percent,
flipping every faucet token Illiquid until a redeploy (the static mock pools
can't reprice themselves). The snapshot keeps mWETH realistic (the real ETH
price when deployed) while keeping every liquid-token flow working; an operator
reruns the deploy to refresh mWETH to the current ETH price. The deploy script
also fails fast with an actionable message if an operator tries to reuse a swap
adapter from an older script version that predates this pricing.

Making the prices differ required re-deriving each mock AMM pool's spot price
from its assets' feed prices (previously every pool was a trivial 1:1, valid
only because every price was equal). The oracle only treats a token as liquid
when its pool spot agrees with its price feed within a few percent, so the
pools are now computed from the price ratio instead of a fixed constant. A
deploy-sanity test asserts all three tokens still classify liquid at their new
prices and that each reports its intended dollar value.

This is a testnet-only faucet + deploy-script change (mUSDC keeps 18 decimals
for mock-token uniformity; the "$1 stablecoin" behaviour is what matters for
realistic loan math). No production/mainnet surface and no contract `src/`
logic changes. Operators pick it up by re-running the testnet-mocks deploy
(reuse-pinning every existing faucet asset except the relabelled token) and
the frontend deployments sync.

### alpha02: UX trust batch 1 — six review findings fixed

First fix batch from the 2026-07-11 whole-site UI/UX review
(UX-001/002/007/020/021/022):

- A loan that is already over no longer shows a live amount owed or
  the "if the borrower does not repay…" default warning. The receipt
  now answers per outcome — repaid, defaulted, or closed — and the
  consequence row becomes "What happens next" with matching guidance.
- Claim Center cards now show the exact amount each claim pays out
  (read from the contract's own claim record), replacing "+ interest"
  and the vague default-recovery description.
- On phones the floating Support button moved to the bottom-left so it
  can no longer cover a card's Claim / Use-this-offer button.
- The connected-wallet chip no longer wraps the address onto two lines.
- "Couldn't load" states on Positions, Claims, and the rental browse
  now include a working "Try again" button instead of only telling the
  user to retry.
- Loading indicators actually spin.

### alpha02: UX mobile batch 2 — four review findings fixed

Second fix batch from the 2026-07-11 whole-site UI/UX review
(UX-006/019/039/042), all phone-experience fixes:

- The Rate Desk no longer crushes its order book and ticket
  side-by-side on phones — below small widths they stack full-width,
  ladder first.
- Offer Book and Claim Center cards stack on narrow screens: text
  full-width, action button full-width below, ending the mid-word
  title wrapping next to squeezed buttons.
- The lend/borrow wizard's five step labels collapse to a single
  "Step 2 of 5 — Offers" line on phones instead of wrapping awkwardly.
- Addresses on the Vault and Faucet pages became tappable chips: one
  tap copies the full address (with visible confirmation), a separate
  comfortable target opens the block explorer — replacing tiny link
  glyphs well under thumb size.

### alpha02: whole-site UI/UX review — findings logged + reusable evidence sweep

A full-surface UI/UX review of the alpha02 site was run against the
deployed testnet (every page, desktop and mobile, Basic and Advanced
modes, with a connected test wallet). Fifty prioritized findings —
from trust-damaging state bugs (a repaid loan still showing an amount
owed and a default warning) through mobile layout crushes, dead-end
empty states, and a slow-connection blank-screen cold load — are
logged with IDs in
`docs/FindingsAndFixes/Findings20260711-Alpha02UiUxReview.md`
for later fix batches. No behaviour changed in this PR.

The review also leaves behind a committed, read-only evidence sweep
(`live-ux-sweep.mjs`) that captures screenshots, console, network,
and browser-storage/performance diagnostics for every route in one
run, so future UX audits and before/after checks are reproducible
instead of hand-driven.
