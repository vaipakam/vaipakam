## Thread — Internal-match lender-side lifecycle (PR #585)

When a loan is cleared by internal-liquidation matching, the lender's
matched proceeds were deposited into the original lender's protocol-held
vault but no claim record was created, and the lender claim path refused
internally-matched loans. If the lender had transferred their position to
a new holder, that holder had no way to retrieve the proceeds — and the
original lender could not either, because protocol-tracked vault balances
have no user-facing withdrawal. The funds were stranded and the loan was
left stuck in the internally-matched state, since the borrower's own
residual claim had been deliberately prevented from settling the loan
while this lender-side gap remained.

This change closes the lender side through the ordinary lender claim path.
A full internal match now records the matched proceeds as a lender claim
owed to the **current** holder of the lender position. That holder claims
them the same way they would on any resolved loan: the claim is
NFT-owner-gated and sanctions-screened on the recipient, pays out of the
protocol-held custody (so the original lender, once transferred away,
cannot take them), burns the lender position, and settles the loan once
both sides have cleared. The borrower and lender claims are now symmetric
and order-independent — whichever party claims last settles the loan — and
an exactly-collateralized match (no borrower residual) settles on the
lender claim alone. The earlier deferral that blocked the borrower's
residual claim from settling an internally-matched loan is removed, since
the natural two-sided settlement now composes correctly.

This covers every non-topped-up internal match. A fallback-pending loan
carrying an extra collateral top-up stays excluded from matching as
before; reconciling that split-custody case is tracked as a separate
follow-up (Part B — the top-up-aware unwind). Closes #585.
