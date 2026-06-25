# Auto-lend = the LenderIntent layer — unification design (#625)

**Card:** [#625](https://github.com/vaipakam/vaipakam/issues/625) — "make off-chain
(dapp-side) auto-lend fully on-chain / trustless; review auto-borrow."
**Builds on:** the **live** LenderIntent layer
([`LenderIntentVaultV1Design.md`](LenderIntentVaultV1Design.md), #393 L1 / #401
Stage-4; v1-a…v1-d merged). This doc is the *product-wiring* layer on top of it.
**Status:** design — for iteration before any code (architecture-iteration norm).

---

## 1. The decision (user-ratified 2026-06-25)

**Auto-lend is the LenderIntent layer.** A passive lender who wants "deploy my idle
capital automatically" registers a standing **LenderIntent**; keepers/solvers fill it
into loans as matching borrowers appear, and it revolves as loans repay. We do **not**
build a parallel auto-lend mechanism, and we do **not** add duration-range matching to
the point-offer book — the intent's `maxDurationDays` *cap* already gives a passive
lender "any duration up to N days," which is exactly the duration flexibility the
request asked for.

**Defaults stay protective: full-term interest, no partial repay.** The intent layer
already enforces both (`matchIntent` reverts `LenderIntentFullTermRequired` and blocks
partial-repay counterparties) — the right default for capital that isn't actively
watched. We are **not** adding a pro-rata / partial-repay opt-in in this pass.

**Auto-borrow is out of scope** — it does not exist in the codebase, and the request
was explicitly "leave it as is, concentrate on auto-lend."

### What this resolves about the original ask
The request was "for auto-lend make duration `any` + enable partial repay + pro-rata
(full-term stays default)." A code scout reframed it:
- **Duration `any`** → already delivered by `LenderIntent.maxDurationDays` (a cap; the
  borrower picks the concrete term, the lender accepts anything ≤ cap).
- **Pro-rata vs full-term** → already a per-offer choice (`useFullTermInterest`,
  default `true`); for auto-lend we keep full-term.
- **Partial repay** → a per-offer **opt-in** flag (`Offer.allowsPartialRepay`, default
  `false`; `RepayFacet.repayPartial` reverts `PartialRepayNotAllowed` otherwise — *not*
  universal). For auto-lend the intent layer keeps it off.

So the only real work is **wiring + automation**, not new matching mechanics.

---

## 2. Current state

| Piece | State | Where |
| --- | --- | --- |
| **LenderIntent registration** | LIVE | `LenderIntentFacet.setLenderIntent(lendingAsset, collateralAsset, maxExposure, minRateBps, maxInitLtvBps, maxDurationDays, minFillAmount, requiresKeeperAuth, riskAndTermsConsent)` — captures a standing intent + the mandatory one-time risk/terms consent. (VPFI can't be the lending asset; self-collateralized rejected.) |
| **Solver fill** | LIVE | `OfferMatchFacet.matchIntent(lender, lendingAsset, collateralAsset, counterpartyOfferId, fillAmount)` — materializes a temporary lender slice, routes through the shared `_executeMatch`. Enforces `duration ≤ maxDurationDays`, full-term, exposure ≤ `maxExposure`. Lender-of-record stays the user. |
| **Revolving / auto-roll L1** | LIVE | exposure counter `lenderIntentLivePrincipal`; decremented at terminal close → the same intent is immediately re-fillable from returned principal. |
| **Discovery events** | LIVE | `LenderIntentSet` / `LenderIntentCancelled` (+ `LenderIntentFunded` / `…CapitalWithdrawn`). |
| **dapp auto-lend UX** | HALF-BUILT, WRONG TARGET | `autoLendConsent[user]` marker (`AutoLifecycleFacet`) + `AutoLifecycleSettingsCard.tsx`. The intended dapp behaviour is to post **fixed-duration** standing *offers* on deposit — the inferior mechanism. The actual posting logic isn't even implemented. |
| **keeper intent auto-fill** | MISSING | `apps/keeper/src/matcher.ts` runs ONLY the legacy `matchOffers` loop (`getActiveOffersPaginated` → `previewMatch` → `matchOffers`). It never calls `matchIntent`, so registered intents sit unfilled until a solver acts manually. |

**Net:** the engine (register → fill → revolve, any-duration, full-term) is built and
live. The gaps are (a) the dapp points its auto-lend UX at the wrong mechanism, and
(b) the keeper doesn't auto-fill intents.

---

## 3. Work items

### WI-1 — dapp auto-lend opt-in registers a `LenderIntent`
Repoint the auto-lend surface (`AutoLifecycleSettingsCard`) so "turn on auto-lend" =
configure + `setLenderIntent(...)`, and "turn off" = `cancelLenderIntent(...)`. The
lender sets the bounds they care about (asset pair, `maxExposure`, `minRateBps`,
`maxInitLtvBps`, `maxDurationDays`, `minFillAmount`, `requiresKeeperAuth`) and signs the
one-time risk/terms consent. This makes auto-lend trustless by construction — the lender
authorises once, the solver fills on-chain, and `loan.lender` stays the user. The
registration UI surfaces the **market-rate widget** (already shipped) as the suggested
`minRateBps` floor, so a passive lender doesn't underprice (O4).

**`autoLendConsent` stays — it is the opt-in master switch (O1).** Auto-lend is strictly
opt-in: `autoLendConsent` defaults `false`, and while it is off the lender lends
**manually** (point offers via the normal flow) — that is the default experience.
Removing the flag would make auto-lend implicitly "always available," which we do NOT
want. When the lender flips it ON (in the dapp), the auto-lend flow registers + manages
a `LenderIntent` on their behalf; when OFF, no intent is auto-managed. Retire only the
**fixed-duration `autoLendConsent`→post-offer** logic that the old design implied (never
fully built, inferior); the consent marker itself is kept and repurposed as this
switch. The unrelated auto-extend / auto-refinance keeper paths on `AutoLifecycleFacet`
are untouched.

### WI-2 — keeper auto-fills intents (via a new paginated view, O2)
Two parts:

**Contract — add a paginated `getActiveLenderIntents` view (O2).** The keeper discovers
intents via an on-chain paginated view rather than event-indexing. This requires
backing storage the facet doesn't have today: intents are keyed by `(owner,
lendingAsset, collateralAsset)` in a non-enumerable mapping, so add an **enumerable set
of active intent keys** maintained on `setLenderIntent` (add) / `cancelLenderIntent`
(remove), plus `getActiveLenderIntents(offset, limit) → LenderIntentSummary[]` returning
a **lean DTO** (owner + pair + the bounds + live exposure — NOT a 9-field struct array,
per the viaIR lean-DTO rule). **EIP-170 watch:** if `LenderIntentFacet` lacks headroom,
place the view on the metrics facet that already hosts `getActiveOffersPaginated` /
`getActiveLoansPaginated` and keep only the enumerable-set maintenance on
`LenderIntentFacet`. Facet-addition / selector-array / ABI-export checklist applies.

**Keeper — add an intent-fill pass to `apps/keeper/src/matcher.ts`** (or a sibling), each
tick:
1. Page `getActiveLenderIntents` for live intents.
2. For each, find borrower offers that fit its bounds (rate ≥ `minRateBps`, duration ≤
   `maxDurationDays`, init-LTV ≤ `maxInitLtvBps`, amount ≥ `minFillAmount`, exposure
   room ≤ `maxExposure`), preview, and submit
   `matchIntent(lender, lendingAsset, collateralAsset, borrowerOfferId, fillAmount)`.
The keeper earns the standard 1% LIF on its own leg. Respect `requiresKeeperAuth` and
the existing kill-switches (`keepersPaused`, `cfgAutoLendEnabled`).

### WI-3 — contract hardening: set `useFullTermInterest` explicitly on the intent slice
Today the intent path enforces full-term only *indirectly* — by reverting if the
counterparty offer isn't full-term — and `OfferMatchFacet._intentSliceParams` doesn't
set `useFullTermInterest` on the materialized slice (relies on it being structurally
required). Make it **explicit** (`useFullTermInterest = true` in the slice params) so
the guarantee is self-evident and not a structural side-effect. Small, low-risk,
defense-in-depth. Targeted test in the intent-fill suite.

---

## 4. Trust model (why this satisfies #625's "fully on-chain / trustless")

- The lender authorises **once** at registration (`riskAndTermsConsent`, same gate as
  every offer-create path). No per-fill signature.
- The solver/keeper fills on-chain via `matchIntent`; it can pay gas but cannot alter
  the lender's bounds (they're stored, and the fill is checked against them).
- `loan.lender` stays the **beneficial owner** (the user), not a vault contract — so
  claims, keeper-auth, VPFI discount, and sanctions all key off the right identity
  (the load-bearing v1 decision in `LenderIntentVaultV1Design.md §1`).
- The pool stays **virtual** (capital in the user's own vault until a bilateral match) —
  consistent with ethos E1 (no commingled share pool).

---

## 5. Resolved decisions (user, 2026-06-26)

- **O1 — keep `autoLendConsent` as the opt-in master switch.** Default `false` ⇒ manual
  lending is the default; auto-lend never happens unless the lender turns it on. Do NOT
  remove the flag (removal would make auto-lend implicitly always-on). See WI-1.
- **O2 — add a paginated `getActiveLenderIntents` view** (not event-indexing). Requires
  an enumerable intent-key set + EIP-170-aware placement. See WI-2.
- **O3 — phase WI-3 + WI-2 first, then WI-1.** Land the hardening and the keeper
  auto-fill (incl. the new view) so registered intents actually fill, THEN wire the dapp
  toggle (the consumer). Until WI-1, a lender can still register an intent by hand and
  the keeper will fill it.
- **O4 — surface the market-rate widget as the suggested `minRateBps` floor** in the
  registration UI so passive lenders don't underprice. Folded into WI-1.

### Phasing
1. **Phase 1 — WI-3** (explicit `useFullTermInterest` on the intent slice; small,
   low-risk, independently shippable).
2. **Phase 2 — WI-2** (the `getActiveLenderIntents` view + enumerable registry, then the
   keeper intent-fill pass). After this, registered intents fill automatically.
3. **Phase 3 — WI-1** (dapp auto-lend toggle → `setLenderIntent`/`cancelLenderIntent`,
   gated by `autoLendConsent`, with the market-rate floor).
Each phase is its own PR per the one-PR-per-design-step convention.

---

## 6. Out of scope (explicitly)

- **Auto-borrow** — does not exist; left as-is per the request.
- **Duration-range matching on the point-offer book** — unnecessary; the intent cap
  already gives lenders duration flexibility. (A nicety for manual flexible-term
  point lenders, not auto-lend; separate card if ever wanted.)
- **Pro-rata / partial-repay for auto-lend** — kept off (protective default). If ever
  desired, an explicit per-intent opt-in flag, never the silent default.

---

## 7. Verification (when built)

- WI-3: targeted intent-fill test asserting the materialized slice carries
  `useFullTermInterest == true`; deploy-sanity unaffected (no selector change).
- WI-2: keeper unit tests (bound-matching + previewIntent gate + dedupe + kill-switch),
  mirroring the existing matcher test ask (#222).
- WI-1: dapp `tsc` + the auto-lend flow registers/cancels an intent against a local
  fork.
