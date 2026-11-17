## Thread — alpha05: the check after an approval waits for the approval (PR #3706)

Posting a lending offer on Base Sepolia could ask for two wallet signatures and then stop with "the dry run after the approval was refused … ERC20 insufficient allowance", putting the approval back to zero. The approval had landed. The app's protocol check that follows it was asked of whichever chain source answered first, at that source's latest block, and a source a block or two behind still saw the allowance as it was before the approval.

Every flow that approves a token or an NFT before its dry run now asks that dry run only of a source that has reached the block the approval landed in, and pins the check to that source's head. A source that is behind is skipped for the next one; when all of them are behind, the app waits briefly and asks again, and a check that still cannot run is reported as unread rather than as a refusal. The flows are posting an offer or request, taking an offer or request, editing an offer, adding collateral, repaying in full or in part, renting and listing for rent, depositing into the vault, and setting up or changing Auto-lend. The allowance read-back and the put-back already read no earlier than that block; the dry run now follows the same rule.

A second fix from the same live run: pressing "Confirm in wallet" on an accept review could leave the reader back at the review with the consent unticked and no explanation. The pre-send re-read had found new figures and cleared the consent itself, and the confirm then stopped quietly because the consent was gone. Now what the re-read found is always shown, and a consent cleared during the check is stated: the wallet was not opened, read the figures again and confirm.

Advances #3180.

> Caveat: a second signer using the same wallet at the same moment can still use up or reset the allowance between the approval and the check; the flow then stops and states it, as before.
