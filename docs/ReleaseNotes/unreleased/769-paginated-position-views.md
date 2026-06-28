## Hardening — large-wallet safety for the on-chain position reads (#769)

The app confirms which loans and offers a wallet holds by asking the chain to
enumerate that wallet's position NFTs. That on-chain view walked the wallet's
*entire* NFT inventory in a single call. Because position NFTs can be transferred
to someone without their consent, an attacker could mint many cheap dust offers
and dump their NFTs onto a victim to bloat that inventory until the single call
grew too large for a node to answer — breaking the victim's loan and claimable
views.

This adds **paginated** variants of those views so the work is done in bounded
slices, and the app now reads them page by page. The cost per call scales with a
fixed page size instead of the whole inventory, so a griefed wallet's reads keep
working no matter how many junk NFTs are pushed onto it. The total work still
scales only with the wallet's own holdings — there's no global amplification.

This is a follow-up to the indexer security work: the indexer's read endpoints
remain fast and make no on-chain calls, while the app's authoritative on-chain
confirmation is now safe even for a deliberately-bloated wallet. No change to any
lending, borrowing, or settlement behaviour.
