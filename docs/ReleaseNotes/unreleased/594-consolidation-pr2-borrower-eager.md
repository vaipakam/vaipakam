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
existing test suites for the touched facets passing untouched. Consolidation
never blocks the host action: if the holder is sanctioned or the position is in
an excluded state, consolidation simply skips and the action proceeds under its
own rules.

The full swap-to-repay and the prepay-listing creation paths are wired in the
remaining PRs / follow-up (see #656); lender-side and both-side close-out
wiring lands in PR 3.
