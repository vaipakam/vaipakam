## Connected app — three more lookups stop showing the previous answer (PR #1754)

Continues the change in PR #1753 across three further on-chain lookups: whether
the auto-lend feature exists on the current network, whether a wallet is
sanctions-flagged, and the risk figures behind each loan row. All three kept
their answer in place while a new one was being fetched, and corrected it only
after the page had drawn — so for a frame each showed the previous question's
answer against the new question.

What that looked like in each case. The auto-lend check drives whether the page
invites you to create an intent or tells you the feature is unavailable on this
network, so switching networks briefly showed the wrong one of those two. The
sanctions check is the sharper one: a previously checked address's "not flagged"
result sitting against a newly connected wallet reads as a clean bill of health
for an address nobody had checked yet. And the loan risk figures are per-network
per-loan quantities, so a set computed against one deployment could be shown
against another — and health factor is what the row colouring and the
liquidation warning are drawn from.

Each lookup now labels its answer with the whole question it answers — which
network, which address or loan set — and works out at drawing time whether that
label still matches what is being asked. It reports "still loading" when it does
not, and discards the answer entirely when the lookup is torn down, so re-asking
the same question after a pause reads as loading rather than as the answer from
before the pause.

The sanctions check keeps its existing convention that a loading result reports
"not flagged"; callers are expected to wait for loading to clear before acting,
and that has not changed.
