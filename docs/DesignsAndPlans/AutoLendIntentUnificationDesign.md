# Auto-lend = the LenderIntent layer — unification design (#625)

**Card:** [#625](https://github.com/vaipakam/vaipakam/issues/625) — "make off-chain
(dapp-side) auto-lend fully on-chain / trustless; review auto-borrow."
**Builds on:** the **live** LenderIntent layer
([`LenderIntentVaultV1Design.md`](LenderIntentVaultV1Design.md), #393 L1 / #401
Stage-4; v1-a…v1-d merged). This doc is the *product-wiring* layer on top of it.
**Status:** design — for iteration before any code (architecture-iteration norm).
Revised 2026-06-25 after an adversarial design review (Codex) corrected several
intent-lifecycle assumptions — see §2/§3.

---

## 1. The decision (user-ratified 2026-06-25)

**Auto-lend is the LenderIntent layer.** A passive lender who wants "deploy my idle
capital automatically" registers a standing **LenderIntent**, **funds it**, and keepers
fill it into loans as matching borrowers appear. We do **not** build a parallel
auto-lend mechanism, and we do **not** add duration-range to the point-offer book — the
intent's `maxDurationDays` *cap* already gives a passive lender "any duration up to N
days," which is the duration flexibility the request asked for.

**Defaults stay protective: full-term interest, no partial repay.** The intent layer
already enforces both (`matchIntent` reverts `LenderIntentFullTermRequired` /
`LenderIntentPartialRepayNotAllowed`), the right default for capital that isn't actively
watched. We are **not** adding a pro-rata / partial opt-in in this pass.

**Auto-borrow is out of scope** — it does not exist; left as-is per the request.

### What this resolves about the original ask
"For auto-lend make duration `any` + enable partial repay + pro-rata (full-term stays
default)." A scout reframed it:
- **Duration `any`** → already delivered by `LenderIntent.maxDurationDays` (a cap; the
  borrower picks the concrete term ≤ cap).
- **Pro-rata vs full-term** → already a per-offer choice (`useFullTermInterest`, default
  `true`); for auto-lend we keep full-term.
- **Partial repay** → a per-offer **opt-in** flag (`Offer.allowsPartialRepay`, default
  `false`; `RepayFacet.repayPartial` reverts `PartialRepayNotAllowed` — *not* universal).
  For auto-lend the intent layer keeps it off.

So the work is **wiring + automation**, not new matching mechanics — but the intent
layer's **capital lifecycle** (fund → lien → fill → roll) is more involved than a naive
"register an offer" model, and the design must wire all of it.

---

## 2. Current state (corrected after review)

| Piece | State | Where |
| --- | --- | --- |
| **Registration** | LIVE | `LenderIntentFacet.setLenderIntent(lendingAsset, collateralAsset, maxExposure, minRateBps, maxInitLtvBps, maxDurationDays, minFillAmount, requiresKeeperAuth, riskAndTermsConsent)` — bounds + one-time risk/terms consent. Registration is always open (NOT gated by the fill kill-switch). |
| **Funding (REQUIRED before fill)** | LIVE | `fundLenderIntent(lendingAsset, collateralAsset, amount)` pulls wallet→vault and **liens** the capital under the intent (`LibEncumbrance.lienIntentCapital`). `matchIntent` draws strictly from this `lenderIntentCapital` lien (`unlienIntentCapital`) and **reverts `IntentCapitalInsufficient`** if the intent is unfunded / depleted below `fillAmount`. So a registered-but-unfunded intent is NOT fillable. |
| **Fill** | LIVE | `OfferMatchFacet.matchIntent(lender, lendingAsset, collateralAsset, counterpartyOfferId, fillAmount)` — materializes a temporary lender slice, routes through `_executeMatch`. Enforces `duration ≤ maxDurationDays`, full-term, no-partial, exposure ≤ `maxExposure`, capital ≥ `fillAmount`. Lender-of-record stays the user. |
| **Fill kill-switches (TWO)** | LIVE | `matchIntent` checks **both**, in order: `partialFillEnabled` (reverts `FunctionDisabled(3)`) THEN `lenderIntentEnabled` (reverts `FunctionDisabled(4)`) — both default **false**. Intent fills need BOTH on. **Neither is `cfgAutoLendEnabled`** (that only gates `setAutoLendConsent`). It also freezes an aggregator's intent when `cfgAggregatorAdaptersPaused`, and blocks a VPFI-lending intent. |
| **Revolving (NOT automatic)** | LIVE but explicit | When an intent loan repays, proceeds land as the lender's **free balance + a Position-NFT claim** — they are NOT auto-re-lent. An explicit `LenderIntentFacet.rollIntentLoan(loanId)` (owner or authorized keeper) consumes the lender claim and re-liens the proceeds into `lenderIntentCapital`. Only then is the same intent re-fillable from the compounded capital. The normal `ClaimFacet` path just releases exposure + withdraws to the lender. |
| **Keeper-pause** | CONDITIONAL | `matchIntent` reaches `LibAuth.requireKeeperForPrincipal` (which enforces `keepersPaused`) **only when `intent.requiresKeeperAuth == true`**. An intent with `requiresKeeperAuth == false` is openly fillable by anyone and the on-chain keeper pause does NOT apply to it. |
| **Preview** | MISSING | `previewMatch(lenderOfferId, borrowerOfferId)` needs two already-materialized offers; an intent's slice is created *inside* the state-changing `matchIntent`, so there is **no** dry-run for an intent fill today. |
| **Discovery** | event-only | `LenderIntentSet` / `LenderIntentCancelled` / `LenderIntentFunded` / `LenderIntentCapitalWithdrawn` events. No paginated registry view. |
| **dapp auto-lend UX** | HALF-BUILT, WRONG TARGET | `autoLendConsent` marker + `AutoLifecycleSettingsCard.tsx` aimed at posting fixed-duration *offers* (inferior; not even implemented). |

