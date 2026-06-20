### #594 (PR 2/3) — auto-consolidate a transferred position on borrower-side actions

PR 1 shipped the consolidation primitive plus the proactive
`consolidate…ToHolder` entry points. This PR makes consolidation **automatic**
on the borrower side: whenever the current holder of a transferred position
performs an active borrower action, the protocol first pulls that loan's
collateral into the holder's own vault (re-keying the lien and re-pointing the
loan's custody anchor) so the action then operates on an ordinary loan instead
of the keep-collateral-in-the-original-vault special case.

Wired into the borrower-side mutations:

- **Partial collateral withdrawal** and **add-collateral** (the latter
  *after* its FallbackPending cure, so a just-cured loan consolidates) — the
  collateral now lives in the holder's vault before the withdraw/top-up math.
- **Partial swap-to-repay** — the swap operates on the holder's consolidated
  vault.
- **Swap-to-repay intent commit** — consolidates before the commit pulls the
  collateral into protocol custody.
- **Swap-to-repay intent cancel / force-cancel** — consolidates *after* the
  teardown returns the collateral, which otherwise re-strands it in the
  departed owner's vault for a transferred position.

For a position that has **not** transferred, every hook is a no-op (a single
ownership check), so existing flows are unchanged — confirmed by the full
existing test suites for the touched facets passing untouched.

Sanctions safety is **conservative-safe**. Moving a transferred position's
collateral *out* of its (possibly later-flagged) original vault to the current
holder is allowed — that is the de-risking direction the policy wants. But the
protocol never *credits or strands* funds in a flagged vault: in the narrow
cases where the consolidation itself can't run in the same action — a
FallbackPending top-up too small to cure, or an intent cancel while a prepay /
parallel-sale listing is still recorded — and the original anchor has since been
sanctioned, the host action **reverts** rather than depositing into that flagged
vault (the funds stay put — in the borrower's vault or in Diamond custody —
nothing is lost). Letting those actions proceed for a flagged-and-stale anchor
is a tracked liveness follow-up (#658); all of it is dormant until the sanctions
oracle is configured.

When a transferred position is collateralised in VPFI, the holder's VPFI
fee-tier and staking credit are re-stamped *after* the withdraw/swap/commit, so
they never carry credit for VPFI that has left their vault.

The full swap-to-repay and the prepay-listing creation paths are wired in the
remaining PRs / follow-up (see #656); lender-side and both-side close-out
wiring lands in PR 3.
