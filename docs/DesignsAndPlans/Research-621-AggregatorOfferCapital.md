# Research #621 — Should the aggregator/intent layer also draw on offer-committed (`createOffer`) capital?

**Status:** findings + verdict (Stage-4 follow-up surfaced during #393 v1-d.1).
**Scope:** ERC20-on-ERC20 only (NFT stays pure P2P). Part of the #401 program.
**Relation to #398:** this resolves what capital the ERC-4626 aggregator adapter
(v1.5) is allowed to source — see §5.

## 1. The question

When v1-d.1 introduced the intent-capital lien, the matching layer ended up with
two isolated lender-liquidity pools that share only the `encumbered[user][asset][0]`
free-balance aggregate:

| Pool | Lien | Filled by | Under what terms |
| --- | --- | --- | --- |
| Offer principal (`createOffer`) | `offerPrincipalLien[offerId]` | anyone via `matchOffers` / `matchSignedOffer` | the offer's **exact** snapshotted terms |
| Intent capital (`fundLenderIntent`) | `lenderIntentCapital[owner][lend][coll]` | a (permissioned) solver via `matchIntent` | within the intent's **bounds** (min-rate, max-LTV, max-term) |

Should a solver/aggregator be able to *also* draw on offer-committed capital — i.e.
unify the two into one fillable pool?

## 2. Code reality — they are NOT walled off from solvers

Critically, offer capital is **already** solver-accessible today: any solver
(including a keeper/aggregator) can fill a standing offer through `matchOffers`
(on-chain book) or `matchSignedOffer` (gasless book), partial or AON, at the
offer's terms. The `requiresKeeperAuth` flag on a signed offer already provides a
*permissioned-solver* mode (controls **who** may fill, not the terms).

So "the aggregator can't use offer capital" is a false premise. What "unification"
would actually mean is: **let the matching layer redeploy offer-committed capital
under *intent-band* terms** (a different rate/duration/collateral than the lender
chose), when no offer-matching borrower exists.

## 3. Ethos analysis — that redeployment violates consent (E2) for no real gain

- **E2 fixed-rate / consent.** An offer's economic terms are snapshotted immutably
  and carry `creatorRiskAndTermsConsent`. Filling that capital under intent-band
  terms substitutes the *solver's* choice for the *lender's* — a consent break.
  The lender who wanted a 7%/90-day/2× position did not consent to a 5%/30-day fill.
- **No real capital-efficiency gain.** The only "extra" utilization unification
  buys is deploying idle offer capital when no offer-matching counterparty exists —
  but that is exactly the case the lender chose to wait for. If they wanted
  band-flexible deployment, that is what an **intent** is. The capital is not idle
  by accident; it is idle *by the terms the lender set*.
- **Double-allocation safety.** The two liens are separate counters; a solver
  drawing intent capital can never touch `offerPrincipalLien` (and vice versa).
  Unifying into one fillable pool reintroduces the race surface the separation
  removes.
- **The lender already has the migration path.** A lender who decides their idle
  offer capital *should* be band-deployable can `cancelOffer` (releases the lien →
  free balance) and `fundLenderIntent`. No protocol mechanism is required to "move"
  capital between the models; the user expresses intent by choosing the surface.

## 4. Options weighed

1. **Never mingle (keep isolated).** Offer capital fills at offer terms; intent
   capital fills within bounds. Each is solver-accessible under its own consent
   contract. **← recommended.**
2. **Per-offer "aggregator-eligible / promote-residual-to-intent" opt-in.** A flag
   that lets a lender mark an offer's residual as *also* band-fillable. This is a
   pure **UX convenience** for "cancel + re-fund as intent" — it adds a
   consent-reconciliation surface (which terms win at fill? the offer's or the
   band's?) and a second claim on the same lien, for a flow the lender can already
   do in two existing calls. Low value, real surface. **Defer indefinitely.**
3. **Always unify.** Rejected — consent break (E2) + double-allocation race, per §3.

## 5. Verdict + impact on #398

**Verdict: keep the offer-principal and intent-capital pools ISOLATED (Option 1).**
The matching layer already reaches both — offers at their exact terms, intents
within bounds — under distinct, consent-preserving paths. No new "draw on offer
capital" mechanism is needed or desirable. The `requiresKeeperAuth` signed-offer
opt-in (already specced, deferred) is the only "aggregator-eligibility" knob that
is consent-safe, because it controls *who fills*, never *re-pricing*.

**This simplifies #398 (v1.5 ERC-4626 adapter):** an external aggregator deposits
into its per-aggregator `LenderIntentVault` and its capital is intent-capital,
fillable only via `matchIntent` within the aggregator's bounds. The adapter never
touches offer liens, and there is no cross-pool accounting to reconcile —
`totalAssets` is exactly the aggregator's intent capital + its live intent
principal + claimable proceeds. The isolation verdict is a precondition that keeps
the adapter's share-accounting honest.

**Follow-up that remains real (not unification):** the deferred `requiresKeeperAuth`
opt-in for `matchSignedOffer` (a v0.6 EIP-712 schema change) — it gives offers a
permissioned-solver mode without touching terms. Tracked separately; out of scope
here.