**Net:** the engine exists but with a real **capital lifecycle** (fund + roll) and **no
preview**. The gaps: the dapp points at the wrong mechanism and omits funding; the keeper
doesn't fill or roll intents; and there's no `previewIntent` for a keeper to dry-run.

---

## 3. Work items

### WI-3 — pin the full-term + no-partial guarantee (already enforced; document + test)
The guarantee is *already* enforced: `matchIntent` rejects a pro-rata / partial-enabled
BORROWER offer, and `LoanFacet._copyPrincipalAssetFields` copies the loan's flags from
the **accepted (borrower) offer** — not the lender slice. So setting the slice's
`useFullTermInterest` (the original WI-3 idea) would be a **dead write**. WI-3 instead:
(a) a clarifying comment in `_intentSliceParams`, and (b) a **positive regression
assertion** on the filled LOAN (`test_matchIntent_fillsAndAttributesToLender`:
`useFullTermInterest == true && allowsPartialRepay == false`). No source-behaviour
change ⇒ no ABI/selector change. **Phase 1, independently shippable.**

### WI-2 — keeper auto-fills (and rolls) intents, via two new views
**Contract — add `getActiveLenderIntents` (paginated) + `previewIntent` (dry-run).**
1. **`getActiveLenderIntents(offset, limit) → LenderIntentSummary[]`** — requires backing
   storage the facet lacks today (intents are a non-enumerable `(owner, lend, coll)`
   mapping), so add an **enumerable set of active intent keys** maintained on
   `setLenderIntent` (add) / `cancelLenderIntent` (remove). The DTO is a **lean** summary:
   owner + pair + bounds + **`requiresKeeperAuth`** (the keeper must know to skip a gated
   intent it can't fill) + `lenderIntentLivePrincipal` + **available capital**
   `lenderIntentCapital` (REQUIRED — an intent can be funded-but-depleted, and a keeper
   that filters only on exposure submits a fill that reverts `IntentCapitalInsufficient`).
2. **`previewIntent(lender, lendingAsset, collateralAsset, counterpartyOfferId, fillAmount)
   → IntentPreviewResult`** — the dry-run for an intent fill. **Implementation principle
   (load-bearing): reproduce the ACTUAL `matchIntent → _executeMatch` outcome by REUSING
   the same check helpers, NOT by re-deriving a hand-maintained gate list.** `matchIntent`'s
   success depends on a deep call stack — its own intent guards, then `_executeMatch` which
   runs `previewMatch` AND reasserts `RiskAccessFacet.assertMatchAllowed` (the **#671
   progressive-risk gate**), then `_materializeIntentSlice` → `createOffer` validations. A
   gate list copied into a view will always drift from that stack; instead `previewIntent`
   calls the same predicates the live path calls, and the binding guarantee is a test that
   **`previewIntent` Ok ⟺ `matchIntent` would succeed** for identical inputs (incl. the
   underfunded / depleted-capital / risk-gated / sub-minimum / full-term-required cases).
   The gate **categories** it must cover (the test enforces completeness): intent bounds
   (`active`, `minFillAmount`, exposure, capital, duration, LTV), the full-term/no-partial
   borrower guards, the two kill-switches + aggregator/VPFI blocks, the **#671 risk-access
   gate**, and the slice-`createOffer` validations.
   - **Result type:** the existing `MatchResult` enum can't express intent-only failures
     (underfunded capital, exposure exceeded, full-term-required, risk-gated, …), so
     `previewIntent` returns an **extended `IntentPreviewResult`** = `MatchResult` + an
     intent-failure reason code, so the keeper learns *why* a candidate is unfillable, not
     just that the generic `previewMatch` matrix was Ok.
3. **EIP-170 watch:** if `LenderIntentFacet` lacks headroom for the view(s), place the
   read views on the metrics facet that already hosts `getActiveOffersPaginated`, keeping
   only the enumerable-set maintenance on `LenderIntentFacet`. Facet-addition / selector /
   ABI-export checklist applies.

**Keeper — `apps/keeper/src/matcher.ts` (or a sibling), each tick:**
1. Page `getActiveLenderIntents`; skip intents with **zero available capital**.
2. **Filter out keeper-gated intents the bot can't fill:** `matchIntent` calls
   `requireKeeperForPrincipal(KEEPER_ACTION_SIGNED_FILL, lender)` when
   `intent.requiresKeeperAuth == true`, so only attempt an intent that is either openly
   fillable (`requiresKeeperAuth == false`) OR for which the bot holds the lender's
   `SIGNED_FILL` delegation — else the fill reverts.
3. For each remaining intent, find borrower offers that fit: **rate** — `intent.minRateBps
   ≤ borrowerOffer.interestRateBpsMax` (the borrower's CEILING — NOT `interestRateBps`, the
   floor); **duration** ≤ `maxDurationDays`; **init-LTV** ≤ `maxInitLtvBps`; **amount** —
   bounded by BOTH sides: `[max(intent.minFillAmount, borrowerOffer.minimumPrincipal),
   min(maxExposure − live, availableCapital, borrowerRemainingCapacity)]`. The slice is
   single-fill (`amount == amountMax == fillAmount`), so `fillAmount` must clear the
   borrower offer's OWN minimum-principal floor (lower bound) AND not exceed its remaining
   capacity (upper bound), not just the intent's `minFillAmount`.
4. `previewIntent` → if Ok, submit `matchIntent(...)`. The keeper earns the 1% LIF.
5. **Off-chain kill-switch self-gate:** honour `partialFillEnabled`, `lenderIntentEnabled`,
   AND `keepersPaused` before submitting. `matchIntent` enforces the first two on-chain, but
   `keepersPaused` is enforced on-chain ONLY for `requiresKeeperAuth == true` intents — so
   for openly-fillable intents the bot must self-gate on `keepersPaused` off-chain (else it
   keeps matching during a pause).
6. **Auto-roll pass:** discover the lender's repaid intent loans via the per-loan
   `intentOrigin[loanId]` marker (set at fill) — there is no enumerable source today, so
   surface them through a new `getRollableIntentLoans`-style view OR an indexed
   `OfferMatched`-derived intent-loan set — filter by **reusing `rollIntentLoan`'s own
   rollability predicate** (don't hand-copy a list that will drift); the categories are
   `status == Repaid`, intent still active, `loan.lender == owner`, position NFT not sold
   (`ownerOf == owner`), no `heldForLender` reservation, asset not paused, no post-match
   VPFI rotation — and the binding guarantee is the same `discovery ⟹ roll succeeds`
   agreement test as `previewIntent`. Then call
   `rollIntentLoan(loanId)` so the proceeds re-lien into `lenderIntentCapital` and the
   intent revolves. **Roll uses a DIFFERENT delegation:** `rollIntentLoan` requires the
   owner or a keeper authorized for `KEEPER_ACTION_AUTO_ROLL` (NOT `SIGNED_FILL` /
   `requiresKeeperAuth`). Without this pass, repaid capital sits idle as free balance and
   "revolving" never materialises.

### WI-1 — dapp auto-lend opt-in: register + **fund** a `LenderIntent`
Repoint `AutoLifecycleSettingsCard` so "turn on auto-lend" runs this ordered sequence:
1. `setLenderIntent(...)` (bounds + one-time risk/terms consent);
2. `fundLenderIntent(...)` (a registered-but-unfunded intent never fills — load-bearing,
   not optional);
3. **grant the keeper the delegations the automation needs** — `KEEPER_ACTION_AUTO_ROLL`
   (so the keeper can roll repaid loans; `rollIntentLoan` rejects any non-owner caller
   without it), AND `KEEPER_ACTION_SIGNED_FILL` **iff** the lender chose a keeper-gated
   (`requiresKeeperAuth == true`) intent (else the keeper correctly skips it and a gated
   intent never fills);
4. `setAutoLendConsent(true)` **LAST**.

Setting consent **last** matters because these are separate transactions (the diamond has
no single-tx "enable auto-lend"): if any earlier step is rejected / cancelled, the consent
flag never gets set, so it can't diverge from a not-actually-live intent. But a partial
success (e.g. intent registered + funded, then the user abandons before the grants/consent)
still leaves a **half-configured** state, so the dapp must make the flow **resumable**: on
load, read the on-chain state (intent active? funded? grants present? consent set?) and
offer "resume / finish enabling" rather than assume a clean slate — every step is
idempotent, so resuming just runs the missing ones. (If the diamond exposes a `multicall`,
batching the calls into one tx is the cleaner end-state; absent that, resumable is the
fallback.) "Turn off" reverses it:
`cancelLenderIntent(...)` + withdraw capital + revoke the keeper grants +
`setAutoLendConsent(false)`. `setAutoLendConsent` itself requires `cfgAutoLendEnabled` on.
The registration UI surfaces the **market-rate widget** (already shipped) as the suggested
`minRateBps` floor so a passive lender doesn't underprice (O4).

**`autoLendConsent` stays — the opt-in master switch (O1).** Default `false` ⇒ the lender
lends **manually** (point offers) — the default experience. Removing it would make
auto-lend implicitly always-available, which we do NOT want. When the lender flips it ON,
the dapp runs the register+fund flow; when OFF, no intent is auto-managed. Retire only the
**fixed-duration `autoLendConsent`→post-offer** logic the old design implied. The
unrelated auto-extend / auto-refinance keeper paths on `AutoLifecycleFacet` are untouched.

**Note on the fill kill-switches:** BOTH `partialFillEnabled` AND `lenderIntentEnabled`
(governance, both default off) must be ON for any intent to fill — `matchIntent` checks
`partialFillEnabled` first. These are deployment-level enablements, not per-user dapp
controls. The dapp should reflect their combined state ("auto-lend fills are currently
disabled by governance") rather than try to set them.

---

## 4. Trust model (why this satisfies #625's "fully on-chain / trustless")
- The lender authorises **once** at registration (`riskAndTermsConsent`) and commits
  capital via `fundLenderIntent`. No per-fill signature.
- The solver/keeper fills on-chain via `matchIntent`; it cannot alter the stored bounds.
- `loan.lender` stays the **beneficial owner** (the user), not a vault contract
  (`LenderIntentVaultV1Design.md §1`).
- Capital stays the user's (vaulted + liened to their own intent) until a bilateral
  match — the pool stays **virtual** (ethos E1).

---

## 5. Resolved decisions (user, 2026-06-25)
- **O1 — keep `autoLendConsent` as the opt-in master switch.** Default off ⇒ manual
  lending is the default. See WI-1.
- **O2 — add a paginated `getActiveLenderIntents` view** (not event-indexing), **plus a
  `previewIntent` view** (the review surfaced that no intent dry-run exists). Enumerable
  registry + EIP-170-aware placement. See WI-2.
- **O3 — phase WI-3 → WI-2 → WI-1.** Land the test-pin, then the views + keeper fill/roll,
  then the dapp. Until WI-1, a lender can register + fund an intent by hand and the keeper
  fills/rolls it.
- **O4 — market-rate widget as the suggested `minRateBps` floor** in the registration UI.

### Phasing (one PR per phase)
1. **Phase 1 — WI-3** (clarifying comment + positive regression test; no source-behaviour
   change).
2. **Phase 2 — WI-2** (enumerable registry + `getActiveLenderIntents` + `previewIntent`
   views, then the keeper fill **and roll** passes with the corrected rate/capital/pause
   logic). After this, funded intents fill + revolve automatically.
3. **Phase 3 — WI-1** (dapp toggle → register **+ fund**, gated by `autoLendConsent`, with
   the market-rate floor + the governance-switch reflection).

---

## 6. Out of scope (explicitly)
- **Auto-borrow** — does not exist; left as-is.
- **Duration-range matching on the point-offer book** — unnecessary; the intent cap gives
  lenders duration flexibility. (Separate card if ever wanted for manual point lenders.)
- **Pro-rata / partial-repay for auto-lend** — kept off (protective default). If ever
  desired, an explicit per-intent opt-in flag, never the silent default.
- **Changing the `lenderIntentEnabled` governance switch** — that's an operator/governance
  decision, not part of this product wiring.

---

## 7. Verification (when built)
- **WI-3:** the intent-fill happy-path test asserts the filled LOAN carries
  `useFullTermInterest == true && allowsPartialRepay == false`. No selector/ABI change.
- **WI-2 (contract):** `getActiveLenderIntents` pagination + DTO (incl. available capital)
  tests; `previewIntent` agrees with a subsequent real `matchIntent` (Ok ⇒ fills;
  not-Ok ⇒ reverts) incl. the underfunded / depleted-capital case; deploy-sanity
  (selector/size/integration) for the new view(s).
- **WI-2 (keeper):** unit tests for bound-matching (rate vs borrower CEILING, capital
  floor, exposure room, duration), the off-chain pause self-gate, dedupe, and the roll
  pass (mirroring #222).
- **WI-1:** dapp `tsc` + the auto-lend flow registers **and funds** (then cancels +
  withdraws) an intent against a local fork; reflects the `lenderIntentEnabled` state.
