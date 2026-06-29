## Thread — Keeper/automation best-effort limits made persistent and keeper-state visible (PR #__)

Auto-lend, auto-roll, auto-extend, and auto-refinance are best-effort automation
surfaces, not guarantees: if the keeper is paused, disabled, unauthorized, or no
compatible counterparty exists, a loan can still default. Users can mistake an
enabled automation toggle for a guaranteed rescue. The pre-grace warning banner
(#545) and the Alerts CTA (#546) already covered part of this; this change
closes the remaining gaps.

What changed:

- **Auto-lend intent card** — now carries a persistent best-effort notice
  (visible at enablement and while enabled). It distinguishes the two halves:
  fills depend on matching borrower demand within the lender's bounds and need
  no protocol keeper for open intents (any solver may fill — only
  keeper-restricted fills need one), whereas auto-roll of repaid loans is the
  keeper-dependent part. So capital may sit idle, deploy, or stop rolling, and
  the lender stays responsible for monitoring. The card already surfaced the
  fill-path and keeper-access kill-switch banners; this adds the standing
  best-effort framing, plus a banner for the live global delegated-keeper pause
  (auto-roll + keeper-restricted fills suspended while paused; open intents stay
  fillable by any solver).
- **Auto-lifecycle caps card** — the best-effort warning is now **persistent
  while a cap is active**, not just shown during the false→true enable
  transition (it previously disappeared on save). It is keyed on the saved
  on-chain state too, so it stays up during a pending (unsaved or failed)
  disable while the cap is still live. So a borrower/lender keeps seeing that
  auto-refinance / auto-extend is best-effort and not default protection for the
  life of the cap.
- **Keeper kill-switch visibility on the caps card** — when the **borrower**
  holder's master keeper switch is off, OR keeper automation is **globally
  paused** by governance (both unambiguous hard gates — auto-refinance and
  auto-extend execute against the borrower side and `requireKeeperFor` rejects
  every keeper call while paused), the card warns that any enabled cap is inert
  until keeper automation can run again: the master switch on, a keeper approved
  with the right permissions, AND that keeper enabled for this specific loan via
  the per-loan toggles (and a global pause lifted by governance). The two gates
  have different audiences: the master-switch case warns only the borrower
  holder, but the global-pause case warns BOTH the borrower and the lender
  holder, since a global pause makes a lender's own enabled auto-extend cap
  equally inert. The lender's own keeper switch is not treated as a blocker (the
  lender's extend-caps are only their consent surface), and the warning does not
  infer inertness from the approved-keeper count.

New component tests cover the keeper-unavailable warning (both directions) and
the persistent best-effort warning while a saved cap is enabled.

Spec: `docs/FunctionalSpecs/WebsiteReadme.md` — the auto-lend card persistent
best-effort notice, the caps-card persistent (not transition-only) warning, and
the caps-card keeper kill-switch visibility intent.

Closes #799.
