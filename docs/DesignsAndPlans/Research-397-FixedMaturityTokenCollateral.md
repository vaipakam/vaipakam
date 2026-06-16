# Research findings — #397: Fixed-maturity (yield-stripped principal) tokens as collateral

**Card:** #397 (master sweep #401, Cluster C). **Status:** findings + verdict.
**Verdict:** **DOES NOT work as-is — needs change X (a maturity-aware pricing adapter + a
term≤maturity constraint). RECOMMEND DEFER** unless there's concrete demand — it is a
differentiated-collateral play, not core, and the failure mode is catastrophic if done wrong.

> External comparison systems referenced generically per the sweep rule.

---

## 1. The card's explicit question: works-as-is, or needs change?

**Answer: needs change.** Our pipeline classifies collateral Liquid/Illiquid via price-feed +
AMM-depth and is **permissionless on liquidity alone** (no per-asset allowlist;
`OfferCreateFacet` ≈:646). A fixed-maturity principal token *looks* Liquid (it has a feed and a
pool), so it would be **admitted today** — but our HF math would mishandle it.

## 2. Why it breaks (three concrete assumptions)

Fixed-maturity "principal" tokens are zero-coupon bonds: they redeem **1:1 for an underlying at
a known maturity** and trade at a **discount that converges to par as maturity nears** (the
discount unwind *is* the fixed yield).

1. **Spot-price-only HF math.** `LoanFacet._checkInitialLtvAndHf` / `RiskFacet` value collateral
   at **current spot** via `getAssetPrice`. A token at 0.95 today that will be 1.00 at maturity
   is valued at 0.95 — HF reads **lower than it will be**, risking false liquidations; and a
   naïve par-pricing (the opposite mistake) is the catastrophic one (see §3).
2. **No maturity awareness.** Nothing tracks the maturity date. A loan whose term **outlives the
   token's maturity** hits an oracle-data discontinuity: post-maturity the token *is* the
   underlying, and a price feed keyed to the pre-maturity token can stop updating or jump.
3. **Liquidation assumes continuous swappability.** Our liquidation/DEX path needs the collateral
   tradable on a live pool. Post-maturity the pre-maturity AMM pair can be gone — the depth check
   doesn't capture this **temporal** dimension.

## 3. The catastrophic failure mode (why "done wrong" is worse than "not done")

The dominant real-world risk is an oracle that prices the token **at par regardless of real
value**. A late-2025 multi-protocol contagion (~$285M) hit isolated-lending markets whose
collateral oracles were hardcoded near $1.00 while the real price fell to ~$0.30 (one asset to
~$0.015) — **no liquidations fired** because the oracle lied. A maturity-bearing token priced at
par before maturity, or after a depeg, reproduces exactly this. The bar for accepting these is
therefore **high**, not low.

## 4. What "done right" requires (the change-X)

- **Maturity-aware pricing adapter** in `OracleFacet`, priced as
  **`min(linear-discount-to-par, live-market-price)`**. The linear-discount primitive — a discount
  factor rising linearly to 1.0 at maturity, computed purely from `block.timestamp` (no external
  call → minimal manipulation surface) — is conservative **only while the token tracks par**. If
  the token's market price **falls** after onboarding (the underlying depegs, or implied yield
  spikes), the linear-to-par curve keeps marching the price *toward par* while real value drops —
  **reproducing the exact par-pricing blowup** of §3. So the adapter must **cap the linear value
  by the live market price** (feed/AMM, run through the existing secondary-quorum + deviation
  guard, see #392) and take the lower. Linear-discount alone is necessary but **not sufficient**;
  the live-market cap is the load-bearing safety. (Dynamic TWAP-of-implied-APY oracles are more
  accurate but more manipulable; not for a first integration.)
- **Hard term constraint: loan term + grace + liquidation window ≤ token maturity.** Naively
  `loanTerm ≤ tokenMaturity` is **not enough** — a loan can default at term-end and then sit in
  its **grace period** + liquidation window *past* the nominal term, during which the collateral
  may already be **post-maturity** (the discontinuity we're trying to dodge). The bound must
  therefore be `loanTerm + gracePeriod(durationDays) + a liquidation-completion margin ≤
  tokenMaturity`, so the token is still pre-maturity through the entire worst-case close-out. If a
  loan could still outlive maturity, the adapter **must** switch to underlying-asset pricing at
  maturity **with a depeg/price-cap guard** — materially more surface. Recommend the
  grace-inclusive bound for v1.
- **Per-asset allowlist for this collateral class.** These should NOT ride the permissionless
  liquidity classifier; gate them behind an explicit, governed allowlist with a per-asset
  maturity registered on-chain.
- **Liquidation pre-check** that the pre-maturity pool is live (reuse the slippage-at-floor
  classifier) and refuses to value a post-maturity token via the pre-maturity feed.

## 5. Verdict + recommendation

**Needs change X (above). Recommend DEFER.** Rationale: (a) it is *differentiated collateral*,
not a core-flow gap — value-add, not a blocker; (b) the failure mode is catastrophic and the
correct implementation (maturity-aware adapter + allowlist + term constraint + post-maturity
handling) is a real, audit-heavy surface; (c) for a fixed-rate lender it is *conceptually* a
clean fit (a bond backing a fixed-rate loan), so it is worth doing **right, later**, not quickly.
Pairs with #392 (pricing discipline — already strong) and #398 (the inward yield-wrapper, which
#398 already verdicted SKIP-as-core; this collateral class is the only thing that would justify
even a thin inward adapter).

## 6. Spin-off implementation issue (only if prioritized)

**Maturity-aware collateral adapter:** governed per-asset allowlist with on-chain maturity +
deterministic linear-discount-to-par oracle + hard `loanTerm ≤ tokenMaturity` constraint (or
post-maturity underlying switch with a depeg guard) + liquidation live-pool pre-check. Own design
doc + heavy test matrix before any contract. **Not** scheduled unless demand is concrete.

## 7. Sources

Our `OracleFacet`/`LoanFacet`/`RiskFacet`/`OfferCreateFacet` anchors + the fixed-maturity-token
yield-tokenization precedents, their deterministic + dynamic collateral oracles, and the
late-2025 par-pricing contagion post-mortems (generic; URLs in working notes).
