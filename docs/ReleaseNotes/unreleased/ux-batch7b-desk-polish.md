### Rate Desk polish — readable ladder, honest fill %, clearer chips and match band (UX-028 / UX-036 / UX-037 / UX-038 / UX-045 / UX-046)

A batch of Rate Desk readability and honesty fixes:

- **Ladder scanability + accessibility (UX-028).** The rate column is now
  the clickable pick target (a real button) instead of the whole row
  wrapping the Take/Fill actions — so those controls are no longer nested
  inside another interactive element. Rate, size, and depth columns
  right-align with fixed-width figures, and rates show a consistent two
  decimals so the decimal points line up down the book. The ask/bid rates
  drop the alarm red / success green for a neutral colour — a resting
  lender offer isn't an error — with the side carried by the section
  labels and position. Your own resting order now announces itself to
  screen readers.

- **Honest fill percentage (UX-046).** A partly-filled open order used to
  truncate its progress (99.6% → "99%", a sliver → "0%" beside a visible
  bar). It now rounds, shows "<1%" for a barely-started fill and "99%+"
  for an almost-complete one, and states how much size is still left.

- **"Depth" instead of Σ (UX-038).** The cumulative-depth column header
  reads "Depth" (keeping its explanatory tooltip) instead of a bare Σ.

- **Match band gas note (UX-045).** The crossable-match band now says you
  pay the network gas to execute the match, alongside earning the matcher
  fee.

- **Clearer tenor chips (UX-036).** A term with live offers is marked with
  a small "live" dot rather than a heavy border that read as a second
  selection beside the actually-selected term.

- **Chart credit only when a chart draws (UX-037).** The TradingView
  attribution shows only when a rate chart actually renders, not on the
  pick-a-market / loading / empty states where nothing is drawn.
