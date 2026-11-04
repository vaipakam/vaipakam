# Release Notes — 2026-11-03

A reward-budget delivery now carries its one funded day directly, so the day lands as soon as its last part arrives, with no second call on the mirror; the keeper's delivery-proof pass is retired with it. The backstop vault can return idle capital to the treasury again after the protected-account change broke that withdrawal. The adoption page in the app now takes NFTs and multi-token balances as well as ERC-20 tokens, and the vault card offers disowning an asset. The contract and keeper changes reach a chain only by fresh deploy, and went to the testnets with the all-waves fresh deploy; the live review of the adoption page is owed after it.

## Thread — The budget wire carries its one funded day inline (PR #3056)

Since #2821 a reward-budget remittance funds at most one day, but the wire
still carried that day as a rooted, chunked day list built for many days.
Every delivery therefore needed a second, permissionless call on the mirror
(indexing its chunk, or proving it when the delivery held no epoch) before
its day could land. The keeper's delivery-proof pass existed to make that
call.

The wire now names the funded day directly, beside the split, the era, and
the part and whole the delivery declares. The mirror's receiver moves to
generation 9 and refuses the old rooted shape by name, so a stray message
stays re-executable rather than being misread. On arrival the mirror records
the day, counts the delivery's part toward that day's landed sums and, where
reward custody is activated, opens the epoch and places it in the day's
arrival order, all in the one transaction. A day lands as soon as its last
part executes.

Placement in a day's order is bounded. An epoch that would have to pass more
than 128 later-arrived epochs to find its place is refused by name and left
for re-execution. Only epochs of one day landing out of arrival order, which
in practice means same-second ties, can come near that bound.

Everything that existed only for the second step is removed: the chunk index
and proof calls, the placement hints, the per-delivery index cursor, the
"not fully indexed" and multi-day withholding states, their errors, events
and views. Parking an epoch's remainder now takes one call once its day is
proven closed. The destination gas budget each remittance asks for is
re-derived from the new ingress, which now does the indexing and the part
count itself.

This changes the storage layout, so it reaches a chain only by fresh deploy,
as the rest of the #1566 reward work does. Closes #2828.

The keeper's delivery-proof pass is retired in the same change, with its
`REWARD_DELIVERY_PROOF_ENABLED` flag, since nothing is left for it to send.
The keeper's close-out pass reads the new epoch and remainder records: an
epoch names its one day, a parked remainder says it is parked rather than
implying it from a day count, and a park is one call once that day is proven
closed.

> Caveat: the keeper and the contracts change together, so this merges at the
> fresh deploy. On a chain still running the earlier contracts, the keeper
> from this change would no longer prove or index mirror deliveries.

_Committed 2026-11-03 18:12 UTC (88f92189f)._
<!-- assembled-fragment: 2828-inline-day-wire.md sha256=f1e21a78f1cd501fea337892cbb3fa5d16428155cfdc2ad1b575c2bdb2e4f05b -->

## Thread — the backstop vault can return idle capital again (PR #3064)

The protected-account change (#3088) added the intent's account as the first argument when lender-intent capital is withdrawn. A replacement controller can manage a recovered account, so the withdraw names whose capital it releases. The aggregator adapter was updated to pass itself, but the backstop vault was not. It still called the old three-argument form. No facet routes that selector any more, so the admin's withdrawal of idle backstop capital back to the treasury reverted with "function does not exist" every time. The capital was not lost, but it could not leave the backstop's intent.

The backstop vault now names itself as the account, the same way the adapter does. The vault is the intent's owner and is never a protected account, so the payout comes straight back to it, and from there to the Diamond as before. The pre-deploy full regression found the bug. Nothing in the targeted per-PR suites exercised this path after #3088 merged.

A scan of every interface under `src/` that calls into the Diamond found no other selector the facets no longer route.

The same regression also found a stale keeper-permission test. It still treated bit 0x100 as undefined and expected the full keeper-action set to be 0xEF. #3088 defined that bit as the vault-lock delegation, which makes the set 0x1EF. The test now checks a bit that is still undefined.

This ships with the all-waves fresh deploy. The intended behaviour is unchanged, so no functional spec edit is needed.

_Committed 2026-11-03 18:12 UTC (88f92189f)._
<!-- assembled-fragment: 3088-backstop-idle-withdraw.md sha256=f4a105af1f604e229f63da7b0b2cfcf9fc71a783912327b7390820cf45004180 -->

## Thread — The adoption page takes NFTs too (PR #3101)

The page that adopts assets which reached a vault outside the app took ERC-20 tokens only. The contract has always taken all three kinds (tokens, NFTs and multi-token balances), so an NFT that landed in a vault that way could not be adopted from the app, and therefore could not be withdrawn there either. The vault card said so instead of linking to a form that could not take it.

The page now asks for the kind of asset and, for an NFT, its token id, and carries both through every step: the figure it offers, the acknowledgement the user signs, the transaction, the attempt it saves in the browser and the outcome card. An outcome is compared against the asset asked for by contract, kind and token id, so a transaction the wallet replaced with one for a different token id is reported as that other asset. A single NFT has no amount to type.

What can be adopted now comes from one rule, the contract's own figure for the untracked part of that exact asset, read on lookup and again just before signing. The page no longer works the ERC-20 figure out from balances itself. An NFT kind is read only when the contract says it follows that standard, so a wrong kind is refused by name instead of read as "nothing untracked".

The vault card also offers disowning, the contract's public record that an asset is not the user's. It moves nothing and credits nothing, and needs no declaration, signature or sanctions check, so it sits on the card rather than behind the adoption page's checks, where a flagged wallet, a smart-contract wallet or a network without screening would never see it. It reports what the contract recorded from the transaction itself, a transaction whose result cannot be read is reported as unconfirmed, with its link, rather than as failed, and one the chain settled as not run (reverted, or cancelled or replaced in the wallet) is reported as not taken and can be tried again.

The vault card links every kind to the page again, with the asset filled in. A link never fills in the declared source or the amount, and a malformed link opens a blank form. A replaced account, which cannot adopt yet (#3094), sees the note without the link. The asset-kind labels the card and the page share now live in one place, so one asset has one name across the app.

Closes #3096

> Caveat: the multi-token path and the wrong-kind refusal are not driven on the local test chain, which deploys no multi-token contract and no NFT that misreports its standard; both are on the live review owed after the all-waves fresh deploy.

_Committed 2026-11-03 14:39 UTC (8466bc14d)._
<!-- assembled-fragment: 3096-recover-every-asset-kind.md sha256=cb2a06de93dd14f1910c4077b44a91660d14f154161e6dc5032bdd68c31391fc -->
