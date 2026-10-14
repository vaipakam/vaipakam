## Loan page — settlement is stated only when it has happened (#2466, #2470)

On an internally matched loan whose claims had not been collected, the "Owed" line read "Nothing — this loan is closed and settled", directly above the button to collect those claims. The protocol settles such a loan only once its claims are collected. The line now says the internal match closed the loan and that it settles once its claims are collected. Translated in the nine translated languages.

Separately, the loan page could briefly show an out-of-date status. It checks the chain directly while a loan is open. Once the indexer recorded the loan as closed, that check stopped, but its last answer was still used. A loan the indexer already knew was settled could therefore show as merely repaid until the page was reloaded. The page now uses a live answer only while the check is running and has not failed, and the status badge, the actions and the claim lines all use that same answer.

Closes #2466. Closes #2470.
