## Connected app — signing now requires consent given against every disclosure on screen (PR #TBD)

Before signing an offer, the review screen can raise several different
warnings, and some of them only appear once the app has fetched the answer:
the token-security verdicts, an illiquid-collateral warning, notice that the
offer being accepted is a position sale rather than a fresh loan, and changes
to that sale's terms. The rule has always been that consent must be given
against what is actually shown — if a warning appears after the box was
ticked, that tick predates the disclosure and has to be given again.

That rule was fully enforced for the token-security warnings only. For those,
signing checks that the consent on file was given against the warnings
currently displayed. The other three disclosures relied on a follow-up pass
that unticks the box after the fact, and signing merely waited for the answer
to be *known* rather than for consent to *postdate* it. On the moment a late
disclosure arrived, that left a single frame in which the warning was on
screen, the box was still ticked, and signing was still offered.

The window is one frame wide, and the sign button had been disabled until the
answer arrived, so reaching it required a click landing in exactly that
instant. It has not been observed happening. It is nonetheless the same defect
the security check was added to prevent, so all four disclosures are now
covered by one check: the tick records everything that was on screen when it
was given, and signing requires that record to match what is on screen now.
Anything disclosed later invalidates it immediately rather than a beat later.

Practical effect: unchanged for anyone reviewing an offer whose warnings have
already loaded. If a warning arrives while you are looking at the screen, the
consent box clears and signing is unavailable until you tick it again —
which is what the previous behaviour intended, a fraction of a second sooner.

Folding a future disclosure into this check is now a one-line change, so the
next one cannot be added without the protection.
