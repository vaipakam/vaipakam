# Desk order ticket — the fill mode you picked is the one that gets posted

The rate desk's order ticket shows the fill mode in force, and posts it.

A gasless lend order can only ever fill as one whole loan, so the ticket
switches the default "Partial" to "AON" and disables the Partial chip in that
mode. Previously the ticket stored one mode and corrected it a beat later,
which left a moment where the ticket claimed partial fill in a mode that cannot
serve it — and everything read off that claim during the moment, including the
order preview and the fee estimate, described an order that could not be
posted. The mode shown is now derived from the terms rather than corrected
after the fact, so the chip and the order always agree.

While making that change we introduced, and then fixed before release, a worse
version of the same problem: the correction was applied to every mode instead of
only to Partial. A lender who chose "IOC" — immediate-or-cancel, which the
ticket still offers in this mode — would have seen AON highlighted and signed an
AON order, and the rule that an IOC order needs an expiry would have stopped
applying to it. Only Partial is converted now, matching what the posting path
itself does, and the automated desk test drives the IOC case so the same
substitution cannot return unnoticed.

Separately, switching between lending and borrowing, or between posting on-chain
and posting by signature, now clears the risk-and-terms tick immediately rather
than a moment afterwards. Those switches change what is being agreed to, and the
tick has to fall with them. For a signature-only post this matters more than it
looks: there is no second checkpoint after the signature, so the terms on screen
when the box was ticked are the only record of what the user agreed to.
