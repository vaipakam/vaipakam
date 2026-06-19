# Release Notes — 2026-06-17

Five PRs built out the LenderIntentVault (#393 v1) — the set-and-forget
standing-supply layer of the #401 intent program — from the standing-intent
surface (v1-a) through the `matchIntent` fill path and the per-(owner, lend,
collateral) exposure accounting (v1-b/c/d).

## Thread — LenderIntentVault v1-a: standing lending intents (PR pending)

The first slice of the LenderIntentVault (the "set-and-forget supply" layer of the
hybrid intent program). A lender can now register a **standing lending intent** for
an ERC-20 asset-pair — a set of bounds describing the loans they're willing to make:
the most principal they'll have out at once, a minimum interest rate, a maximum
loan-to-value, a maximum term, and a smallest acceptable fill size. The intent is a
one-time on-chain setting; the lender's funds stay in their existing vault and never
move when the intent is registered.

This release ships only the standing-terms surface — registering, updating, reading,
and cancelling an intent, plus a governance kill-switch for the feature. The fill path
that turns a standing intent into actual loans arrives in the next slice. Crucially,
the design keeps the **depositing lender as the lender-of-record** on any loan their
intent later produces: the intent is a layer on top of the existing vault, not a new
contract that holds funds, so every downstream behaviour a lender relies on today
(claiming repayments, fee discounts, the position NFT being transferable) is the exact
same audited path — unchanged.

Registering an intent is screened against the sanctions oracle like any other new
lending commitment; cancelling one is always allowed (a flagged lender can always wind
down their standing exposure). The bounds are validated on entry — a zero asset, zero
exposure, a minimum fill larger than the exposure cap, a missing or above-100% LTV
ceiling, or a zero term are all rejected — so a registered intent is always
well-formed. Intents are independent per asset-pair. The feature ships **off**: lenders
can register intents, but no fill executes until governance enables the path after the
testnet bake (the same ship-off / governance-on / break-glass-off pattern the matching
and partial-fill features use).

Part of #393 / the hybrid intent program (does not close the umbrella). Next slices:
the permissioned-solver fill path, the solver-authorization gate, and auto-roll.

## Thread — LenderIntentVault v1-b: the standing-intent fill path (PR pending)

The second slice of the LenderIntentVault turns a registered standing lending
intent into actual loans. A solver (or any caller) can now **fill a lender's
standing intent** against an existing on-chain borrower offer: the protocol
constructs a one-time lender offer from the intent's bounds — the lender's rate
floor, the borrower offer's term (capped at the intent's maximum), and the
collateral the intent's maximum loan-to-value requires — funds it from the
lender's existing vault balance, and matches it through the same audited engine
the on-chain matcher uses. The solver earns the standard 1% matcher fee.

Because the loan is created through the normal matching path with the lender as
the offer's creator, the **depositing lender is the lender-of-record** on the
resulting loan: repayment claims, fee treatment, and the transferable lender
position all behave exactly as for a directly-created offer. Nothing about the
loan's lifecycle is special-cased for intents.

Each fill is bounded by the intent the lender signed up to: it can't be smaller
than the lender's minimum fill size, can't push the lender's total outstanding
principal on that asset-pair past their exposure cap, can't run a term longer
than the lender allowed, can't open below the collateral the lender's
maximum-LTV setting demands (if the protocol can't price that collateral, the
fill is refused rather than opened blind to the bound), and must carry the
lender's full-term-interest floor so a borrower can't escape the lender's
committed interest by repaying early.

The amount a lender has "live" in outstanding intent loans is tracked per
asset-pair against their exposure cap, by the **original fill amount** (so a
partially-repaid loan still releases its full reserved amount). The cap is
**freed when the lender claims the loan's proceeds** — the point at which the
principal returns to the lender's control — after which the lender can deploy it
again. The release is keyed to the loan's **originating** intent, so even if the
lender sells their position mid-loan, the original lender's cap is the one freed
(never the buyer's). Re-lending those proceeds back into the standing intent
*without any manual step* (true zero-gap auto-roll) is the next increment; this
slice delivers the fill path plus the exposure accounting that underpins it.

The whole fill path is governed by its own feature switch that stays off until
governance enables it after the testnet bake; while off, lenders can still
register and cancel intents, but no fill executes. Part of #393 (does not close
the umbrella). Next: the permissioned-solver authorization gate, then the
zero-gap keeper-claim auto-roll.

## Thread — LenderIntentVault v1-c: permissioned-solver gate (PR pending)

A lender can now mark a standing lending intent **solver-permissioned**: when set,
only the lender themselves or a solver the lender has explicitly authorized may
fill that intent. An intent left open (the default) stays fillable by any solver,
exactly as before.

