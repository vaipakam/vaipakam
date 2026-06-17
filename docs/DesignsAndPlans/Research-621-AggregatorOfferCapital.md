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
| Offer principal (`createOffer`) | `offerPrincipalLien[offerId]` | anyone via `matchOffers` (permissionless) or direct `acceptOffer` | the offer's **exact** snapshotted terms |
| Intent capital (`fundLenderIntent`) | `lenderIntentCapital[owner][lend][coll]` | a (permissioned) solver via `matchIntent` | within the intent's **bounds** (min-rate, max-LTV, max-term) |

Should a solver/aggregator be able to *also* draw on offer-committed capital — i.e.
unify the two into one fillable pool?

## 2. Code reality — they are NOT walled off from solvers

Critically, offer-committed capital is **already** solver-accessible today: any
solver (including a keeper/aggregator) can fill a standing `createOffer` principal
through `matchOffers` (permissionless on-chain match) or a direct `acceptOffer`,
partial or AON, **at the offer's exact terms**.

(Two clarifications — verified against the v0.6 code, since the surface is easy to
mis-read: (a) `matchSignedOffer` is **not** a fill path for already-committed
`offerPrincipalLien` capital — it materializes a *separate* signed order from the
signer's free wallet/vault balance and only then creates a transient lien; the
permissionless path for *committed* `createOffer` principal is `matchOffers` /
`acceptOffer`. (b) There is currently **no permissioned-solver gate on signed
offers** — `matchSignedOffer` verifies the signature and materializes the slice
with no `requireKeeperForPrincipal` check; only `matchIntent` enforces a keeper
gate today. The `requiresKeeperAuth` opt-in for signed offers is **deferred / not
yet built** — see §5.)

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
capital" mechanism is needed or desirable. The (deferred, not-yet-built)
`requiresKeeperAuth` opt-in for signed offers is the only "aggregator-eligibility"
knob that is consent-safe, because it would control *who fills*, never
*re-pricing*.

**This simplifies #398 (v1.5 ERC-4626 adapter):** an external aggregator deposits
into its per-aggregator `LenderIntentVault` and its capital is intent-capital,
fillable only via `matchIntent` within the aggregator's bounds. The adapter never
touches offer liens, so there is no cross-pool accounting to reconcile.

**`totalAssets` mark — preserve the #398 risk-adjusted requirement (do NOT mark at
face).** The mark is **NOT** "intent capital + live intent principal + claimable
proceeds" at face — that would value active-loan principal at full face and let a
redeemer (here, the aggregator's downstream depositors, who DO have inter-depositor
fairness) draw value against default-risk / not-yet-collected assets. Per #398, and
ratified for the build (2026-06-17): **conservative-haircut mark** —
`totalAssets` = idle intent capital (which already includes collected + auto-rolled
interest as realized yield) **+ risk-adjusted live principal** (face minus a
per-asset governance haircut, written down further on default) **+ realized /
claimable proceeds**; **accrued-but-unpaid interest is EXCLUDED** until collected;
and `maxWithdraw` = **idle only** (capital locked in live loans is not withdrawable).
This keeps the share price conservative and honest. (See the #398 design doc for
the exact formula + the withdrawable-vs-marked split.)

**Reconciliation with the older #398 / HybridIntentLayer wording:** those specs
describe the adapter as "posting signed offers" via the signed-offer matcher. This
verdict **supersedes** that for the adapter's integration path — post-#393 the
adapter funds a **`LenderIntent`** (`fundLenderIntent` → `matchIntent` → auto-roll),
which is the standing-supply primitive purpose-built for this and keeps the capital
cleanly intent-side. The #398 design doc + HybridIntentLayer §3.3 should be updated
to the LenderIntent path when #398 is built.

**Follow-up that remains real (not unification):** the deferred `requiresKeeperAuth`
opt-in for signed offers (a v0.6 EIP-712 schema change) — it would give signed
offers a permissioned-solver mode without touching terms. Tracked separately; out
of scope here.
