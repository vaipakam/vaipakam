### #399 — Treasury-seeded backstop, v0 Role A (counterparty-of-last-resort)

The platform now has an optional, protocol-funded backstop that can step in as the
lender when a borrower's offer would otherwise sit unmatched. It is governance-run,
funded only from treasury capital, and off by default behind two independent
kill-switches.

How it works for a borrower: when posting a borrow offer, the borrower can opt it
into backstop eligibility by setting a future deadline (which must be a genuine
interval after posting and before the offer expires). If no ordinary lender takes
the offer by that deadline — and the offer is still valid, unfilled, and backed by
liquid, oracle-priced collateral within the protocol's risk limits — anyone can
trigger the backstop to fund it from treasury at the backstop's posted terms. The
borrower gets last-resort liquidity; the backstop becomes the lender of record and
later recovers the repaid principal and interest back to the treasury.

Governance controls every parameter: a master pause and a separate Role-A switch
(both default off), per-asset capacity caps, the posted backstop rate, the
collateral types the backstop will accept, and the minimum wait before a backstop
fill can fire. The backstop holds its capital in its own isolated vault, never
commingled with ordinary user deposits, and only ever lends against the specific,
governance-vetted collateral assets it is configured for — a borrower cannot get
funded against an arbitrary or illiquid token.

This is the first half of the backstop. The liquidator-of-last-resort half (the
backstop buying out a stuck, thin-market liquidation to make a lender whole) is a
separate follow-up. Both remain off until governance explicitly enables and seeds
the backstop.
