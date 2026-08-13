## Project instructions — five live settlement facets were described as unbuilt (PR #TBD)

`CLAUDE.md` is loaded as project instructions: it is the first thing an agent
or a new contributor reads, and it is read as fact. Its architecture section
ended by naming five facets as "placeholders (Phase 2)" — the treasury, both
borrower early-close routes, the lender-exit routes, and partial collateral
release.

None of them is a placeholder, and none had been for some time. Every one is
cut into the production Diamond, every one moves funds, and each has a real
surface: borrower close-out including handing the obligation to a replacement
borrower, lender exit by instant sale or by listing, releasing surplus
collateral on an open loan, and the treasury's claim, conversion and buyback
operations.

Two details in the new descriptions were corrected in review, and both are the
kind of thing this change exists to prevent. Refinancing does **not** edit a
loan's terms in place: it closes the original and replaces it with a separate
loan record, which matters to anything tracking loan identity. The original's
two position certificates are also kept rather than destroyed — marked as
settled, so the former borrower keeps a redeemable claim on the position they
left. And the
treasury's custody role depends on how the protocol is deployed — on the
documented mainnet setup, fees leave for an external multisig immediately, so
the claim and conversion paths have nothing held at the protocol to act on.

The document also contradicted itself twice over, which is what makes this
worth more than a typo fix: its own settlement rules name two of these facets
as the paths a loan properly closes through, and its retail-deploy section
lists the same two among the entry points that must reject sanctioned callers.
A reader who trusted the facet table and a reader who trusted either of those
sections would have come away with opposite beliefs about whether the code
exists.

"Placeholder — Phase 2" reads as *do not expect behaviour here*, which is the
opposite of true on a path that moves money. It has already cost real time
once, during earlier work on the sale routes, where the table gave no hint
that those were live surfaces with their own invariants.

The five now appear in a table of their own with what each actually does. Two
of them genuinely do carry future-scope notes in their source — the treasury
expects governance distributions later, and partial withdrawal expects
multi-collateral support — and that is probably where the retired line came
from; those describe work stacked on top of shipped behaviour rather than
absent behaviour, and are recorded as such. Also noted: the phrase "Phase 2"
appears inside several of these facets as internal task numbering, which is
unrelated to whether anything ships.

No code or user-visible behaviour changes.
