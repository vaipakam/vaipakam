## Thread — The grace-over notice stops promising an automatic close (PR #2494)

The lender's notice on a loan whose grace period has ended used to say the default "normally happens automatically shortly after". Nothing guaranteed that. The keeper's automatic close-out is switched on per deployment by a setting the app cannot read, and even where it runs it deliberately leaves some loans open: those with no working swap venue, an accepted loan sale, or collateral that moved after quoting.

The notice now says what is true everywhere. Automatic close-out may be switched off on the deployment, and the app cannot tell, so the lender should not wait for it. The overdue-loan card on the same page, when shown, says whether the lender can close the loan out now and what stands in the way if not; the notice does not promise self-service, because the card has blocked states with no action. Anyone else may close the loan first. Once a close-out has run, the page shows what the lender can claim and when; it no longer says the loan closes before the claim, which is backwards on the fallback route, where claiming is what ends the loan. The comment above the string, which still said the app had no close-out action, now matches the card that exists. All nine translated locales carry the new wording.

Closes #2484.
