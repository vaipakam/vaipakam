## Connected app — the loan detail page no longer shows the previous loan (PR #1757)

Opening a loan's detail page, then navigating to a different loan, showed the
first loan's parties, amounts and status under the second loan's heading until
the new read finished. The page did try to avoid this — it set itself to a
loading state when the read began — but that happened just after the page had
already drawn, which is the frame the loading state was meant to cover.

The read now labels its answer with the loan it was fetched for and the page
decides at drawing time whether the label matches what is on screen. Where it
does not, the page reports loading rather than the previous loan's figures.
Leaving a loan and returning to it re-reads rather than reusing the earlier
copy, which matters because a loan's status and outstanding amount are exactly
the fields that move while you are away.

One behaviour is deliberately preserved: on a network with no deployment, the
page still reports a settled "nothing here" rather than a permanent loading
state, so the unsupported-network banner keeps rendering as before.
