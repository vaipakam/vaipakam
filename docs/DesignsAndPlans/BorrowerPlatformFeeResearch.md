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

So **today the borrower's all-in cost** on a healthy loan = agreed interest
(full-term floor, see #784) **+ 0.1% LIF (partly rebated)**. The 1% treasury cut
is borne by the **lender**, invisible to the borrower.

Adding the proposed **+0.5% APR** introduces a *new, third* mechanism and — unlike
the treasury cut — it is **borrower-facing**. Worked example, lender rate `R`,
principal `P`, term `t` days:

| Lender rate R | Borrower interest (full-term) | + LIF 0.1% (one-time) | + **NEW 0.5% APR** | Borrower effective APR | New fee as % of interest |
| --- | --- | --- | --- | --- | --- |
| 5% | 5%·P·t/365 | 0.1%·P | 0.5%·P·t/365 | ~5.5% + LIF | **10% of interest** |
| 10% | 10%·P·t/365 | 0.1%·P | 0.5%·P·t/365 | ~10.5% + LIF | **5% of interest** |
| 20% | 20%·P·t/365 | 0.1%·P | 0.5%·P·t/365 | ~20.5% + LIF | **2.5% of interest** |

Two observations:

- **It stays competitive in magnitude.** +0.5% APR is small next to peers' 10–25%
  reserve factors. Vaipakam would remain one of the cheapest venues even with it.
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

Alternatives considered (and why A wins):

- **B — raise the existing reserve factor** (`TREASURY_FEE_BPS`) instead. Simplest
  (no new mechanism), and it's the DeFi-canonical form. But it's **lender-side** —
  it reduces lender yield, it does not charge the borrower. If the explicit goal is
  borrower-side revenue, B doesn't achieve it. (If the goal is just "more protocol
  revenue, don't care which side," B is the lowest-complexity choice.)
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

## Sources

- [Aave interest rate model / reserve factor — RareSkills](https://rareskills.io/post/aave-interest-rate-model)
- [Aave Protocol Parameters dashboard](https://aave.com/docs/resources/parameters)
- Magnitudes for P2P origination fees, DEX notional bps, and TILA all-in-APR
  disclosure are from general domain knowledge (stable, as of the 2026 knowledge
  cutoff); exact per-asset reserve factors fluctuate and should be re-checked on the
  live dashboards if a precise peer number is needed.
