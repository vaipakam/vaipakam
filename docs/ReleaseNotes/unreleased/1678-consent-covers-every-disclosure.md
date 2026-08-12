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

Review of the first attempt found four more ways the same gap could open, and
the check is broader as a result. It now covers the fee percentages and the
grace period shown on the receipt — those arrive from the network too, and a
tick can predate them just as easily as it can predate a warning — along with
the notice shown when a token cannot be security-screened at all, and the
outcome of the dry run performed before signing. Consent is given against the
whole receipt, so the terms belong in the check and not only the warnings.

It also no longer asks whether the screen *looks* the same as when you ticked,
but whether anything has changed since. Those differ when a warning goes away
and comes back: the screen matches what was acknowledged, yet the review has
changed twice, and the older acknowledgement should not carry.

One visible change: the dry run that checks whether an offer would be rejected
now runs before the consent box is ticked rather than after. Previously its
warning could only ever appear once consent had been given — meaning that
warning always arrived too late by construction. It is now disclosed alongside
the other terms, before you agree to them.

One further case is tracked separately and is not fixed here: the Full-tariff
control paints its own "unavailable" warning a moment before it tells the
review screen, so the screen's own check cannot see it in time. That needs the
two to read the same source rather than one telling the other, and is filed on
its own.
