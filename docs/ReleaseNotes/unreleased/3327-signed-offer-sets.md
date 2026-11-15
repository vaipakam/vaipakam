## One signature over a set of signed offers

A maker quoting several gasless offers at once, such as a ladder of rates,
had to sign each one separately. A maker can now sign up to 32 offers with a
single signature. The wallet shows that signature as a readable list of every
offer's terms rather than an opaque digest (owner decision 2026-11-15), so
the maker sees exactly what they are agreeing to.

Signing together changes nothing about how each offer lives. Every offer
keeps its own identity, fill record, deadline, expiry and protections, and is
filled, matched, previewed and cancelled on its own. A fill of one offer
carries the other offers' identities and its own place in the list, which is
what lets the signature be checked; a fill that gets either wrong is refused.
Giving every offer of a set the same nonce lets one nonce cancellation stop
the whole set. The wallet-backed fill stays limited to offers signed alone.

The off-chain book accepts each offer of a set on its own post, checks the
signature against the set it names, stores that placement with the offer and
hands it back with the order, so any taker can fill it. The nightly-backup
restore checks the stored placement the same way it checks the order. Both
apps now send an offer's placement with every fill and preview, and read a
book row that names a malformed set as unfillable.

The maker-side screen for signing a ladder in one go is a follow-up (#3653);
until then a set can be signed and posted through the book's interface
directly.

On the live testnet, signed-offer fills need the next fresh deploy, because
the fill entry points gained an argument.

Closes #3327.
