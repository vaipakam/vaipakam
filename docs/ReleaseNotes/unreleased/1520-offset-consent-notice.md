# Offset: say why the acknowledgement cleared

Posting an offset asks the borrower to tick an acknowledgement that they
have reviewed the funding figures. Those figures refresh on a timer, and
when they move the tick is cleared so consent can never cover numbers the
borrower did not see.

Until now that clearing happened silently. The box the borrower had just
ticked would untick itself with no stated reason — and because the figures
refresh on a timer, it could happen more than once while they were still
reading. The likely reading is a broken checkbox, so the borrower re-ticks
without understanding that the numbers underneath changed.

The offset card now shows a short notice when this happens, saying the
figures moved while they were reviewing and asking them to tick again
against the current numbers. The notice appears only if an
acknowledgement was actually ticked, so an untouched card stays quiet, and
it goes away as soon as the borrower re-ticks or the post completes.

This matches how the early-exit review already handles its own drifting
payout, so the two borrower surfaces now explain the same event the same
way instead of one of them doing it silently.
