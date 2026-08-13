# Full tariff: say when your ceiling has been overtaken

Opting into the Full VPFI tariff asks you to authorize a ceiling — the most
tariff you are willing to pay. The card seeds that ceiling from the first
quote it sees, with a little headroom, and then leaves it alone so a
background refresh can never overwrite a number you typed.

The quote itself keeps refreshing while you read. If it climbs past your
ceiling, you are no longer going to get the Full tariff you asked for: the
protocol refuses a tariff above the amount you authorized, or — if you ticked
the box allowing it — opens the loan without Full instead. Until now the card
said nothing about either outcome, even though both numbers it needed were
already on screen. The first you would learn of it was a rejected wallet
confirmation, or a loan that quietly opened without the discount.

The card now notices, states both figures plainly, and offers a single
action to raise your ceiling to fit the current quote. If you have NOT ticked
the box that permits opening without Full, signing is held while the mismatch
stands, so an acceptance that cannot succeed is never sent. If you have ticked
it, signing proceeds — that box says to open the loan without Full in exactly
this situation, and the notice is there so the choice is an informed one
rather than a surprise. Your typed ceiling is still never changed behind your
back: raising it stays your decision, made with the two numbers in front of
you.

Unticking the option to open the loan without the Full tariff remains
available throughout, and the notice names that as the other way forward.

## Two refinements that came out of review

Signing is held only when you have *not* ticked the box that says to open the
loan without the Full tariff if it cannot be charged. That box already promises
the loan will still open in exactly this situation, so refusing to sign would
have broken a promise you relied on — and the protocol itself is happy to open
the loan that way. You are still told the figures have moved either way.

The check is also repeated at the moment of signing, against a freshly read
quote, rather than trusting what the screen knew when you clicked. A quote that
moves during the few seconds of pre-flight checks would otherwise slip through
to your wallet, which is the whole thing this change exists to stop.
