### #630 — Treasury-seeded backstop, v0 Role B (liquidator-of-last-resort)

The protocol backstop now has its second half: a cash buyout that can make a
lender whole when a liquidation fails and the loan is stuck holding collateral
nobody will swap. It is governance-run, treasury-funded, and off by default
behind its own kill-switch — independent of Role A's, so the riskier buyout can
be paused on its own.

How it works: when a liquidation's market swap fails, the loan enters a
"fallback pending" state and the protocol holds the collateral, with the borrower
still able to cure (top up or repay) until the lender acts. The lender (the
current holder of the lender position) can now opt that loan into a backstop cash
exit. Once opted in, the protocol's designated keeper can execute the buyout: the
system first tries one more time to resolve the loan on the open market (an
internal match against an opposing loan, plus a best-effort swap) — if that
works, no backstop money is spent and the lender is paid the proceeds normally.
Only if the market still can't clear does the backstop step in: it pays the
lender their principal-plus-fees due in cash from a dedicated treasury-funded
bucket, takes the lender's slice of the collateral to warehouse and sell later,
and routes the treasury and borrower slices exactly as a normal settlement would.

The buyout is deliberately conservative and self-protecting:
- It only pays out if the collateral slice it receives is worth at least the cash
  it pays (priced by the protocol's own oracle, with a dust tolerance) — an
  underwater or unpriceable position is refused, and the lender simply uses the
  ordinary in-kind claim instead.
- Governance sets a per-asset-pair cap on how much cash the backstop can have
  tied up in unsold collateral at once, and seeds a finite cash bucket — together
  bounding the protocol's exposure.
- Loans that received a borrower collateral top-up are excluded and routed to the
  normal claim, so the top-up is never mis-handled.
- The lender keeps their normal self-service claim at all times; the cash exit is
  strictly an additional option, never worse for them.

When the warehoused collateral is later sold back to cash (or written off by
governance), a governance action records that realized return and frees the
corresponding exposure headroom for future buyouts.

This completes the v0 backstop. Both halves stay inert until governance enables
and funds them. The pooled-LP / first-loss version remains a separate future
effort.
