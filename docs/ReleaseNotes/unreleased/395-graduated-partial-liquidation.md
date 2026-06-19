### #395 — Graduated partial-liquidation sizing ("liquidate only as much as needed")

Intentional partial liquidation already restored an unhealthy loan to health by
selling the smallest collateral slice the keeper chose — but nothing stopped a
keeper from selling a *bigger* slice than the position needed, which is harsher
on the borrower than necessary. This change adds a borrower-protective guardrail
so a routine partial can't over-liquidate, while still letting a keeper act
decisively when a position is badly underwater or about to leave un-recoverable
dust.

After a partial, the loan's resulting health is now checked against a governance
**target ceiling** (default: health factor 1.20). If the partial left the
borrower comfortably healthier than that ceiling — i.e. it sold more than needed
— it is rejected and the keeper must pick a smaller slice. The ceiling is
**waived** in two cases so solvency and dust-cleanup are never blocked:

- **Deep underwater** — if the position was already below a configurable health
  threshold (default 0.95) before the partial, the keeper may delever
  aggressively to restore solvency.
- **Pre-existing dust** — if the position was *already* tiny at entry (its debt
  or collateral worth less than a configurable dust floor, default ~$1,000), the
  ceiling is waived so a genuinely-small loan isn't blocked from clearing. This
  keys off the position's size *before* the partial, never the leftover after it,
  so a keeper can't manufacture a tiny leftover by over-selling and bypass the
  guard; a larger position that can't be partialled cleanly simply falls back to
  full liquidation.

This only governs *how much* collateral a partial may sell; it never changes how
the loan is priced, and full liquidation remains available unchanged as the
alternative path. The existing dynamic liquidator bonus and the per-loan
bad-debt handling were reviewed against current best practice and kept as-is —
they already match it.

Three new governance parameters (target-HF ceiling, deep-underwater threshold,
dust floor) are set together via a single admin call, each range-checked; all
default to sensible values so the feature is active out of the box without any
configuration.
