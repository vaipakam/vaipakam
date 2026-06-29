## Thread — Keeper/automation best-effort limits made persistent and keeper-state visible (PR #__)

Auto-lend, auto-roll, auto-extend, and auto-refinance are best-effort automation
surfaces, not guarantees: if the keeper is paused, disabled, unauthorized, or no
compatible counterparty exists, a loan can still default. Users can mistake an
enabled automation toggle for a guaranteed rescue. The pre-grace warning banner
(#545) and the Alerts CTA (#546) already covered part of this; this change
closes the remaining gaps.

What changed:

- **Auto-lend intent card** — now carries a persistent best-effort notice
  (visible at enablement and while enabled) stating that fills and auto-roll
  depend on matching borrower demand within the lender's bounds and an enabled,
  funded protocol keeper, so capital may sit idle and the lender stays
  responsible for monitoring. The card already surfaced the fill-path and
  keeper-access kill-switch banners; this adds the standing best-effort framing.
- **Auto-lifecycle caps card** — the best-effort warning is now **persistent
  while a cap is enabled**, not just shown during the false→true enable
  transition (it previously disappeared on save). So a borrower/lender who
  enabled a cap keeps seeing that auto-refinance / auto-extend is best-effort and
  not default protection for the life of the cap.
- **Keeper kill-switch visibility on the caps card** — when the connected
  holder's keeper cannot act (keeper master switch off, or no keeper approved),
  the card now warns that any enabled auto-refinance / auto-extend cap is inert
  until keeper access is restored, because those actions are keeper-executed.
  Loan Details derives this from the per-side keeper status it already reads.

New component tests cover the keeper-unavailable warning (both directions) and
the persistent best-effort warning while a saved cap is enabled.

Spec: `docs/FunctionalSpecs/WebsiteReadme.md` — the auto-lend card persistent
best-effort notice, the caps-card persistent (not transition-only) warning, and
the caps-card keeper kill-switch visibility intent.

Closes #799.
