# Borrower-facing +0.5% APR platform fee — research & recommendation (#785 / T-096)

**Status:** research/design note for a **decision**. No code lands until the
owner picks an option below.

## The idea (T-096)

Add one more fee layer: **+0.5% APR above the lender's requested interest APR**,
shown to the borrower (the extra spread accruing to the protocol/treasury). This
note answers: (1) is a borrower-facing APR markup *standard*, and in what *form*;
(2) how it stacks with the fees Vaipakam already charges; (3) is there a better
approach.

---

## 1. What peers actually charge — and in what FORM

The headline finding: **every lending venue takes a protocol cut, but almost none
expresses it as a separate "+X% APR" line added on top of the lender's rate.** The
cut takes one of three shapes, and the shape is the important part.

| Venue (class) | Fee FORM | Typical magnitude | Borrower sees… |
| --- | --- | --- | --- |
| **Aave / Compound / Spark** (pooled DeFi) | **Reserve factor** = % of *borrow interest* routed to treasury | **10–25% of interest** (per-asset, governance-set) | one borrow APR; the cut is taken out of what suppliers earn, not added to the borrower |
| **Morpho (Blue)** (DeFi P2P-ish) | Optional market fee = % of interest, curator-set | often **0%**, up to a capped % of interest | one borrow APR |
| **Maple** (institutional DeFi credit) | Origination + ongoing management fee (% of assets/principal) | bespoke, %-of-principal | baked into deal terms |
| **Uniswap** (DEX spot) | Swap fee = **bps on notional**, LP-bound; protocol takes a fraction | 0.05 / 0.30 / 1.00% of notional | per-swap fee, not APR |
| **dYdX / GMX** (perps) | taker/maker **bps on notional** + funding (+ GMX hourly borrow fee) | single-digit bps + funding | per-trade + funding, not an APR markup |
| **LendingClub / Prosper** (retail P2P) | One-time **origination fee** (deducted from disbursement) + servicing | **1–8% of principal**; servicing ~1% of payments | their quoted **APR already amortizes the origination fee** (TILA) |
| **TradFi banks** | Net-interest-margin **spread baked into the APR** + one-time processing/origination | spread varies; fees one-time | **one TILA APR** that, by law, *includes* finance charges |

Two regularities fall out:

- **DeFi norm = reserve factor (a % of interest), not an APR markup.** And the
  magnitude is large — 10–25% of interest — versus Vaipakam's current 1%.
- **Retail-lending norm (P2P + banks) = a single all-in APR.** US Truth-in-Lending
  (Regulation Z) *requires* the APR to fold in finance charges precisely so a
  borrower isn't shown a rate that excludes mandatory fees. A separate
  "+0.5% platform APR" line on top of the lender rate is the thing TILA exists to
  prevent — not illegal for a permissionless protocol, but it cuts against the
  grain of how every regulated lender presents cost.

**Conclusion for (1):** a borrower-facing spread is completely normal as
*economics*; expressing it as a *third, separately-stacked APR line* is not the
standard *form* anywhere. The standard forms are (a) % of interest, or (b) one
consolidated all-in APR.

---

## 2. How +0.5% APR stacks with Vaipakam's CURRENT fees

Current fee surface (verified against `LibVaipakam.sol`, all tunable
`0 ⇒ default`, admin → governance):

| Fee | Constant | Value | Bearer | Form |
| --- | --- | --- | --- | --- |
| Treasury cut on interest | `TREASURY_FEE_BPS` | 100 = **1% of interest** | **lender** (yield haircut) | reserve-factor-style |
| Loan-initiation fee (LIF) | `LOAN_INITIATION_FEE_BPS` | 10 = **0.1% of principal** | **borrower** (VPFI, time-weighted, partly rebated) | origination-style |
| Liquidation handling | `LIQUIDATION_HANDLING_FEE_BPS` | 200 = 2% of proceeds | defaulting borrower's collateral | event fee |
| Matcher slice of LIF | `LIF_MATCHER_FEE_BPS` | 100 = 1% of LIF | (keeper reward, out of LIF) | — |

