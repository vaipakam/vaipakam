## Thread — Reward claims read a bounded part of a large wallet (PR #3487)

The first half of #1787 made every claim do a bounded amount of settlement work, but each claim still read every unsettled reward entry the wallet held, at about 18 thousand gas per entry. A wallet past roughly 500 unsettled entries therefore still could not claim in one transaction. Entries can also be moved onto a wallet by others, because a position NFT can be transferred to it, so the wallet's owner does not control that number.

Each claim now reads at most 128 of the wallet's entries, its claim window. A wallet with no more than that is read whole, as before. A larger wallet is served over several claims: after each claim the settled entries in the window leave the wallet's list, and the window moves on to the next part, returning to the start after the last one. Every entry is reached within a bounded number of claims, and nothing is lost by waiting. A claim domain that is already open continues on every claim, whichever part the window holds.

The window moves on after every claim rather than waiting for its part to be fully settled. An entry that stays open for a long time therefore cannot hold the window, and entries moved onto a wallet cannot keep the owner's other entries from being reached.

An entry outside the window is not the next claim's, so its expiry clock does not run while it waits. A new view, the reward claim window, reports which part of the wallet's entries the next claim covers and how many there are in total, so the app can say that a claim covers only part of a large wallet.

Closes #1787.
