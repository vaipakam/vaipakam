## Thread — The adoption page takes NFTs too (PR #3101)

The page that adopts assets which reached a vault outside the app took ERC-20 tokens only. The contract has always taken all three kinds (tokens, NFTs and multi-token balances), so an NFT that landed in a vault that way could not be adopted from the app, and therefore could not be withdrawn there either. The vault card said so instead of linking to a form that could not take it.

The page now asks for the kind of asset and, for an NFT, its token id, and carries both through every step: the figure it offers, the acknowledgement the user signs, the transaction, the attempt it saves in the browser and the outcome card. An outcome is compared against the asset asked for by contract, kind and token id, so a transaction the wallet replaced with one for a different token id is reported as that other asset. A single NFT has no amount to type.

What can be adopted now comes from one rule, the contract's own figure for the untracked part of that exact asset, read on lookup and again just before signing. The page no longer works the ERC-20 figure out from balances itself. An NFT kind is read only when the contract says it follows that standard, so a wrong kind is refused by name instead of read as "nothing untracked".

The vault card also offers disowning, the contract's public record that an asset is not the user's. It moves nothing and credits nothing, and needs no declaration, signature or sanctions check, so it sits on the card rather than behind the adoption page's checks, where a flagged wallet, a smart-contract wallet or a network without screening would never see it. It reports what the contract recorded from the transaction itself, and a transaction whose result cannot be read is reported as unconfirmed, with its link, rather than as failed.

The vault card links every kind to the page again, with the asset filled in. A link never fills in the declared source or the amount, and a malformed link opens a blank form. A replaced account, which cannot adopt yet (#3094), sees the note without the link. The asset-kind labels the card and the page share now live in one place, so one asset has one name across the app.

Closes #3096

> Caveat: the multi-token path and the wrong-kind refusal are not driven on the local test chain, which deploys no multi-token contract and no NFT that misreports its standard; both are on the live review owed after the all-waves fresh deploy.
