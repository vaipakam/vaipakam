## Thread — vaults: one caller, and every move inside a guarded action

A user's vault now answers to exactly one caller, the protocol contract that created it. The leftover owner record from the old upgradeable design is gone, along with its unused "transfer ownership" and "renounce ownership" functions, and the vault no longer treats calls from itself as trusted. Nothing in the vault ever made such a call, so this removes a door rather than closing a used one.

Moving an asset out of a vault can hand control to someone else: an NFT recipient's receiving hook runs during the transfer, and an approved spender acts on the allowance. The vault has no reentrancy guard of its own. Before this change the safety rested on every protocol path that moves vault assets happening to hold the protocol's guard. Now the single place every vault move passes checks it: a move runs only while the protocol's reentrancy guard is held, or while a limit-order fill holds its fill lock (during which the protocol admits only its own calls and the order protocol). Anything else is refused with a named error.

The check found one route that moved vault assets without the guard: the marketplace executor's callbacks for a collateral sale (opening and closing the listing's approval, and the sale's settlement). A buyer can start that fill directly, so nothing held the guard. Those callbacks now take the guard when nothing holds it, and run inside the Diamond's own guarded action when the Diamond started the fill itself.

Tests show an NFT withdrawal whose recipient hook tries to call back into the protocol reverts whole with the token still in the vault, that every move and allowance entry refuses to run outside a guarded action, and that the vault refuses a call from itself. A stale collateral-sale test that still expected the borrower's remainder in their wallet now checks the borrower's vault, where #3629 sends it. The vault's code comments no longer describe it as a UUPS proxy or claim asset moves are atomic.

Ships with the next fresh deploy (the vault code and the outflow facet change together). Closes #3432.
