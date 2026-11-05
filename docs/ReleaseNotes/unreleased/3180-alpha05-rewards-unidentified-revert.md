# The next app's rewards preview asks another source when a wallet drops the reason

The live review of the next app's Home found the rewards section saying a claim "would be refused (Unrecognised)" for a wallet with nothing to claim. The claim preview had been answered by a wallet provider that reported the revert without its reason, and the page treated that as a refusal it could not name.

A revert reported without its reason is now not taken as an answer: the preview asks the next source (the app's read proxy, then the public endpoint), which reports the reason, and the page states what the protocol actually said, here that there are no rewards to claim. Only when no source can answer does the page fall back to the labelled lower bound, as before.

The live review driver now passes the node's revert data the way real wallets do, and can drop it on request to check this path. Epic #3180.
