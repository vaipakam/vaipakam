# Release Notes — 2026-11-17

The new app's Positions page now shows how much of each lending asset's Auto-lend money is in loans and how much is waiting, and the check after a token approval no longer fails on a chain source that has not yet seen the approval. Position NFTs on a new deployment show the Vaipakam logo by default, served from the website.

## Thread — alpha05: how much of an Auto-lend's money is in loans (PR #3708)

Positions now shows, above the Auto-lend cards and for each lending asset, how much of the money behind Auto-lend is in loans and how much waits in the lender's own vault, with the share in loans. It is read at the same block as the cards. A loan counts in full until its repayment is claimed or lent again, as the cards already say.

Amounts in different assets are never added together, since no total across assets exists without a price. The share is rounded down, so it never reads higher than it is. Waiting money behind a stopped or ended Auto-lend is named on its own, because it will not be lent until the lender takes it back or starts that Auto-lend again. When the wallet has more settings than one read lists, the figures say they cover only the listed ones.

The figures always say they cover only the listed settings. The protocol drops a stopped Auto-lend with nothing left waiting from the wallet's list while its loans run on, and no on-chain list of those loans exists, so the page names that gap and points to each loan's own page instead of showing a share that quietly leaves them out.

The figure is what the protocol counts against the Auto-lend's limits, not what the wallet owns. A loan the lender has sold keeps counting until its repayment is claimed, so the page says "counted in loans" and states that a sold loan still counts although it is no longer the lender's.

This is the first part of #3664, the part its own recommendation says can ship for ordinary Auto-lend. The rest needs data the app cannot read today: the rate earned across the loans Auto-lend made (no per-owner list of those loans exists on-chain, and the indexer does not record intent fills yet), why the rest is waiting (#3623), what lower limits would have filled, the opt-in alerts, and the instant-market row (#3656).

Advances #3664.

_Committed 2026-11-17 11:48 UTC (a8d47052f)._
<!-- assembled-fragment: 3180-alpha05-autolend-share-in-loans.md sha256=9103d0c0ae88868893ae6ae0a3171c94de4a6cc925b0bd2d9a8e965eebd087e0 -->

## Thread — alpha05: the check after an approval waits for the approval (PR #3706)

Posting a lending offer on Base Sepolia could ask for two wallet signatures and then stop with "the dry run after the approval was refused … ERC20 insufficient allowance", putting the approval back to zero. The approval had landed. The app's protocol check that follows it was asked of whichever chain source answered first, at that source's latest block, and a source a block or two behind still saw the allowance as it was before the approval.

Every flow that approves a token or an NFT before its dry run now asks that dry run only of a source that has reached the block the approval landed in, and pins the check to that source's head. A source that is behind is skipped for the next one; when all of them are behind, the app waits briefly and asks again, and a check that still cannot run is reported as unread rather than as a refusal. The flows are posting an offer or request, taking an offer or request, editing an offer, adding collateral, repaying in full or in part, renting and listing for rent, depositing into the vault, and setting up or changing Auto-lend. The allowance read-back and the put-back already read no earlier than that block; the dry run now follows the same rule.

A second fix from the same live run: pressing "Confirm in wallet" on an accept review could leave the reader back at the review with the consent unticked and no explanation. The pre-send re-read had found new figures and cleared the consent itself, and the confirm then stopped quietly because the consent was gone. Now what the re-read found is always shown, and a consent cleared during the check is stated: the wallet was not opened, read the figures again and confirm.

The same live run saw that re-check sit for about five minutes before the review reset, which is how long the wallet-connection library waits before it gives up on an unanswered pairing. Every read and check the app makes through the wallet's own provider now has fifteen seconds to answer. If it hasn't answered by then, the app asks the next source.

Advances #3180.

> Caveat: a second signer using the same wallet at the same moment can still use up or reset the allowance between the approval and the check; the flow then stops and states it, as before.

_Committed 2026-11-17 09:51 UTC (7b163e288)._
<!-- assembled-fragment: 3180-alpha05-dry-run-after-approval.md sha256=8ab1122d637105fc20a9cd05314ae91609bab783d38167945951ed1b95dcce71 -->

## Position NFT — default image is the Vaipakam logo, served from the website

A newly deployed Diamond now gives its lender and borrower position NFTs
the Vaipakam logo as their default image, at
`https://vaipakam.com/nft/position.jpg`, replacing the earlier placeholder
on a public IPFS gateway. The marketing site serves the file with a one-day
cache, and any origin may read it.

The image is served from our own domain rather than an IPFS gateway because
marketplaces, wallets and the indexer fetch NFT images from their own
servers. The public ipfs.io gateway rate-limits them, and a pinning
service's private gateway depends on that account's plan. The same bytes
stay pinned on IPFS (`QmaejkrKx9e9AHZUVPojuANYRwzsskXbRcghvEX45N1dAn`) as
the permanent copy. A position NFT's terms live on-chain; the image is only
branding, so a website file that can be replaced is acceptable.

This only changes what `initializeNFT` writes at deploy. Diamonds already
deployed keep the image stored in them until an admin rotates it with
`setDefaultImage` (for example through `ConfigureNFTImageURIs.s.sol` with
`NFT_DEFAULT_IMAGE_LENDER` and `NFT_DEFAULT_IMAGE_BORROWER` set).

> Caveat: the 2026-11-17 testnet Diamonds (Base Sepolia, Arbitrum Sepolia,
> BNB Testnet) still serve the old image until that admin update is sent.

_Committed 2026-11-17 12:36 UTC (e82b23586)._
<!-- assembled-fragment: position-nft-logo-image.md sha256=d0ce5d6a7bb18272985a389eeefc09f6475d7f83ad67ca7cbc70da04931db3c6 -->
