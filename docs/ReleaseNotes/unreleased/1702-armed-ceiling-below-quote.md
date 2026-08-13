# Standing offers: warn when your tariff ceiling is already below the quote

A lender or borrower who arms a standing offer with the Full VPFI tariff
authorizes a ceiling — the most tariff they are willing to pay when the offer
is eventually filled. Until now the form checked only that the number was
well formed. It did not check it against the live quote sitting next to it.

So it was possible to save a strict authorization whose ceiling the quote had
already passed. Nothing looked wrong. Every later fill against that offer
would then be rejected, and the rejection landed on the person trying to
accept it — someone who had done nothing wrong, could not fix it, and had no
way to see why. The offer's creator, meanwhile, was not there to notice.

The form now says so, naming both the live quote and the ceiling about to be
authorized, and states plainly that fills would be rejected while that holds.

It does not stop you saving. What the protocol judges is the quote at the
moment of the fill, and that may fall back below your ceiling before anyone
accepts — so the form treats this the same way it already treats a vault
balance below the quote: it tells you, and leaves the decision with you.
