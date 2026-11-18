## Thread — Terms standing in the offer book and a wallet read (#3734)

The contracts are gaining the Terms of Service rule: a wallet that takes on a new position must have accepted, by its own transaction, a version that is in force on that network, numbered from the network's minimum version to its latest. This change gives the indexer the matching record and the book's marks, ahead of the contract events (design: TermsAcceptanceEnforcementDesign.md, sections 3, 5, 7 and 8).

Two new tables hold each network's Terms changes (publications, announcements with the time they come into force, withdrawals, comings into force) and each wallet's own acceptances with the version, fingerprint, time and transaction. Both are rebuilt from the chain and reset with a new Diamond; there is no other store of acceptances. The versions in force, the minimum and the latest are worked out from the change log when read, so an announced change counts from its time even before any later event is seen, and a withdrawn version never counts.

Every open offer in the offer lists, and every order in the signed book, now carries its maker's standing. A lending, borrowing or rental offer, an offer to buy a loan, an offset offer, and every signed order is marked not fillable now, with the reason, while its maker is not current. A lender's sale listing of its own loan is never marked by the lister's standing. Signed orders are still stored whatever the maker's standing; they read as fillable once the maker's acceptance is indexed. While no version is in force nobody is marked.

A new read, `/terms/{address}?chainId=`, answers one wallet's acceptances on one network, the network's record, and whether the wallet is current now, including the date an announced change would stop it counting. When the record cannot be read it answers 503 with the standing stated as unknown, which the apps treat as not current.

The scan stores the LegalFacet events (TermsAccepted, TosPublished, TosAnnounced, TosAnnouncementWithdrawn, TosVersionInForce) as they are read.

> Caveat: the indexer decodes those events only when the Diamond ABI it is built with declares all five. A build whose ABI predates them reports every standing as unknown rather than "no Terms in force", so nothing is shown as fillable on a guess. Diamonds deployed before these events (which announced versions with the retired CurrentTosUpdated event) are not read.

Advances #3734.
