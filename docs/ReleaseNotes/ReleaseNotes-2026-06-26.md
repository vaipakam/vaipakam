# Release Notes — 2026-06-26

This release ships the **auto-lend epic (#625)** end to end. Auto-lend is now
the standing **LenderIntent** layer rather than the legacy fixed-duration
offer-posting marker: a lender registers a standing intent on a
`(lending asset, collateral asset)` pair with their own bounds (max exposure,
min fill, min-rate floor, max init LTV, max term), funds working capital, and the
production keeper does the rest — **auto-filling** matching borrower demand within
those bounds and, once the lender delegates the dedicated authority,
**auto-rolling** fully-repaid intent loans straight back into the lender's capital
with no manual claim/refund round-trip. The pieces landed bottom-up: the design
card (#743) and the full-term/no-partial fill pin (WI-3, #744), then the on-chain
discovery + preview + keeper passes (WI-2, below), and finally the dapp surface
(WI-1, #753).

**Operator action required before auto-roll works on a live chain.** WI-1 adds a
new optional `keeperAddress` field to the per-chain deployment record — the
production keeper bot's signing address (the public address of the
`apps/keeper` Worker's `KEEPER_PRIVATE_KEY`). The dapp reads it to offer the
auto-roll / signed-fill delegation step (`approveKeeper` + `setKeeperAccess`).
Until an operator publishes it (by adding `keeperAddress` to that chain's
`contracts/deployments/<slug>/addresses.json` and re-running the frontend
deployments export), the Auto-lend card still works for intent registration +
funding — auto-FILL needs no delegation — but hides the auto-ROLL delegation step
and explains it's unavailable. It must match the address the keeper actually signs
with, or delegated rolls revert. The full step is in the Deployment Runbook
("Auto-lend keeper address"). The protocol is pre-live, so there is nothing to
populate yet; this is a deploy-time checklist item.

---

## Thread — Auto-lend Phase 2a: on-chain discovery for standing lender intents (PR #746)

Part of #625 (auto-lend = the LenderIntent layer; see the design card). This is the
first build step of Phase 2 — the **discovery surface** a keeper needs to find and
fill standing lender intents automatically.

Until now a registered `LenderIntent` was reachable only by its exact
`(owner, lendingAsset, collateralAsset)` key — there was no way to enumerate the live
intents, so an off-chain filler would have had to index every
`LenderIntentSet` / `LenderIntentCancelled` event to reconstruct the active set. This
change adds an **on-chain registry** of active intents and a paginated read view, so a
keeper can simply page the current set each tick.

What's new:

- An **enumerable registry of funded, active intents**: an intent appears in the feed
  exactly when it is both active and holds funded capital, and drops out when it is
  cancelled or when its capital reaches zero — whether by a withdrawal or by a fill drawing
  it down. The registry is kept correct by re-syncing at every point capital or the active
  flag changes (register, cancel, fund, withdraw, auto-roll, a fill's draw-down, and the
  backstop's direct seeding). Gating feed membership on funded capital means a bare
  registration that commits nothing is never advertised — so the global feed can't be
  bloated by zero-capital registrations (entering it costs committed capital, not just gas).
- **`getActiveLenderIntents(offset, limit)`** — a paginated, lean read view returning, per
  active intent, the lender's bounds plus the two figures a filler needs to size a fill
  safely: the live principal already lent out, and the un-lent funded capital a fill draws
  from (a fill exceeding that capital reverts on-chain). It also reports whether the intent
  requires a keeper authorisation, so a filler can skip intents it isn't delegated to fill.

Roll discovery (the keeper finding an intent's repaid loans) does **not** need a new event:
the existing intent-fill event already carries the originating owner and the loan id, which
is exactly what the later auto-roll pass keys off.

This is a read-only surface plus registry bookkeeping — no change to how intents are funded,
filled, or priced. The keeper that consumes the feed (the fill and auto-roll passes) lands
in the following Phase-2 steps; this step gives that work a clean, paginated on-chain source.

(Note: the registry is populated only by the new funding path, so it is correct from this
deployment forward; the protocol is pre-live, so there are no pre-existing funded intents to
back-fill.)

## Thread — Auto-lend Phase 2b: gas-free preview of a standing-intent fill (PR #747)

Part of #625 (auto-lend = the LenderIntent layer; see the design card). Phase 2a
gave a keeper the **discovery** surface — a paginated feed of the funded, active
lender intents. This step gives it the **decision** surface: a read-only way to
ask, for one prospective fill, "would this succeed, and if not, exactly why?" —
before spending any gas on a transaction that might revert.

What's new:

- **`previewIntent(solver, lender, lendingAsset, collateralAsset, borrowerOfferId,
  fillAmount)`** — a non-mutating view that runs the SAME checks the live
  `matchIntent` fill runs, in the same order, and reports the first thing that
  would stop the fill. It returns a structured result:
  - a single `ok` flag — true only when every layer passes;
  - the precise failure reason, split into an intent-level code (the lender's
    standing-intent guards: the two kill-switches, an inactive or VPFI-lending
    intent, a solver that isn't authorised for a keeper-gated intent, a fill
    below the dust floor or above the exposure cap, a borrower term longer than
    the lender allows, a borrower offer that disables full-term interest or opts
    into partial repay, an unresolvable collateral requirement, or insufficient
    funded capital), the shared match-admission code (asset/amount/rate/
    collateral/health-factor overlap), and the progressive risk-access gate code;
  - the numbers a solver needs to size the fill — the principal it would draw,
    the midpoint rate the resulting loan would carry, the collateral the borrower
    must post, and the un-lent funded capital the intent can still deploy.
- The **prospective filler is a parameter** (`solver`), not the caller of the
  view, so a keeper can preview on behalf of the account that would actually
  submit — the keeper-authorisation check is evaluated against that account.

Why this is safe to rely on: the preview reuses the live predicates rather than
re-deriving them. The shared match core was refactored so the very same
admission logic serves both a stored-offer match and a not-yet-stored intent
slice (the slice the fill would materialise is synthesised in memory and run
through the identical core); the progressive risk-access gate's actor resolver
was generalised the same way; and the keeper-authorisation check is the exact
predicate the enforcing path consumes. The binding guarantee is a paired
agreement test: for identical inputs, `previewIntent` reports success if and only
if `matchIntent` would succeed, and each failure code lines up with the precise
revert the live fill raises.

This is a read-only surface plus two internal refactors that leave every existing
behaviour byte-identical — no change to how intents are funded, filled, or
priced. The keeper that consumes the preview (the fill and auto-roll passes)
lands in the next Phase-2 step.

## Thread — Auto-lend Phase 2c: keeper auto-fills standing lender intents (PR #748)

Part of #625 (auto-lend = the LenderIntent layer; see the design card). Phase 2a
gave the keeper a discovery feed of funded, active lender intents; Phase 2b gave
it a gas-free, exact preview of whether one fill would succeed. This step closes
the loop: the production keeper now **automatically fills** those intents.

What's new — the keeper's matching tick gains a second pass:

- After its existing Range-Orders `matchOffers` pass, the keeper pages the funded
  active lender intents and, for each, scans the borrower offers it already
  hydrated this tick for a fillable counterparty. It pre-filters cheaply on the
  conditions the on-chain fill enforces — same asset pair, the borrower's term
  within the lender's maximum, the borrower honouring full-term interest and
  no-partial-repay, the lender's rate floor at or below the borrower's rate
  ceiling, and not a self-trade — then **sizes the fill** from both sides'
  bounds: at least the larger of the intent's dust floor and the borrower's
  minimum, and at most the smallest of the intent's remaining exposure headroom,
  its un-lent funded capital, and the borrower's remaining capacity. An
  all-or-nothing borrower pins the fill to its full amount.
- It then confirms the sized fill with the gas-free `previewIntent` view and only
  submits `matchIntent` when the preview says it will succeed — so the keeper
  never spends gas on a fill the protocol would reject. The keeper is the solver,
  so it earns the same 1% matcher kickback as on the offer-match path. A
  keeper-gated intent the keeper isn't delegated to fill is simply skipped (the
  preview reports it).
- The pass shares the matcher's existing safety rails: the per-chain wall-time
  budget (so a busy book can't starve other chains in a cron tick) and per-tick
  caps on preview reads and submissions. The same master kill-switches that gate
  `matchOffers` also gate `matchIntent` (the matcher machinery flag plus the
  lender-intent flag) — both default off until governance enables them, and the
  keeper logs the disabled state once and keeps polling.

This is purely additive keeper behaviour reusing the on-chain views and the same
hydrated order book; it changes nothing about how intents are funded, priced, or
settled. The companion **auto-roll** pass (re-deploying a repaid intent loan's
proceeds into the next fill) lands in the following step.

## Thread — Auto-lend Phase 2c: on-chain discovery for auto-rollable intent loans (PR #750)

Part of #625 (auto-lend = the LenderIntent layer; see the design card). The
keeper already auto-FILLS standing lender intents; the next step is to auto-ROLL
a fully-repaid intent loan — re-deploying its proceeds straight back into the
lender's intent capital with no manual claim/refund round-trip. This change adds
the **on-chain discovery surface** the keeper needs to find those loans.

The discovery is kept fully on-chain on purpose: the keeper signs transactions,
so it must decide what to roll from authoritative chain state, not from an
off-chain index (which would add a trust boundary and an attack surface to a
value-moving path).

What's new:

- An **enumerable registry of live intent-originated loans**: a loan joins the
  registry the moment a fill records its originating intent, and leaves it when
  that origin is cleared — whether the proceeds are claimed through the normal
  path or auto-rolled. The registry therefore tracks exactly the loans that
  still carry a live intent origin, with no unbounded growth.
- **`getRollableIntentLoans(offset, limit)`** — a paginated, lean read view that
  pages the registry and returns only the loans that are **fully repaid** (the
  roll candidates), each with the originating owner, the asset pair, and the
  intent's **original fill amount (principal)** — a discovery/labelling figure,
  not the amount re-lent: the roll itself (`rollIntentLoan`) re-liens the
  lender's **claim amount** (principal **plus** accrued interest), so auto-roll
  compounds. It is keyed off each loan's
  recorded origin rather than the live lender of record, so a loan whose lender
  position was sold is still surfaced (the roll itself then safely rejects it,
  and the keeper authorises against the recorded owner).

This is a read-only surface plus registry bookkeeping — no change to how intents
are funded, filled, rolled, or settled. The keeper pass that consumes the feed
(paging it and calling the existing auto-roll entry point) lands in the
following step.

(Note: the registry is populated only by the new fill path from this deployment
forward; the protocol is pre-live, so there are no pre-existing intent loans to
back-fill.)

## Thread — Auto-lend Phase 2c: keeper auto-rolls fully-repaid intent loans (PR #751)

Part of #625 (auto-lend = the LenderIntent layer; see the design card). The
keeper already auto-fills standing intents and the protocol exposes an on-chain
feed of fully-repaid intent loans; this step closes the loop — the production
keeper now **auto-rolls** those loans, re-lending the proceeds straight back into
the lender's intent capital with no manual claim/refund round-trip.

What's new — the keeper's matching tick gains a third pass (after the offer-match
and intent-fill passes):

- It pages the on-chain registry of fully-repaid intent loans and calls the
  existing roll entry point for each, so a lender who delegated the dedicated
  auto-roll permission to the keeper gets zero-gap redeployment automatically.
- Because rolling a loan removes it from the registry, the keeper collects the
  full set of repaid loans up front and then rolls them by id — avoiding the
  skip that paging-while-mutating would cause.
- A loan whose owner has **not** delegated the auto-roll permission to this
  keeper is rejected on-chain; the keeper recognises that and skips every other
  loan with the same owner for the rest of the tick, rather than re-attempting
  one per loan.
- The pass runs even when there are **no open offers** (rolling is independent of
  the order book), and it shares the matcher's existing safety rails: the
  per-chain wall-time budget and the per-tick submission cap are carried through
  from the match and fill passes (so the three passes can't together exceed the
  budget), and it self-gates on the operational keeper-pause — re-read
  immediately before each roll — so a pause mid-tick stops further rolls.

This is purely additive keeper behaviour reusing the on-chain roll-discovery
view and the existing roll entry point; it changes nothing about how intents are
funded, filled, rolled, or settled on-chain.

## Thread — Auto-lend Phase 1: dapp surface, wired to standing intents (PR #753)

Part of #625 (auto-lend = the LenderIntent layer; see the design card).
With every on-chain piece (intent discovery, fill preview, the keeper
fill + roll passes) already merged, this final step gives lenders a
front-end to turn auto-lend on — and rewires it off the legacy
fixed-duration offer-posting marker onto the standing-intent machinery.

What's new for the user — a new **Auto-lend** card on the Dashboard:

- The lender picks a `(lending asset, collateral asset)` pair and sets
  their own bounds: max exposure, minimum fill size, a minimum rate
  floor, a maximum initial LTV, and a maximum loan term. A "use recent
  market rate" hint pre-fills the rate floor from the freshest matched
  offer on that pair (the same anchor the Offer Book surfaces), so the
  lender isn't guessing.
- Turning it on runs an ordered, **resumable** sequence whose order is
  security-critical: **record the auto-lend consent marker, delegate the
  protocol keeper (auto-roll, plus signed-fill when the lender keeps the
  intent keeper-gated), register the standing intent, and fund working
  capital last.** Consent and the keeper grant land *before* registration
  because registering reactivates and re-lists a paused intent's reserved
  capital into the fill registry — so doing it first would risk capital
  becoming fillable before the authorizations exist. (For an already-active
  intent whose terms are being *tightened*, the new terms are registered
  *before* the keeper is delegated, so the keeper can't fill under the old,
  looser terms in the window between transactions.) Funding stays last so
  capital is never pulled into custody before a fillable, properly
  delegated intent exists. Each step probes its on-chain state first, so a
  sequence interrupted by a rejected wallet prompt or a dropped tx resumes
  from where it stopped rather than redoing finished steps. The form also
  pre-flights everything the contract would reject (bad/zero or VPFI
  lending asset, over-cap funding, a full keeper whitelist) so no consent
  or grant is ever written ahead of a doomed registration.
- The two admin kill-switches are reflected honestly: the consent switch
  gates the consent step, and the fill-path switch is surfaced as "you
  can register and fund now; the keeper starts filling once it's
  re-enabled" — an intent can be staged while filling is paused and
  starts automatically when governance flips it on.
- Wind-down is first-class and genuinely stops fills. Because the
  auto-lend consent marker carries no on-chain fill enforcement, **Pause**
  *cancels* (de-lists) the standing intent rather than just clearing the
  marker — the lender's un-lent capital stays reserved and is resumable
  (re-enabling re-registers the intent without re-funding) or withdrawable
  at any time. **Withdraw & stop** cancels the intent first (closing the
  fill window) and then returns the un-lent capital to the wallet. A
  separate global control revokes the wallet-level consent marker.

The keeper's signing address is published per-chain (a new optional
deployment field the operator sets — see the operator note at the top of
this release and the Deployment Runbook); where it isn't yet configured,
the card still offers intent registration + funding (auto-fill works
without any delegation) and explains that auto-roll delegation becomes
available once a keeper address is set. The legacy auto-lend toggle was
removed from the Auto-lifecycle card, which now carries only the borrower
auto-opt-in-on-new-loan convenience.

This is a pure front-end change — no contract behaviour changes; the
intent layer it drives was specified and shipped in the WI-2 work. It
went through 15 rounds of Codex review (~70 findings, all fixed) plus an
Ultra Security Review (approved, no P1/P2 blockers). Closes the #625
auto-lend epic. Follow-ups, tracked separately: surfacing/managing
multiple concurrent intents per lender (the card configures one pair at a
time) and an indexer-populated keeper discovery path (#752).
