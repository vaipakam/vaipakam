## Thread — The grace-over notice stops promising an automatic close (PR #TBD)

The lender's notice on a loan whose grace period has ended used to say the default "normally happens automatically shortly after". Nothing guaranteed that. The keeper's automatic close-out is switched on per deployment by a setting the app cannot read, and even where it runs it deliberately leaves some loans open: those with no working swap venue, an accepted loan sale, or collateral that moved after quoting.

The notice now says what is true everywhere. The lender can close the loan out themselves from the overdue-loan card on the same page when that card is shown, and anyone else may do it first. The collateral claim appears once the loan is closed. The comment above the string, which still said the app had no close-out action, now matches the card that exists. All nine translated locales carry the new wording.

Closes #2484.
