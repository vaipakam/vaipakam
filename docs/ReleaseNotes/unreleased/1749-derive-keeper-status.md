## Connected app — the keeper status panel stops showing the previous loan's wallets (PR #1762)

The loan detail page reports whether keepers can act on each side of a loan.
That answer depends on which wallet currently holds each side's position
token — so on a page reused between loans, it must follow the loan on screen.

The page already tried to handle this: it discarded the previous loan's answer
the moment the holders changed. But the discarding happened just after the page
had drawn, so for one frame the previous loan's keeper state was displayed under
the new loan's heading — and that state drives an "actions are inert" warning
keyed to a wallet, so the warning shown could belong to someone else entirely.

The answer now carries the pair of wallets it was read for, and the page decides
at drawing time whether that pair still matches what is on screen. Where it does
not, it reports that it is still reading. The existing protection against a slow
read for the previous loan overwriting the new one is unchanged — that guard was
already correct, and this replaces only the part that ran too late.
