## Thread — alpha05 can rent an NFT (PR #3466)

The new app now has a Rent page. It shows the rental part of the offer
book on the wallet's network, owners' listings first. When nothing is
listed it says so, and on a test network it points to the faucet for a
test NFT and test tokens.

A rental row and an offer's page now say a rental has no collateral and no
ratio, instead of showing an empty collateral amount.

An owner's listing can now be rented from its page. The review states what
moves from the wallet into the renter's own vault: the daily fee for the
whole term plus the buffer, and whether the buffer share was fixed by the
listing or comes from today's setting. It also states that the renter gets
the right to use the NFT, never the NFT, which stays in the owner's vault;
the rent rule; what comes back on a timely close; the late fee taken from
the buffer; and that a rental never closes by itself and what a default
takes. A wallet short of rent plus buffer is told so before any wallet
step.

Renting signs the exact terms, approves exactly the payment and runs a dry
run before sending. The outcome is checked on the chain: the rental
started, the payment reached the renter's vault, and the owner's vault
names the renter as the NFT's user. Taking a renter's request and listing
an NFT for rent come next; the page says where they are done today.

Advances #3180.
