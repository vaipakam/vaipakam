## Connected app — the rental listing banner stops inheriting the previous loan (PR #1764)

The loan detail page shows a banner for an NFT rental prepayment listing, and
the actions offered alongside it depend on what that listing currently says.
Moving between loans, or switching networks, briefly showed the previous loan's
listing under the new loan — and because the banner drives which action is
offered, the borrower could be presented with an action belonging to a different
loan.

The page already tried to prevent this and said so: it cleared the listing
"immediately — BEFORE the new fetch starts". But the clearing ran just after the
page had drawn, so it shortened the window rather than removing it.

The listing now carries the loan it was read for, and the page works out at
drawing time whether it still matches. Where it does not, the banner reports
that it is loading instead of showing the earlier loan's.

Two existing behaviours are preserved deliberately. A momentary indexer outage
still keeps the last good listing for the loan being viewed, rather than blanking
the banner mid-flight — that only ever applied within one loan, and now provably
so. And the post-transaction settling rules, which decide whether a confirmed
write or a lagging indexer view wins, are unchanged; they now write against the
loan being viewed rather than against whatever the page happens to hold.