So **today the borrower's all-in cost** on a healthy loan = agreed interest **+
0.1% LIF**. Interest is the full-term floor *by default*, but `useFullTermInterest`
is a per-offer flag (see #784), so it's pro-rata when the offer opted out — any
spread design must settle consistently with both modes. The LIF is charged in the
lending asset by default and is VPFI-paid-and-partly-rebated only on the opt-in
discount path. The 1% treasury cut is borne by the **lender**, invisible to the
borrower.

Adding the proposed **+0.5% APR** introduces a *new, third* mechanism and — unlike
the treasury cut — it is **borrower-facing**. Worked example, lender rate `R`,
principal `P`, term `t` days:

| Lender rate R | Borrower interest (full-term) | + LIF 0.1% (one-time) | + **NEW 0.5% APR** | Borrower effective APR | New fee as % of interest |
| --- | --- | --- | --- | --- | --- |
| 5% | 5%·P·t/365 | 0.1%·P | 0.5%·P·t/365 | ~5.5% + LIF | **10% of interest** |
| 10% | 10%·P·t/365 | 0.1%·P | 0.5%·P·t/365 | ~10.5% + LIF | **5% of interest** |
| 20% | 20%·P·t/365 | 0.1%·P | 0.5%·P·t/365 | ~20.5% + LIF | **2.5% of interest** |

Two observations:

- **It stays competitive in absolute magnitude.** +0.5% APR is small next to peers'
  10–25% reserve factors — Vaipakam would remain one of the cheapest venues. *But*
  the "small share of interest" only holds at typical rates: Vaipakam permits very
  low APR offers, and at a 1% lender rate +0.5% APR is ~50% of interest — well above
  the 10–25% peer band. So the comparison is favourable in absolute APR but breaks
  down as a *share of interest* on low-rate loans (the regressivity point below).
- **A flat APR markup is regressive across rate levels.** Expressed as a share of
  interest it is *heavier on low-rate loans* (10% of interest at R=5%, only 2.5% at
  R=20%) — the opposite of how a reserve factor scales. And it produces a **3-fee
  stack** (interest + an APR-markup to treasury + an origination fee) with a
  borrower "headline rate" (the lender's R) that is **not** the true cost — exactly
  the opacity TILA-style single-APR disclosure avoids.

---

## 3. Recommendation

**Don't add a third, separately-stacked APR line. Instead present a single,
clearly-disclosed borrower "platform APR".**

Recommended option **A — consolidated platform APR (single disclosed rate):**

- The borrower is shown **one** rate = `lenderRate + platformSpreadBps`, labelled
  as their all-in platform APR (the lender still receives interest on `lenderRate`;
  the spread accrues to treasury). This is the TILA/P2P norm and the #784
  disclosure surface already exists to show it honestly.
- `platformSpreadBps` is a **configurable knob** mirroring the other fee params:
  `0 ⇒ default`, **default 0 (off)**, range-capped by a new `MAX_PLATFORM_SPREAD_BPS`
  (suggest ≤ 200 bps), admin-settable now → governance after handover. Shipping it
  *off* lets the platform turn it on deliberately.
- Keep the existing 1%-of-interest treasury cut as the **lender-side** reserve
  factor; the spread is the **borrower-side** complement. Two bearers, two clear
  lines — not three.

  Implementation caveats (load-bearing, if Option A is built):
  - **Snapshot the spread onto the loan at accept**, exactly like the loan's other
    terms. `platformSpreadBps` is a mutable admin/governance knob; it must NOT be
    read live at repay/preclose/refinance time, or raising it after accept would
    retroactively change what an existing borrower owes. The accepted value binds
    for the life of the loan.
  - **Bind the borrower-offer ceiling + EIP-712 accept-terms to the all-in APR.**
    The ERC-20 borrower offer's max-rate ceiling and the signed accept-terms
    (`OfferAcceptFacet._bindTermsToOffer`, `useAcceptTermsSigning`) currently bound
    `lenderRate`; with a spread added on top, those checks must be redefined so the
    ceiling bounds `lenderRate + spread` (the borrower's actual maximum), else the
    borrower can be bound to more than they agreed to.
  - **The disclosed figure should fold in the LIF** (or show it as an explicit
    adjacent line). `lenderRate + spread` alone isn't truly "all-in" — the
    mandatory 0.1% LIF annualizes materially on short terms, so a genuinely all-in
    APR (the whole point of Option A) must include it.

  Further implementation-time requirements (deferred to the implementation card —
  recorded here so they aren't lost; the owner's decision on this note is **Hold /
  research-only**, so none of this is built yet):
  - **Account for the spread separately from `lenderRate` on the loan.** The
    snapshot must store the lender rate and the platform spread as distinct fields,
    so settlement pays the lender on `lenderRate` and routes the spread to treasury
    — not one blended rate that would over-pay the lender.
  - **Bind the spread on the matched + automated paths too**, not just direct
    accept. `LibOfferMatch.previewMatch` / the matcher and the auto-lend/auto-refi
    keeper paths bind terms without going through `_bindTermsToOffer`; each must
    apply the same all-in ceiling + snapshot, or those paths bypass the borrower's
    agreed maximum.
  - **Keep the all-in APR within `MAX_INTEREST_BPS` (10,000).** A standalone spread
    cap could push `lenderRate + spread` past the protocol's existing max-interest
    ceiling for offers already near it; the spread must be clamped so the all-in
    rate still respects `MAX_INTEREST_BPS`.
  - **Snapshot the LIF bps at accept if it's folded into the all-in APR.**
    `cfgLoanInitiationFeeBps` is itself mutable, so an all-in APR that includes the
    LIF must bind the LIF rate at acceptance for the figure to stay truthful.

Alternatives considered (and why A wins):

- **B — raise the existing reserve factor** (`TREASURY_FEE_BPS`) instead. Simplest
  (no new mechanism), and it's the DeFi-canonical form. But it's **lender-side** —
  it reduces lender yield, it does not charge the borrower. If the explicit goal is
  borrower-side revenue, B doesn't achieve it. (If the goal is just "more protocol
  revenue, don't care which side," B is the lowest-complexity choice.) Note: today
  `setFeesConfig` writes `protocolCfg.treasuryFeeBps` and settlement reads it
  **live**, so a raise applies to **existing** loans, not just new ones — if that
  retroactivity is undesirable, B would also need an accept-time snapshot of the
  reserve factor (a behaviour change of its own).
- **C — the literal proposal: a flat +0.5% APR as a distinct third line.** Modest
  and transparent in isolation, but it's the 3-fee-stack / regressive / non-standard
  *form* problem above. If chosen anyway, at least express it as a **% of the lender
  rate** (e.g. +5% of R) rather than flat bps, so it scales proportionally and isn't
  regressive.

Net: **Option A** — a single disclosed platform APR with a capped, default-off,
admin→governance spread knob — captures the same borrower-side revenue the idea
wants, at a magnitude that stays well under peer norms, **without** the opaque
three-fee stack. The flat-0.5% magnitude is fine; it's the *packaging* that should
change.

(Retail policy: present this purely as a platform fee / APR — no staking,
securities, or yield-promise framing.)

---

## Appendix — the full menu of fees peers charge (what Vaipakam *could* levy)

Beyond the borrower APR question, here is the broader catalogue of fee types
major DeFi / DEX / lending venues use, mapped to whether Vaipakam already has it,
could plausibly add it (and where it would fit), or shouldn't (doesn't fit the
model / retail policy). Magnitudes are typical peer ranges.

### Already in Vaipakam (mostly tunable admin→gov knobs; the late fee is the one hard-coded exception — see notes)

| Fee type | Peer example & magnitude | Vaipakam today |
| --- | --- | --- |
| **Reserve factor** (% of interest → treasury) | Aave/Compound **10–25% of interest** | `TREASURY_FEE_BPS` = **1% of interest** (lender-side), tunable knob. Lots of headroom to raise. |
| **Origination fee** (one-time % of principal) | P2P **1–8%**, Maple bespoke | `LOAN_INITIATION_FEE_BPS` = **0.1%**, tunable knob. Borrower-side. Default path charges it in the **lending asset**; only when the borrower opts into the VPFI discount path is it paid in VPFI and partly rebated — tier-0 / missing-oracle-or-config / insufficient-vault-VPFI borrowers pay the full fee with no rebate. |
| **Liquidation handling** (% of proceeds → treasury) | Aave **liquidationProtocolFee** = a cut of the bonus | `LIQUIDATION_HANDLING_FEE_BPS` = **2% of proceeds**, tunable knob |
| **Liquidation discount / bonus** (borrower-paid liquidator incentive) | Aave/Compound **5–15%** liquidation bonus | **Already implemented and configurable** — tier liquidation discounts in `LibVaipakam` + `RiskFacet.triggerLiquidationDiscounted`, toggled by `ConfigFacet.setDiscountPathEnabled` and set per-tier via `setTierLiqDiscountBps` (the discount the liquidator receives, borne by the defaulting borrower). |
| **Late / penalty fee** (overdue) | varies | `LibVaipakam.calculateLateFee` — **hard-coded** 1% + 0.5%/day, capped at 5%. NOT a `ProtocolConfig` knob today; making it tunable would itself be a small change. |
| **Matcher / keeper reward** | Gelato/CL Automation service fees | `LIF_MATCHER_FEE_BPS` = 1% of LIF to the keeper, tunable knob |

### Standard peer fees Vaipakam could ADD that fit its model

| Candidate fee | Peer example & magnitude | Where it would fit in Vaipakam |
| --- | --- | --- |
| **Protocol slice of the liquidation discount** | Aave routes part of the liquidation bonus to treasury (`liquidationProtocolFee`) | The borrower-paid liquidation discount already exists (above); what's *not* yet taken is a **treasury slice of that discount**. Could add alongside the 2% handling fee (RiskFacet / DefaultedFacet). |
| **Early-exit / loan-sale fee** (lender exits before term) | secondary-market / vault **exit fees** | A fee on `EarlyWithdrawalFacet` (lender selling the loan via buy-offer) and/or `PrecloseFacet` obligation transfer |
| **Refinance / extension fee** | rollover fees | A small fee on `RefinanceFacet` / auto-refinance and term-extension paths |
| **Auto-lend performance fee** (% of yield earned by automation) | Yearn **20% performance + 2% management**, Maple management fees | A performance cut on keeper-earned auto-lend (#625) interest — the closest analog to a vault performance fee |
| **NFT-rental origination / platform fee** | OpenSea-style **~2%** marketplace fee | A platform fee on NFT-rental loan originations (the rental product), distinct from the ERC-20 LIF |
| **Borrower platform spread** (the #785 idea) | Sky/Maker stability fee *is* the borrow APR; bank net-interest-margin | **Option A** above — a single disclosed platform APR |

(A cross-chain buy spread was considered but dropped: there is no `VpfiBuyAdapter`
in the current `contracts/src` tree, so there's no live buy flow to mark up.)

### Fees that DON'T fit (model / policy mismatch — not recommended)

- **Swap/trading fee (bps on notional)** and **perp taker/maker + funding/borrow
  fees** (Uniswap / dYdX / GMX): Vaipakam isn't a spot DEX or a perps venue; its
  only swaps are liquidation routes through external aggregators (0x/1inch), whose
  fees are already the aggregator's, not Vaipakam's.
- **User-facing flash-loan fee** (Aave 0.05%): Vaipakam uses flash loans internally
  for liquidation but doesn't *offer* user flash loans — nothing to charge unless
  that product is added.
- **Subscription / membership / gas-token-gating**: rare in DeFi and cuts against
  the retail permissionless posture (no KYC/identity gating per retail policy).

**Takeaway:** the highest-leverage, lowest-friction levers Vaipakam already owns
are (1) **raising the reserve factor** (1% → peers run 10–25%) and (2) the
**origination fee** (0.1% → peers run 1–8%) — both are existing, well-understood,
single-mechanism knobs. New *borrower-side* revenue is best added as the **Option A
platform spread** rather than a third stacked APR line. Liquidation-side, auto-lend
performance, early-exit, and rental-origination fees are all legitimate, model-fit
candidates to layer in later — each as its own capped, default-off, admin→gov knob,
and each disclosed on the surface it applies to (avoid silent effective-cost drift).

## Sources

- [Aave interest rate model / reserve factor — RareSkills](https://rareskills.io/post/aave-interest-rate-model)
- [Aave Protocol Parameters dashboard](https://aave.com/docs/resources/parameters)
- Magnitudes for P2P origination fees, DEX notional bps, and TILA all-in-APR
  disclosure are from general domain knowledge (stable, as of the 2026 knowledge
  cutoff); exact per-asset reserve factors fluctuate and should be re-checked on the
  live dashboards if a precise peer number is needed.
