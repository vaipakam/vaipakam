## Thread — Terms of Service version 4: the lending risk line

The Terms of Service are published as version 4. One entry in the list of
key risks changed and nothing else. The lending entry now opens by saying
that lent funds stay in the loan until the borrower repays and cannot be
withdrawn before that, and that the loan may be sold to another lender, but
only if one accepts. The rest of the entry, about what happens when a
borrower does not repay, is unchanged.

The owner chose to put the statement inside the lending entry and to keep
the list at six. A seventh entry was considered and rejected: the statement
concerns lenders only, and a longer list is read less. Stating it only on
the Key risks page was rejected because a lender should meet it before
accepting the Terms, not after. The reasoning is in section 6.1 of the
default paths design (`docs/DesignsAndPlans/DefaultPathsDesign.md`).

Version 3 stays frozen and readable at its own address, as every published
version does. The unversioned Terms address now serves version 4. The
connected app's key-risk list, shown with the Terms before a first
acceptance and on the Key risks page, carries the same sentences.

Publishing on the website does not change what a wallet is asked to accept.
A version becomes the one a network asks for only when the owner configures
it there, and that step is separate and has not been taken by this change.

> Caveat: until version 4 is configured on a network, that network still asks for an earlier version, whose pinned text has the shorter lending entry, while the app's key-risk list already shows the new one.
