## Interaction rewards: durable, holder-accurate close-out at every terminal (#1067)

The platform gives out a small VPFI interaction reward for participating in a
loan. Each loan carries two reward "entries" — one for the lender side, one for
the borrower side — that accrue while the loan is open and are settled when the
loan ends. This change makes that settlement correct at **every** way a loan can
end, and makes the reward follow the **person who actually holds the position**.

**The reward now follows the live position holder.** Lender and borrower
positions are transferable NFTs — a position can be sold or moved before the
loan closes. Previously, when a loan closed, its reward entry could still be
anchored to whoever originally opened the position, even if they had since sold
it. Now, at the moment a loan reaches any terminal, each still-open reward
entry is re-pointed to the current NFT holder before it is closed — so the
reward is settled to the same party the loan's funds are settled to. This
re-anchoring is centralised in one place that every close path flows through
(normal repayment, default, liquidation, preclose, prepay-sale), so no single
path can forget it. An entry that was already closed earlier (a "frozen" slice
that a prior holder already earned) is never moved to a later holder.

**Every terminal now closes the reward durably.** Several ways of ending a loan
were not closing the reward accounting at the terminal itself, leaving it to be
inferred later from the loan's status. That inference could be dropped by a
subsequent status change and quietly pay a borrower who should have forfeited.
The reward is now closed **at the terminal**, durably, for:

- **Liquidation via internal match** — the borrower forfeits their reward
  durably; the lender keeps theirs.
- **Prepay-sale finalisation** (both the loan-keyed and offer-keyed parallel
  sale) — a proper close; neither side forfeits.
- **Full repayment by daily NFT-rental deduction** — a proper close.
- **The claim-time fallback→default force** — when a distressed loan that had
  been held in a curable "fallback pending" state is finally forced to default
  at claim time, that terminal now forfeits the borrower reward (and any
  up-front borrower fee) exactly as the other default paths do. Because
  "fallback pending" is reversible, neither was settled on the way in; both are
  now settled here, where the loan truly ends.

**Behaviour a participant can observe:** a lender who buys a loan position and
then sees it repaid or defaulted now receives (or forfeits) the reward on the
same basis as if they had held it from the start; a borrower whose position is
liquidated no longer keeps an interaction reward the rules meant to forfeit.
There is no change to how or when a user claims. The platform is pre-live, so
there is no historical reward state to migrate.

Internally, the per-holder membership lookup used by re-anchoring is now O(1),
so centralising the re-anchor onto the fund-critical close path adds no
per-close scan. On the two facets that sit at the contract-size limit
(ClaimFacet, RiskMatchLiquidationFacet) the reward close is fired as a
best-effort internal hook — reward bookkeeping never blocks a fund-moving
close, matching the existing pattern.

Part of #998. Implements `docs/DesignsAndPlans/S13InteractionRewardCloseoutAndDailyCap.md`
Part 2. Closes #1067.
