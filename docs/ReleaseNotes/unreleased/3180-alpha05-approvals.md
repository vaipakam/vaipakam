## Thread — alpha05 Settings lists and withdraws your approvals (PR #3457)

The new app's Settings page now has an Approvals section: the standing
approvals the connected wallet gives the protocol on its network. A token
allowance shows how much it lets the protocol move, or that it has no limit;
an allowance given through Permit2 shows its amount and expiry; an approval
over a whole NFT collection, or over one NFT, says so.

No chain read lists every approval a wallet has given, so the page checks
the suggested assets and every asset the wallet's deposits, loans, offers
and standing offers on this network name, plus any token or collection the reader adds. It says
how many assets it checked and that an approval for any other token is not
found there. A record it could not read to the end, or an asset that did
not answer, is stated, never shown as "no approval".

Each approval is withdrawn in one wallet confirmation with its own receipt:
what it lets the protocol move now, what still lets it move the asset
afterwards, and that no funds move. Another approval of the same asset (the
whole collection's approval when one NFT's is withdrawn, or the Permit2
allowance when a token's is) stays in place and is named; when it could not
be read, the receipt says so instead of saying nothing remains. The approval is read again right before the wallet opens, and the
outcome is read back from the chain. The receipt says that anything relying
on the approval, such as a step started in another app, refuses until it is
approved again; withdrawing a Permit2 allowance leaves the token's own
approval for Permit2, which other apps may use, unchanged.

Advances #3180.
