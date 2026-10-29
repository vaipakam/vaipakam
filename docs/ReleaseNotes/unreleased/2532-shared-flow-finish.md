## Thread — One review footer and done card for the offer and rental flows (PR #3047)

The last step of the offer flow and of both rental flows (posting a listing, and renting an NFT) carried its own copy of the same pieces: the consent box, the error banner, the back and submit buttons with their "prompt 2 of 3" wording, and the done card with its transaction link. A fix to one copy had to be repeated in the other two, and could be missed. They are now one shared footer and one shared done card. The shared footer takes the review's consent from the one consent rule (#1696), so its box unticks itself when what the review shows changes and says why, in every flow that uses it. Each flow still decides what its review covers, what going back resets, and which actions the done card offers.

The step indicator at the top of these flows now finds the current step from the flow's own list of steps, rather than from a separate hand-written mapping kept beside the list.

Nothing a user sees changes.

Closes #2532.
