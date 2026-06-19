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
- **Pre-existing dust** — when governance has switched dust handling on (it is
  off by default), a position that was *already* tiny at entry (debt or
  collateral below the dust floor) isn't blocked from clearing. This keys off
  the position's size *before* the partial, never the leftover after it, so a
  keeper can't manufacture a tiny leftover by over-selling and bypass the guard.

When dust handling is on, the reverse is also enforced: a routine partial may
**not** *leave* a fresh tiny position (both leftover debt and collateral below
the floor) out of a normal loan — it must use full liquidation instead, so no
un-liquidatable scrap is stranded. Dust handling is **off by default** because
the right floor depends on the active price numeraire, which a deployment can
rotate away from US dollars; governance sets an explicit floor to turn it on.

Finally, an intentional partial now **defers to the internal-match priority
window** exactly as full liquidation does — a keeper can no longer use a partial
to sell collateral externally while an internal match still has priority.

This only governs *how much* collateral a partial may sell; it never changes how
the loan is priced, and full liquidation remains available unchanged as the
alternative path. The existing dynamic liquidator bonus and the per-loan
bad-debt handling were reviewed against current best practice and kept as-is —
they already match it.

Three new governance parameters (target-HF ceiling, deep-underwater threshold,
dust floor) are set together via a single admin call, each range-checked; all
default to sensible values so the feature is active out of the box without any
configuration.
