## Thread — Auto-lend Phase 2c: keeper auto-fills standing lender intents (PR #<n>)

Part of #625 (auto-lend = the LenderIntent layer; see the design card). Phase 2a
gave the keeper a discovery feed of funded, active lender intents; Phase 2b gave
it a gas-free, exact preview of whether one fill would succeed. This step closes
the loop: the production keeper now **automatically fills** those intents.

What's new — the keeper's matching tick gains a second pass:

- After its existing Range-Orders `matchOffers` pass, the keeper pages the funded
  active lender intents and, for each, scans the borrower offers it already
  hydrated this tick for a fillable counterparty. It pre-filters cheaply on the
  conditions the on-chain fill enforces — same asset pair, the borrower's term
  within the lender's maximum, the borrower honouring full-term interest and
  no-partial-repay, the lender's rate floor at or below the borrower's rate
  ceiling, and not a self-trade — then **sizes the fill** from both sides'
  bounds: at least the larger of the intent's dust floor and the borrower's
  minimum, and at most the smallest of the intent's remaining exposure headroom,
  its un-lent funded capital, and the borrower's remaining capacity. An
  all-or-nothing borrower pins the fill to its full amount.
- It then confirms the sized fill with the gas-free `previewIntent` view and only
  submits `matchIntent` when the preview says it will succeed — so the keeper
  never spends gas on a fill the protocol would reject. The keeper is the solver,
  so it earns the same 1% matcher kickback as on the offer-match path. A
  keeper-gated intent the keeper isn't delegated to fill is simply skipped (the
  preview reports it).
- The pass shares the matcher's existing safety rails: the per-chain wall-time
  budget (so a busy book can't starve other chains in a cron tick) and per-tick
  caps on preview reads and submissions. The same master kill-switches that gate
  `matchOffers` also gate `matchIntent` (the matcher machinery flag plus the
  lender-intent flag) — both default off until governance enables them, and the
  keeper logs the disabled state once and keeps polling.

This is purely additive keeper behaviour reusing the on-chain views and the same
hydrated order book; it changes nothing about how intents are funded, priced, or
settled. The companion **auto-roll** pass (re-deploying a repaid intent loan's
proceeds into the next fill) lands in the following step.
