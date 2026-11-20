## Auto-lend: the pause for a moving price, in the app

Every Auto-lend now shows its pause for a moving price on its card in Positions. The card reads the protocol's own answer for that Auto-lend and says plainly where it stands: the price is steady and fills can go ahead, fills are paused and why (the price moved fast, the pair does not yet have its last two hourly price checks, or no price can be read), or the owner switched the pause off.

A paused Auto-lend therefore says why it is not lending, instead of looking as if nothing matched. A new pair says fills start after two hourly price checks.

The owner can switch the pause off, or back on, for one Auto-lend. The change goes through the usual review: it is checked against the protocol from the wallet before and again right before signing, moves no money, and its outcome is read from the transaction's own record.

The setup review states that the pause starts on, what switching it off means, and, when the pair's price checks or price would hold fills back now, that too.