This closes the gap the earlier slice deliberately left open. When the standing-
intent surface first shipped, the "authorized-solvers-only" flag was rejected at
registration because there was no gate to honour it — accepting it would have
given lenders a false sense of protection. That gate now exists: the flag is
honoured, and registering a solver-permissioned intent is allowed.

Authorization reuses the platform's existing per-user keeper-approval machinery —
the same mechanism that authorizes keepers for loan actions like preclose,
refinance, and loan-sale — with a new dedicated "fill a standing intent" action
the lender grants to specific solver addresses. Because the authorization is
checked before any loan exists, it is keyed to the lender (the party being acted
for) rather than to a loan position. A solver that hasn't been granted the action
is refused; the lender acting for themselves is always allowed.

Part of #393 (does not close the umbrella). The parallel opt-in for the gasless
signed-offer matcher (which would change that order's signature schema) is a
separate follow-up. Next: the zero-gap keeper-claim auto-roll.

## Thread — LenderIntentVault v1-d.1: standing-intent working capital (fund + exit)

A lender with a standing lending intent can now **fund it with working
capital** and **withdraw the un-lent remainder back to their wallet**. This
closes the gap that made the intent surface incomplete: until now there was no
clean way for a lender to put standing capital behind an intent, nor to take
un-lent capital back out.

**Funding follows the offer model.** Funding an intent pulls the lender's
capital from their wallet into their own vault and locks it under the intent —
exactly the way creating an offer pre-vaults and locks its principal. That
locked capital is the pool a solver's fills draw from. Because it is locked
(not loose vault balance), no other withdrawal path can touch it; it can only
leave by being lent out in a fill or by the lender withdrawing it.

**The exit mirrors cancelling an offer.** Withdrawing intent capital releases
the un-lent portion of that lock and returns it to the lender's wallet. A
lender can fund in stages, top up, withdraw part, or wind down entirely — and
the exit stays available even after the intent itself is cancelled, so capital
is never stranded.

**Why this is safe by construction.** A lender's funded capital and the
proceeds of a loan that has repaid live in two separate places: funded capital
sits in the locked intent pool, while repaid proceeds return as an ordinary
claim the lender collects with their loan position NFT. The withdrawal door
only ever touches the locked intent pool, so it can never reach — and never
double-spend — money that is already owed to the position-NFT holder as a
claim. This is the same protection the platform already applies to its other
vaulted-balance withdrawal door, achieved here structurally rather than with an
extra reservation.

**Solver fills now draw strictly from funded capital.** A fill can never lend
more than the lender has actually funded into the intent; an under-funded
intent simply can't be filled until more capital is added. The standing
exposure cap the lender set still applies on top.

Part of #393 (does not close the umbrella). The aggregator question raised
during design — whether the auto-matching layer should also be able to use
capital a lender committed via ordinary offer creation — is tracked separately
as a research item (#621). Next: v1-d.2, the zero-gap auto-roll that re-funds
the intent from a loan's proceeds without a manual round-trip.

## Thread — LenderIntentVault v1-d.2: zero-gap auto-roll

A lender's standing intent can now **redeploy its own returns automatically**.
When a loan made from an intent is repaid, an authorized keeper (or the lender)
can roll it: the proceeds — principal **and** interest — are re-committed
straight back into the intent's working capital instead of being paid out to a
wallet. The next match then lends that compounded capital again, with no manual
claim-and-refund round-trip in between. This closes the last idle gap in the
set-and-forget supply loop.

**Compounding.** The full repaid amount is rolled back in, so interest builds
the capital base over time rather than sitting idle. The lender's existing
maximum-exposure setting still caps how much can be on loan at once; capital
beyond that simply waits in the pool until it can be deployed.

**Authorization.** Rolling is gated by a new dedicated keeper permission —
"auto-roll this lender's repaid intent loans" — that the lender grants through
the same per-user keeper-approval mechanism used for the other keeper actions.
A lender can always roll their own loans; a keeper needs the explicit grant.
This is deliberately separate from the "fill my intent" permission, so a lender
can opt into automated redeployment independently of who may open new loans for
them.

**Two safety guards.** First, only a cleanly fully-repaid loan can roll —
defaulted, liquidated, or fallback loans go through the normal claim, because
their proceeds may be collateral rather than re-lendable principal. Second, and
most important: if the lender **sold their loan position** before it repaid, the
roll is refused. The buyer of that position is the one owed the proceeds and
collects them the normal way; auto-roll can never divert a sold position's
returns into the original lender's intent. The proceeds are re-committed as
capital and the claim that would have paid a wallet is consumed in the same
step, so a rolled loan's funds are never both claimable and re-lent.

Part of #393 (does not close the umbrella). With the working-capital lifecycle
(v1-d.1) and this auto-roll, the standing-intent supply side is feature-complete:
fund an intent, let solvers fill it, let it compound and redeploy itself, and
withdraw the un-lent remainder whenever you choose.
