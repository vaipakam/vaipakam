# Release Notes — 2026-11-08

The day's largest contract change moves position NFTs out of the Diamond. Each loan side is now one token on a separate, non-upgradeable contract, and the Diamond only mints, locks and reads the current owner. Alongside it, a shared, delayed registry now holds the protocol's endpoints, such as the treasury, swap adapters and marketplace conduits. Both reach a chain only by a fresh deploy.

The rest of the day covers:
- **The new app:** loan actions from a loan's own page (repay in full or in part, add or take back collateral, the interest schedule), claims and Claim everything, seller interest, extension reserves, the protected-account payout queue, the Vault page (holdings, deposit, withdraw, the safety card and the pause escape route), the Offers page and the offer book. The website and the new app also return to indigo.
- **Liquidations and pricing:** liquidity status reads pool depth that persists rather than one block, forced sales lose less on deep and calm markets once the hourly checkpoint keeper is armed, and close-out liquidity reads keep working through a fast price move.
- **Listings and refinance:** anyone may clear a listing whose position moved, and a refinance request posts exactly the request its review described.
- **Operations:** governance alerts say in plain words what a queued change does, a keeper fee-balance alert, a count of distinct liquidators per chain, and batch actions sent with enough gas for every item.
- **Positioning:** the product is described as non-custodial, vault-to-vault, fixed-rate lending.

### Batch actions are sent with enough gas for every item (#126)

Repay all, Claim all, the batch sale listing and the batch refinance each
send one best-effort batch. The app used to send it at the wallet's gas
estimate. For a best-effort batch that estimate is too low: the node looks
for the smallest limit at which the batch as a whole succeeds, and a batch
succeeds even when every item inside it ran out of gas and was skipped. A
two-loan Repay all on the test chain mined that way, closing neither loan
while each repaid fine on its own.

The app now takes the estimate for the same batch with every item marked
must-succeed, where an item short of gas fails the estimate, and sends the
best-effort batch at that figure plus the standard 30% margin. When some
item would fail anyway, it sizes from the items that would run. A skipped
item now means the item was not eligible, not that it was starved of gas.

This PR also brings back the Repay all end-to-end test (spec 55), which is
what found the problem.

_Committed 2026-11-08 21:59 UTC (177eff48a)._
<!-- assembled-fragment: 126-batch-gas-limit.md sha256=eae7dd9f5a1b5b3c9f69de2663b829955d785abcbe00d192b5a2bcd35758cb58 -->

## Thread — The next app adds collateral to a loan (PR #3314)

A running loan's page in the next app now offers its borrower a way to add collateral. Only the holder of the borrower position may do this, so the action is shown to that holder alone. It is held, with the reason, while a swap-to-repay order on the borrower position is pending, when governance has paused the collateral token, and when the protocol does not price the collateral token now; the two token checks are read live, not from the loan's class when it opened. A rental has no collateral to add to. The protocol pause never holds a top-up, since a borrower can always lower their risk, and the review says so in every case.

The borrower types how much more of the loan's own collateral token to add, checked against the wallet's balance as it is typed. The review shows the collateral now and after, that it is held in the borrower's vault locked to the loan, and the loan's health factor and loan-to-value now. No protocol view gives the figures a top-up leads to, so the review says the finish card will show the protocol's own. It also says that added collateral can be taken back only within the protocol's limits while the loan runs, and that a loan in fallback returns to running only if the top-up restores the protocol's opening limits.

The protocol takes exactly the amount chosen, so a standing approval that already covers it is left as it is, and a smaller one is raised to exactly the amount and put back if the top-up does not go through.

After the top-up the app reads the outcome from the transaction's own record: the collateral it left, the protocol's health factor and loan-to-value after it, whether a loan in fallback returned to running, and what left the wallet.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-POSITION-ADD-COLLATERAL. Epic #3180.

_Committed 2026-11-08 03:36 UTC (129f7073c)._
<!-- assembled-fragment: 3180-alpha05-add-collateral.md sha256=15fb1ef067db28a47914daec8b91fc40b7f86836b4e63e36441304ae4024fdb6 -->

## Thread — The next app collects everything ready in one transaction (PR #3343)

Claims in the next app now opens with Claim everything. It lists every payout the connected wallet can collect right now, from the list the rulebook sets: loan payouts on ended loans whose position the wallet holds, interaction rewards when the rewards claim can complete (or a held reward the sanctions screen has released), the un-lent capital of the wallet's standing offers, free VPFI in its vault, and withdrawable payroll for a payee. Interest owed from a position the wallet sold is still collected on its own, and so is a lender claim on a loan in fallback, because that claim settles the fallback before it knows what it pays. A source or a loan that could not be read is named as left out rather than dropped.

Each payout has a switch. Everything is on except free vault VPFI and the capital of a standing offer that lends VPFI, because both count toward the fee-discount tier, and the capital of a standing offer that is still lending, because taking it out leaves the offer less to lend. The reader turns those on if they want them.

The batch goes through the protocol's own batch entry, which runs each payout as a separate call with the wallet as the caller. Each payout therefore checks its own rules exactly as it would alone, and each is allowed to fail on its own. Before signing, the review runs the whole batch as a dry run. A payout the protocol refuses is left out of the transaction and its reason is stated. One that the protocol refuses when the transaction actually runs is skipped, moves nothing and stays listed. One transaction carries at most 30 payouts, the protocol's bound, and anything past that waits for a second one, which the list and the review both say.

The protocol pause and a wallet flagged by the sanctions screen stop the whole batch before signing, and that is said once rather than per payout. The finish card reports each payout as collected or skipped from the transaction's own logs. It measures each token where it landed, including a protected account's queue, against what the collected payouts recorded. A rewards claim pays a limited run of days at a time, so when more remains the finish card says so and the remainder is listed again.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-CLAIM and RB-CLAIM-ALL. Epic #3180.

_Committed 2026-11-08 13:36 UTC (7d52bed84)._
<!-- assembled-fragment: 3180-alpha05-claim-everything.md sha256=9626f1e2abb327f502694ddb85b71c981ba7b9acb3e7a7780117ea5db98f2be2 -->

## Thread — The next app collects loan payouts (PR #3324)

The next app now has a Claims page, and an ended loan's page has a "Your payout" section. Once a loan is repaid, defaulted or matched, the holder of each position collects what the protocol recorded for that side: the lender's principal and interest, or what a default recovered, and the borrower's collateral back or what was left over. The payout belongs to whoever holds the position now, so a position bought from someone else pays its new holder. Each side is offered only to its holder, and its closed reason is stated: a pause, a loan still running or already settled, a loan in fallback (which pays the borrower only after the lender has collected or the loan is cured), or a side already collected or with nothing recorded.

The review names every payout the claim makes on that side, including funds held for the lender before the loan ended, a rented NFT coming back, collateral the borrower added in another token, and a surplus held for the borrower. A payout recorded at zero says so. It states where the payout goes: the wallet, or, for a protected account, a queue for the account's delay (released only once a secondary signer approves, where the account requires one), the vault while the account is locked or its queue is full, or the vault when the payment comes from the other party. These are said in the same words taking back collateral uses, from one shared rule. It also says what past sellers of the lender position take first (or that it could not be read, and what that may mean), that collecting burns the position token, that collecting a loan in fallback ends the fallback and the borrower's chance to cure it, and what a pause before confirmation does. The protocol's own dry run of the claim is part of the review, and the send runs it again.

After the claim the app reads the outcome from the transaction's own record: the claim recorded, what the protocol paid against what was reviewed, each payout that arrived, was queued, kept or credited to a vault, an NFT's arrival, and the loan's settlement once both sides have collected. When collecting a loan in fallback lets the protocol match it, the finish card says the match changed the payout, states what arrived in each token rather than comparing it with the review, and states the small matching reward paid to the collector in each token the match moved.

Claims lists the payouts of the positions the wallet holds, followed by the rewards section Home also shows (moved, unchanged). It says "nothing to collect" only when every read completed. Interest owed from a sold position, frozen sale proceeds, the protected-account payout queue and extension reserves are not collected here yet; the page names them and links the current app until they arrive.

On a loan's page, a hold that closes taking back collateral together with an action above it (collateral the protocol does not price, shared with adding collateral; a standing refinance request, shared with paying part) is now said once in words that name both actions, where before the line named only the action above.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-POSITION-CLAIM. Epic #3180.

_Committed 2026-11-08 06:36 UTC (7752c5db3)._
<!-- assembled-fragment: 3180-alpha05-claims.md sha256=bbd3d8b1f154b4ba59659a3e72601ff8ef639d5118b47b633aaa92a451ba723b -->

## Thread — The next app lists extension reserves and takes them back (PR #3342)

A borrower can set aside the loan's token in their own vault for the loan's extensions. An extension, the keeper's or the borrower's own, draws on that reserve first. The reserve stays the depositor's: it is locked only for those charges, and they can take back what is unused whatever the loan's state. Until now the next app only said that reserves were not on its Claims page yet, and pointed to the current app.

Claims now has an Extension reserves section. It lists every loan where the connected wallet still has a reserve. The loans are found from the index's record of that wallet setting a reserve aside, being charged from it or taking some back. A loan can also be looked up by its number from the chain alone, so the list is never shown as empty while the index fails. Each row states the reserve and whether an extension can still draw on it. That is only on a running loan in a token with no interest cadence, and only while this wallet holds the borrower position, because an extension charges the current holder's vault. When the position's holder could not be read on a running loan, the row says so rather than calling the reserve safe.

Taking a reserve back withdraws all of it in one step, after the protocol's own dry run. The protocol pause holds it, as it holds every withdrawal, and a wallet flagged by the sanctions screen is refused in the frozen-proceeds words. The review says a running loan's next extension then has no reserve to draw on. If the wallet no longer manages the account that set the reserve aside, the review says so. The finish card measures where the money landed, including a protected account's queue, and says if more was set aside meanwhile and stays reserved.

The "not on this page yet" line is gone from Claims: every kind of payout it lists can now be collected there.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-RESERVE. Epic #3180.

_Committed 2026-11-08 11:37 UTC (ec6a44e72)._
<!-- assembled-fragment: 3180-alpha05-extension-reserves.md sha256=5c9b396bb9df534dc3440c63975d1d753a643a6c61eaf61b3014bd0aede26508 -->

## Thread — The next app states payouts frozen for a flagged wallet (PR #3341)

When the sanctions screen flags a wallet, the protocol takes nothing it is owed and never stops a loan from closing. A repayment, a default or a liquidation still completes, and the other party receives what its side recovers. The flagged wallet's share is parked in a vault, locked, and released once the wallet is de-listed. The next app now says this wherever that money is.

Claims and the loan's page read the wallet's standing from the protocol's own views. That is whether a screen is configured here, what it answers for the wallet, and whether the wallet was confirmed flagged while the screen could be read. A flagged wallet sees "Frozen, awaiting de-listing", with a short note that nothing is taken and each payout stays locked, not lost. When the screen cannot be read and the wallet was confirmed flagged before, the page says a frozen payout stays locked until the screen answers again, that a payment due to that wallet meanwhile is parked the same way, and that an outage alone never freezes a wallet never confirmed flagged. When the standing itself could not be read, the page says so rather than guessing.

Every claim refuses a flagged wallet in those same words, right after the protocol pause, and offers no button. A seller's withdrawal also waits during an outage for a wallet confirmed flagged, as the protocol checks it. A loan claim lets an outage through, so its dry run decides. When the dry run refuses a payout the protocol froze on that loan, the review says so in the same words. A change in the wallet's standing reopens a claim's review.

On a running loan, the page now states what the loan already paid that is reserved for the lender position, in the lender vault the loan records, until the lender's claim pays it. A payment made while the holder was flagged is one example. A repaid loan whose borrower surplus is still held says that surplus is one of the payouts left to collect before it settles.

The protocol keeps no view of which loan sides recorded a wallet as their frozen party, so the app cannot name an earlier holder frozen on a position bought later. It relies on the dry run there. That gap is filed as #3340.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-FROZEN. Epic #3180.

_Committed 2026-11-08 10:45 UTC (44bc1310d)._
<!-- assembled-fragment: 3180-alpha05-frozen-proceeds.md sha256=9792b95bb523234c8f313ff77b925181a3eb7120f12b13041beac7e261b2a946 -->

## Thread — The next app shows a loan's interest schedule (PR #3309)

A running loan that pays interest on a schedule (every month, quarter, six months or year) now shows its current period on its page in the next app: when the period ends, when its grace period ends, the interest it owes, what has been paid toward it and what is still owed. Every figure is the protocol's own settlement preview. The interest for a period is figured on the principal and rate as they stand now, so the page says a partial repayment lowers it.

The page also says whether the period can be settled now, and what settling would do: a paid period only moves the checkpoint forward, and one still short sells just enough collateral to cover what is owed and the sale's charges. The protocol's own "can be settled now" does not account for the network's periodic-settlement switch or the protocol pause, so the page reads both and names them: switched off, it says nothing can be settled and no collateral is sold, in place of any warning of a sale; paused, it says no period can be settled while the pause lasts and that the paused time moves the period's dates. A switch, pause or period that could not be read is stated as unknown.

It also states how the borrower pays a period (by partial repayment where the loan allows it, otherwise only by full repayment or by the sale), that a pause moves the period's dates later while the interest a period owes stays one period's worth (interest keeps accruing through the pause, and any interest a repayment pays counts toward the period), that settling is open to anyone while whether the protocol's keeper settles periods is not known, and the chain time the period is placed against.

Paying a period and settling one come in later updates.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-POSITION-SCHEDULE. Epic #3180.

_Committed 2026-11-08 01:29 UTC (e89d4ae77)._
<!-- assembled-fragment: 3180-alpha05-interest-schedule.md sha256=cb27760b38b8570360eff2f18df543b275be7e0cc88779d07bcb01240f4178f7 -->

## Thread — The next app shows the offer book and lets you take an offer from it (PR #3390)

The Offers page in the next app now carries the offer book under your own offers, readable with or without a wallet. It lists every open offer the protocol's index has recorded on the network, newest first. Older offers load a page at a time. Tabs split loans of a token from NFT rentals, a filter picks lenders' offers or borrowers' requests, and a connected wallet can hide its own offers. The count line says how many offers have been read so far and whether older ones remain, so a filter is never mistaken for the whole book.

The index can lag the chain and only suggests what to look at. Rows carry no buttons. An offer the index still lists although its expiry has passed is tagged as expired, which anyone may clean up. Refinance requests, sales of a running loan, early-close offers and offers whose bound position moved are tagged by kind. A row the app cannot read is counted, never silently dropped. If the index cannot be read, the book says so instead of showing an empty list.

Each offer opens its own page, which reads the offer from the chain at one block, wallet or not. It shows the side, who posted it, the amount, what is already filled, the collateral, the term and when the offer lapses, and what a refinance request, loan sale or early close would do. From that read:

- An open loan offer of a token against token collateral can be taken whole, through the same review, consent and Terms step as Borrow and Lend.
- The creator can cancel their own open offer, and anyone can clean up an expired one, through the existing cancel flow.
- Rentals, offers with NFT collateral, loan sales and early-close offers say they are taken in the current app for now, and link to it.

An offer whose terms the protocol no longer holds is described as exactly that: either it was cancelled before anything filled it, or no offer with that number was ever posted. The protocol does not say which. An ended offer says how it ended. Your own offers on the page now link to their offer pages too.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-OFFER-BOOK and RB-OFFER-PAGE. Epic #3180.

_Committed 2026-11-08 23:23 UTC (c39e7fae4)._
<!-- assembled-fragment: 3180-alpha05-offer-book.md sha256=916d20299f657c369f0e4c5cc3184f17e2f537e5550df6fa45199fe8d1bcdf85 -->

## Thread — The next app lists your offers and cancels them (PR #3382)

The next app now has an Offers page. It lists every offer the connected wallet created, from the protocol's own record for that wallet, together with every offer whose position token the wallet holds now. Each shows the state the protocol reports: open, filled, sold, expired or cancelled. A borrowing request whose collateral sold through its marketplace listing before anyone accepted it reads as sold: no loan opened. Filters by state carry their counts. When the protocol cancels an offer that nothing filled, it clears the offer's terms, so the page shows only its number and state rather than rebuilding them. An offer held by one wallet but created by another says who may cancel it and where its return goes.

An open offer the wallet created has a Cancel button, and an expired offer a Clean up button. The review states what the offer still locks and returns: the unlent amount or NFT of a lending offer, the unused collateral of a request, or a rental request's prepaid fee and buffer. Where the app cannot size the return (an offer tied to a running loan, a refinance request that keeps its collateral in the loan), it says so and the finish card shows what moved. The review says where the return lands, through the creator's protected mode if it has one, that a filled part stays filled, that the offer's position token is retired, and that no approval is asked.

The protocol holds a cancel for the first five minutes of an offer nothing has filled, so a cancel cannot race an accept. The review names the time this cool-down ends and lifts it by itself once the chain passes it. A pause, an already filled or cancelled offer, a cancel by anyone but the creator before expiry, or the protocol's own dry run refusal stops the review by name.

The finish card states the protocol's cancel record and what the token's own logs returned.

Two fixes ride along for every flow that pays a protected account. A payout queued for an account a replacement retired names the wallet that now manages it as where it is released. A payout the protocol kept in the vault no longer blames a lock it cannot see: unless the account read as locked, it names both causes, a lock or a full payout queue. The Vault page's safety card now reads position NFT protection from the PositionNFT contract's holder lock, which replaced the protected mode's own flag; it had shown a stale value since that change. The offer book stays in the current app for now, and the page links to it.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-OFFERS-MINE and RB-OFFER-CANCEL. Epic #3180.

_Committed 2026-11-08 21:29 UTC (29f44c297)._
<!-- assembled-fragment: 3180-alpha05-offers-mine.md sha256=9923eca84a46120538ffbddfe55199dd1de72fade6116ad7fc11f3383c7c1cd4 -->

## Thread — The next app pays part of a loan (PR #3310)

A running loan's page in the next app now offers its borrower a way to pay part of the loan. Only the holder of the borrower position may do this, so the action is shown to that holder alone. It is held, with the reason, when the loan's terms do not allow paying part (the lender's choice when the loan opened), once the grace period has ended, while a swap-to-repay order is pending, while a refinance request on the loan is live, and while an offset offer on the borrower position is live, because that offer was made for the loan as it stands. A loan in fallback can only be repaid in full, which cures it, and a rental cannot be paid in part on this page yet. The protocol pause never holds it.

The borrower first types how much of the principal to pay. The amount is checked as it is typed against the protocol's own bounds: at least the protocol's minimum part for the lending token, and less than the whole principal, which belongs to Repay in full.

A part payment also pays the interest accrued since the loan's interest was last paid. No protocol view gives that interest ahead of the payment, so the review shows it from the protocol's payoff figure less the principal. On a pro-rata loan before its due date that is exactly the interest, and the review shows it as an amount. Otherwise, on a full-term loan or past the due date, the payoff figure also counts things a part payment does not charge, so the review shows "at most" and says why. This gap is recorded as issue #3299.

The review also shows the principal left afterwards, that the due date does not move, that the lender position's holder is paid straight away with the treasury taking its share of the interest, and that the interest counts toward the current interest period. The wallet approves exactly the most the payment can take, and whatever it does not use is put back afterwards. The borrower can go back and change the amount from the review.

After the payment the app reads the outcome back from the chain: the principal lowered by the part, what left the wallet, where the interest period now stands, and the unused approval put back.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-POSITION-PARTIAL. Epic #3180.

_Committed 2026-11-08 02:31 UTC (428b414e2)._
<!-- assembled-fragment: 3180-alpha05-pay-part.md sha256=29b4fcfb4734c29c3b6c01bb2cc4405fa166b047377feeb97e93f79888dd77da -->

## Thread — The next app shows and acts on the protected-account payout queue (PR #3330)

Claims in the next app now has a "Payouts waiting in your queue" section. When protected mode is on, everything leaving the account's vault for its wallet waits out the account's delay. The section lists each waiting payout in the order it falls due by the chain's clock. Each row leads with its request code, the same six characters every alert prints, so a message can be matched to a request. It states what the payout pays, where it goes (your wallet, the account's wallet, or an allowlisted address), when it can be released, and whether a secondary signer has approved it where the account requires that. The account's delay, whether the keeper service releases due payouts on this network (or that this is not known), and any pause are stated above the rows. A wallet without protected mode is told so. A list or row that could not be read is said so, never shown as empty.

Three actions are offered, each to the wallet allowed to take it. Anyone may release a payout once it is due. A pause holds releases until it ends or its escape route opens. A payout needing approval must be approved first. A payout whose destination is no longer allowed is cancelled by a release instead of paid, and the button and the review say so. The account's manager wallet or a secondary signer may cancel a payout at any time, including during a pause, and the asset stays in the vault, free to withdraw again. A secondary signer may approve a payout where the account requires approval. A signer finds the account in Advanced mode by pasting its address. An account the wallet manages because a replacement retired it is listed too.

Each action has a review naming the request code and every consequence, the protocol's own dry run, and one wallet prompt. The finish card is read from the transaction's own record: what the release paid and to whom (with the protocol's measured delivery beside a short one), a release that cancelled instead, the cancel, or the approval. A card stays on screen until it is closed, even after its row leaves the queue or the looked-up account is cleared. The note listing what Claims does not yet collect no longer names the queue.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-PAYOUT-QUEUE. Epic #3180.

_Committed 2026-11-08 07:46 UTC (7ced601a2)._
<!-- assembled-fragment: 3180-alpha05-payout-queue.md sha256=004fd2bd70bc8187528c98059ad6299a965d848cf13b3919885003b23ca66b10 -->

## Thread — The next app repays a loan in full (PR #3305)

A running loan's page in the next app now offers to repay it in full. Anyone may repay a loan except its lender, so the action is shown to the borrower and to any other wallet, and left out for a reader who holds only the lender side. It is held, with the reason, once the grace period has ended (the loan then goes to default), while a swap-to-repay order is pending on the borrower position, and for a rental, which this page cannot repay yet. A lender's sale listing, a refinance request and the protocol pause never hold it. A loan in fallback stays repayable, since repaying cures it.

What a repayment costs grows by the second, and the protocol takes the figure as of the moment the repayment confirms. So the review shows two of the protocol's own figures: what it costs now, and what it would cost about thirty minutes ahead, never later than the end of the grace period. The second figure is read by asking the protocol for that moment, and the app checks that the connection really answered for that moment. The wallet approves exactly the later figure. The review says that a repayment confirming after that moment is refused with nothing moved, and that whatever the repayment does not use of the approval is put back afterwards. A wallet that does not hold the borrower position is told that paying gives it no right to the collateral. A refinance request posted for the loan is named too: the repayment ends it, but its offer stays posted until it is cancelled.

After the repayment the app reads the outcome back from the chain: the loan repaid, what left the wallet (which must lie between the two figures), and the unused approval put back to what it was before.

Paying part of a loan, adding or taking back collateral and the other loan actions come in later updates.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-POSITION-REPAY. Epic #3180.

_Committed 2026-11-08 00:42 UTC (43fa371e3)._
<!-- assembled-fragment: 3180-alpha05-repay-in-full.md sha256=f309a5eb5dec43249daf57956775c194879f0acc60cb4f678e7273b29a357d38 -->

## Thread — The next app collects interest owed from a position you sold (PR #3335)

Claims in the next app now has an "Interest from positions you sold" section. A lender who sells a position keeps the interest they earned while holding it, and were not yet paid, as a claim on the loan. The section lists every loan where this wallet holds such a claim or has money waiting from one. It finds them in the index. When the index cannot list them, the section says so and never shows an empty list. A loan can then be looked up by its number, which reads the chain alone, so a seller can always reach their money.

Each loan is read from the chain as the withdrawal reads it. It states what the wallet is owed, net of the loan's own fee on interest, and what already waits in the wallet's vault. While the loan runs, each interest payment pays the open claims first, oldest first. If nothing has reached the vault yet, the row says the claim is paid from later interest and offers no button. A loan in fallback waits. Once a loan has ended, withdrawing first splits what the lender side recovered: the holder's principal first, then each claim, oldest first. That split closes every open seller claim on the loan. In the loan's own token the review states the wallet's part exactly and what stays unpaid. In another token it states that the split pays by value when it runs.

The review names every figure and where the payment lands: the wallet, or a protected account's queue or vault. It includes the protocol's own dry run, which the send runs again, and asks for one wallet prompt. The finish card is read from the transaction's own record: each claim the split closed (paid in full, or short with what stays unpaid), and each payment where it arrived. A withdrawal stays on screen until its card is closed. The note listing what Claims does not yet collect no longer names seller interest.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-SELLER-CLAIM. Epic #3180.

_Committed 2026-11-08 09:57 UTC (504e08bf8)._
<!-- assembled-fragment: 3180-alpha05-seller-interest.md sha256=b92854e6a9acfb4203838a23e2ad18e8fdfbd988f27ffc45db39a157814a9e99 -->

## Thread — The next app takes collateral back from a loan (PR #3322)

A running loan's page in the next app now offers its borrower a way to take back collateral above what the loan needs. Only the holder of the borrower position may do this, so the action is shown to that holder alone. It is held, with the reason, while the protocol is paused, while a swap-to-repay order on the borrower position is pending, while a refinance request for the loan stands, when the protocol does not price the collateral token now, and when nothing can be taken back because all the collateral is needed to keep the loan within the protocol's limits. A loan in fallback is not running, so nothing is taken back from it.

The borrower types the amount, checked as it is typed against the protocol's own most that can be taken back now. The form says that this limit moves with prices and as interest accrues, and it offers no shortcut to the exact limit, since an amount at the limit would be refused once a moment of interest accrues.

No approval is needed: the collateral goes from the borrower's vault to the wallet that asks, in one wallet prompt. A wallet with protected account mode on gets it queued for the account's delay instead, and the review says so (or says the mode could not be read). That holds for a bought position too, because the protocol first moves its collateral into the holder's own vault. Where the account also requires a secondary signer to approve each release, the review and the finish card say that too. The review shows the collateral now and after, where it goes, the limit, and the loan's health factor and loan-to-value now. It says that taking collateral back moves the loan closer to liquidation, that the protocol checks its limits again when the withdrawal confirms (so a price move or a pause before then refuses it with nothing moved), and that the finish card shows the protocol's own figures after.

A lender's sale listing also holds a withdrawal, and no protocol view exposes that link (issue #3308), so the review asks the protocol to try this very withdrawal first and names that refusal; the send tries it again.

After the withdrawal the app reads the outcome from the transaction's own record: the collateral it left, the protocol's health factor and loan-to-value after it, and what arrived in the wallet, was queued for it, or was paid into the vault.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-POSITION-TAKE-BACK. Epic #3180.

_Committed 2026-11-08 05:33 UTC (6d09779bf)._
<!-- assembled-fragment: 3180-alpha05-take-back-collateral.md sha256=96bb1a66c0ef87d61dfc44897d4081f357510aff6db456d66b34ca356ec66298 -->

## Thread — The next app can deposit into your vault (PR #3372)

The next app's Vault page now takes a deposit: one token or NFT moved from the connected wallet into its own vault, outside any loan. The reader picks a suggested token or test collection, or pastes an address, and whether it is a token, an NFT or a multi-token collection is read from its contract. Then they type the amount, the NFT's token id, or the token id and how many. A Terms of Service version not yet accepted is asked for first, and the Terms are read again just before signing, so switching to a wallet that has not accepted them, or a version published meanwhile, sends the deposit back to the Terms prompt.

The review says what leaves the wallet and into which vault, and that the deposit creates the vault when there is none. It asks exactly the approval the deposit needs: the amount for a token, that one token for an NFT, and for a multi-token collection an approval granted for this deposit alone and taken back right after it, in one more wallet step. A paused protocol, a wallet the sanctions screen flags, a wallet retired by a replacement, or a wallet holding too little stops the review by name; a pause or screen that could not be read is stated and left to the protocol's own check.

The protocol's dry run runs once the approval is in place, so a token that does not arrive in full, such as one that charges a fee on transfer, is refused before the deposit is sent, and an approval the flow made is put back. The receipt says no token-safety screening runs, and how the deposit can leave the vault again: at once without protected mode, after the account's delay with it, and not at all while the account is locked, which the protocol does not stop a deposit for. The finish card states what the protocol credited and what the token's own record moved into the vault. While the protocol is paused, the panel says deposits are closed and what stays open.

Withdraw comes to this page next. Until then the page links the current app for it.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-VAULT-DEPOSIT. Epic #3180.

_Committed 2026-11-08 16:52 UTC (f886a78fd)._
<!-- assembled-fragment: 3180-alpha05-vault-deposit.md sha256=dd8b2f6e39bb19dc5118a238f7f2400bbfc6d380e497aeb1eb8a6dcf6bf34f30 -->

## Thread — The next app states a pause and its escape route on the Vault page (PR #3376)

While the protocol is paused, the next app's Vault page now says so at the top. Withdrawals are closed, while full and partial repayment and adding collateral stay open. Under an administrative pause, the page also says when the pause's escape route opens. That time comes from the protocol itself, is counted down against the chain's clock, and is never assumed. An automatic pause, or a protocol not yet launched, schedules no escape route, and the page says none is scheduled.

Once the escape route is open, the Withdraw button sends a wallet without protected mode through it. The review says the asset goes straight to that wallet through the escape route, and that the route never returns what a loan, offer or claim holds. A protected account keeps the ordinary withdrawal, which still waits out the account's delay in the payout queue. If the pause, the route or, under an open route, the account's mode cannot be read, nothing is sent and the review says why.

The finish card reads the protocol's own record of the escape withdrawal and the token's own transfer from the vault to the wallet.

The withdrawal copy no longer says only a protected account can withdraw under an open escape route.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-VAULT-ESCAPE. Epic #3180.

_Committed 2026-11-08 18:46 UTC (94ce5b6a8)._
<!-- assembled-fragment: 3180-alpha05-vault-escape.md sha256=f5e99bb19e19f5a7d4dcb4eb3eaf2d9d660e9982c4f487420ed7fe98c79ec3ca -->

## Thread — The next app shows what your vault holds and can create it (PR #3352)

Until now the next app's Vault page only said it was not built yet and pointed to the current app. It now shows the connected wallet's own vault on its network: the full vault address with an explorer link, and that the vault is a contract kept for this wallet alone, with nothing pooled with anyone else's, which assets leave only by the protocol's rules.

A wallet with no vault is told so and can create one. The review says nothing moves and no approval is asked, and that a deposit or a first offer would create it anyway. The protocol's own dry run decides whether it goes ahead. A wallet the sanctions screen flags is told the protocol creates no vault for it. The finish card names the vault address the transaction's own record gives.

Each asset shows the protocol's figures, read at one moment, and the app works none of them out itself. "In your vault" is what the protocol counts as the wallet's there: the smaller of the vault's balance and the protocol's record, so a token sent in by a plain transfer never raises it. "Free to withdraw now" is the protocol's own answer after every loan, offer, claim, reserve and queued payout. The rest is shown as held by the wallet's positions. If the vault holds less than the protocol counts, both figures are shown. A part that reached the vault outside the protocol is named as not counted and not withdrawable until adopted, with a link to adopt or disown it. VPFI in the vault is named as setting the fee-discount tier, and holding it for that pledges nothing: VPFI pledged to a loan or offer shows as held.

The page lists every asset in the vault's deposit record, and every asset named by the wallet's own records: every loan it was ever a party to or holds a position in, every offer it ever created, and every standing offer it owns. An offer's escrow stays in its creator's vault even after its position is passed on, so the page reads the offers the wallet made, not the ones it holds now. It says plainly that an asset sent by a plain transfer shows only if one of those names it, and says when a list could not be read in full. Empty rows and tiny leftover balances are hidden behind a switch that says how many there are.

Deposit and withdraw come to this page next. Until then the page links the current app for them.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-VAULT. Epic #3180.

_Committed 2026-11-08 15:59 UTC (11156bc3f)._
<!-- assembled-fragment: 3180-alpha05-vault-holdings.md sha256=9e660eefa6b1ebaa73880ba619156c7937f7787c6494ceb4ff01f26671d8b69a -->

## Thread — The next app's Vault page gets an account safety card (PR #3376)

The next app's Vault page now has an Account safety card. It shows whether the wallet's account runs protected mode, its delay, and whether a secondary signer must approve each release. It also shows whether position NFTs are protected, how many payouts wait in the queue, the lock (since when and by whom), and every change still pending with its time. The account's own payout queue appears under the card. It is the same queue the Claims page shows.

From the card, a wallet can turn protected mode on, lock its account at once, ask to unlock, and apply the changes that are due. In Basic mode, turning on uses the shortest delay the protocol allows, two days, with position NFT protection off, and the card says so. Advanced mode lets the reader choose up to five days and protect position NFTs.

Each review states what the account becomes and every consequence. Turning on never delays what the wallet owes others, and payments from other vaults land in the wallet's own vault. A lock cancels every queued payout and drops every pending change, and the review counts both. Repayment and adding collateral stay open, and a lock works during a pause. An unlock waits out the delay. Applying due changes applies all of them together, and a switch-off waits until no payout is queued. Each action runs the protocol's dry run at review and again before the wallet opens. The finish card reads the protocol's own events.

A protocol without the feature is shown as unavailable, never as off. If the mode cannot be read, the card offers no control and says not to assume protection is off. A wallet retired by a replacement is shown the wallet that now manages the account.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-VAULT-SAFETY. Epic #3180.

_Committed 2026-11-08 18:46 UTC (94ce5b6a8)._
<!-- assembled-fragment: 3180-alpha05-vault-safety.md sha256=1a531c2d9c5720b0bc40380df286f547faf1245c67446bf05c43edca0778eabd -->

## Thread — The next app can withdraw from your vault (PR #3375)

The next app's Vault page now takes a withdrawal: what is free in the connected wallet's own vault goes back to that wallet. Free means no loan, offer, claim, standing offer or queued payout holds it. The protocol's own figure decides, and the form shows that figure, reads it again each block and refuses more. Each asset with something free has a Withdraw button. An NFT the deposit record names only by its collection is withdrawn by typing its token id under that collection.

The app withdraws only to the wallet that signs and offers no other destination. The review names the vault the asset leaves and where it goes. Without protected mode it reaches the wallet at once. With protected mode on, it waits in the account's payout queue for the delay, and needs a secondary signer's approval where the account requires one. The review also says a queued withdrawal can be cancelled from the payout queue on the Claims page, and that no approval is asked.

A missing vault, a wallet retired by a replacement, a wallet the sanctions screen flags, a pause, a locked account, an amount over the free figure, or a refusal from the protocol's own dry run stops the review by name. A pause does not stop a protected account once the escape route has opened. A pause, screen or free figure that could not be read is stated.

The finish card states the protocol's own record of the withdrawal and whether it queued it, the queued payout with its release time, and what the token's own logs moved from the vault to the wallet.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-VAULT-WITHDRAW. Epic #3180.

_Committed 2026-11-08 17:37 UTC (895787d78)._
<!-- assembled-fragment: 3180-alpha05-vault-withdraw.md sha256=0bd3b00aadb72c818b1a0c0e2a87afd996d81f40bae4d35a8085dd964a105b84 -->

## Thread — The website and the next app go back to indigo (PR #3316)

The website and the next connected app share one brand palette, and that palette is indigo again. It had been the logo's navy and green since 2026-11-05; the owner found the earlier indigo easier on the eyes. Buttons, links, the active navigation item, tinted chips and the keyboard focus ring take the indigo in both light and dark themes, from the one shared palette file, so the two surfaces still match. The logo keeps its own navy and green.

Every text colour on a brand colour still meets the accessibility contrast floor (4.5:1) in both themes, checked by each surface's contrast test. The website's check that no stylesheet writes a brand colour out by hand now reads the brand colours from the shared file, instead of naming the colours the palette once held, so it keeps working whatever the palette is.

Epic #3180.

_Committed 2026-11-08 04:24 UTC (50c75ec7d)._
<!-- assembled-fragment: 3180-brand-indigo.md sha256=73008142844aae2a6605fa07ddfab3dc46bae9f9bf080a3a97859355b85dd032 -->

## Thread — Position NFTs leave the Diamond (PR #3205 part 1)

Who holds a loan or offer position is now recorded by its own contract, the PositionNFT, instead of in the Diamond's storage. The contract is a standard ERC-721 that cannot be upgraded. The Diamond can mint a new position's token there and do nothing else that moves one: it cannot transfer, approve or burn anyone's token. A faulty facet therefore can no longer rewrite who holds a position, and every payout, claim and authority check now reads the holder from this contract at the moment it acts. Positions move freely, wallet to wallet or on any marketplace, with no step in the app. This is the first half of #3205 (one vault outflow policy, checked twice); the vault-side half builds on it.

No position token is burned any more. When a position closes (its last claim is paid, its offer is cancelled, or it is handed to a new token in a sale or a handover), the Diamond retires the token. The token stays in the holder's wallet as a receipt that still shows its closed status, and the Diamond treats it exactly as it treated a burned token before. The lien-release and fee-tier steps that ran at burn now run at retirement. The Diamond's position lists skip retired tokens.

Every loan side now has its own token. When one offer was filled in several slices, the slices' loans used to take the offer's own token for the side that posted it. Now each slice's loan gets new tokens on both sides: the posting side's token goes to whoever holds the offer's token at that moment, and the filling side's goes to the filler. The offer's own token stays with the open offer and is retired when the offer closes. So each slice's claims, sales and closings stand alone. No amount changes: each loan pays the same principal, interest and collateral as before, to the holder of that loan's own token. The platform also refuses to register a token for a loan when the token already belongs to another loan. A read-only check of every loan on the Base Sepolia, Arbitrum Sepolia and BNB testnets found none sharing a token.

The backstop vault and the aggregator adapters recognise position NFTs by the PositionNFT's address, read from the Diamond. They accept a position only when the PositionNFT mints it, and they can never sweep one out, so a lender position they hold stays where its claim is paid.

Protocol routes no longer lock a position against transfer. The PositionNFT counts every transfer of every token, and the count only ever rises. A route that must complete for the holder who started it (a preclose offset, a lender sale listing, a collateral sale listing, a swap-to-repay order, a refinance request) records the count when it opens, and its completion reverts if the position has moved at all, even away and back. The route can then only be cancelled, and a swap-to-repay order reads as invalid to the order protocol. A route that another flow has since replaced counts as moved too, so an old holder's listing or order can never complete on a new holder's position. A holder who received the position may update its collateral listing, and the update re-arms the listing as theirs, so the updated listing can fill. Only the current holder's own update can do that. The grace-period auto-listing, which anyone may trigger, never revives a former holder's listing: it cancels it whole, keeping none of its price or fee recipients, and posts a fresh floor listing for the current holder. The worst outcome is a failed fill and its gas, never a payout to a former holder.

Protected mode's NFT protection is now the PositionNFT's holder lock. While it is on, the holder's tokens do not move, they cannot be approved, and approvals given before the lock are not honoured. A new position minted to the holder is locked from the start. Unlocking is the holder's own request at the PositionNFT and waits the holder's lock delay.
- **What the Diamond may do:** it locks a protected account's tokens when protection is switched on, on an emergency lock and on a primary replacement. It raises the lock delay toward the account's delay, up to a cap of 5 days that the PositionNFT holds. It cancels a pending unlock or a pending delay lowering whenever protected state begins or ends.
- **What the Diamond cannot do:** unlock a holder, or lower a delay.
- **What the lock stops:** a sale of the holder's lender positions, and a handover of their borrower positions, at the moment it would happen. A listing posted before the lock therefore cannot be accepted while the lock holds. A default, liquidation or grace-period sale still settles: it closes the position and hands it to no one.
- **What is removed:** the Diamond's queued position transfer, with its co-sign and its rows. A protected holder unlocks, after the delay, to move a position.

The PositionNFT's renderer (image, description and royalty) and its transfer check can each be replaced only by the Timelock. Each replacement waits at least three days, enforced by the contract, and the guardian may cancel it in that window. The Diamond is both for now.
- As the transfer check, the Diamond keeps the two rules the old in-Diamond transfer applied. First, no position moves into or out of a sanctions-flagged wallet; the check is fail-closed. Second, a closed loan's fee-tier exclusion follows the new holder.
- The PositionNFT's ownership can never be renounced.
- The handover moves its ownership to the Timelock and its guardian to the Pauser Safe.

This needs a fresh deploy. Every in-place refresh script refuses a Diamond that predates the PositionNFT. The design is §3.9 of [VaultOutflowPolicyDesign.md](../DesignsAndPlans/VaultOutflowPolicyDesign.md), with the build notes in §8.

> Caveat: until #3205 part 2, a protected account whose primary wallet was replaced keeps its positions on the old wallet under the holder lock; the old wallet can still ask to unlock and, after the delay, move them. Part 2 adds the transfer the account's vault verifies, which moves them to the new wallet. Both parts land before any deploy.
> Caveat: nothing yet automates the holder-unlock and lock-delay executions on the PositionNFT; a holder (or anyone) calls them after the delay. A keeper pass is a follow-up.

_Committed 2026-11-08 18:21 UTC (a8f1041f9)._
<!-- assembled-fragment: 3205-position-nft-contract.md sha256=a75d9127010c0fd78df39e4101450d63571b92b41e291dd5a4d89ac44b3c3733 -->

## Governance alerts say what a queued change does (#3237)

The ops watcher's alert for an operation queued in, or executed by, the governance timelock used to show only the called function's four-byte code. It now carries a plain-words line saying what the call does, for example "Grants PAUSER_ROLE to 0x… on the diamond", along with any native amount the timelock sends.

The line comes from the shared governance decoder that the public queued-changes page also uses, so an alert and the page describe a change in the same words. The watcher decodes the changes governance is expected to make: cutting the Diamond's code, its roles, ownership and pause, the timelock's own roles and delay, and the sanctions list's and delisting timelock's settings. A call to any other function is still alerted, named by its function code together with its exact call data, and is never guessed at.

_Committed 2026-11-08 00:13 UTC (cfb7f0db2)._
<!-- assembled-fragment: 3237-mesh-watcher-plain-words-calls.md sha256=fadbe7f7c3688141909a3cf5d3856c7b10016fa71ca3a525dd3577b2b32e15ca -->

## Thread — A shared, delayed registry for protocol endpoints (PR #3383)

A new standalone contract, the protocol registry, now ships with every fresh deploy. It holds the endpoints that the Diamond and every user vault must agree on, outside the Diamond, so a faulty facet cannot change them. It starts empty, but the deploy can seed both pointers and set members at construction without the delay, since a fresh deploy has nothing in use yet; that is the only write that does not wait. The standalone price guard (#3272) adds the first entry when it ships. The vault payout policy (#3205 part 2) then adds the treasury, the backstop, and the swap adapter and conduit sets, as data rather than code.

It holds two kinds of entry. A pointer is one address under a name; a set is a list of addresses under a name. Every change that adds trust waits: setting a pointer, adding a set member and lowering the delay are each proposed by the owner and applied by anyone once the delay has passed. The delay is never under three days, the same as the vault code delay, and never over thirty. Raising it applies at once. A change keeps the waiting time it was proposed with, whatever happens to the delay afterwards. Only one change can be pending per entry.

The guardian, the Pauser Safe after handover, can cancel any pending change. It and the owner can remove a set member at once, because a removal can only stop value moving. A pointer is never cleared, only replaced. Its consumers read it through a call that refuses an unset name, so no one treats an empty address as a real endpoint. The registry cannot be upgraded, and its ownership can never be renounced.

The deploy writes its address to the chain's deployment record, and the handover moves its ownership to the Timelock and its guardian to the Pauser Safe, like the VaultBeacon's. It advances #3272.

_Committed 2026-11-08 21:53 UTC (59f8ba7a6)._
<!-- assembled-fragment: 3272-protocol-registry.md sha256=49269aaa913260ce620e1bdf2da7a2db3639765f4f85075887e8c2ca9bde4cfa -->

## Thread — Refinance requests post the request their review described (PR #3312)

Posting a refinance request from the loan page always failed with "This offer's terms changed since you reviewed it". The review quoted the payoff ceiling at the request's last fillable moment, which it took from the chain time the page last read, plus the 30-day request window. The send then worked out the request's expiry again from the newest block, a few seconds later. While a loan accrues interest and the request's last fillable moment is still before the grace end, a later deadline means a slightly larger ceiling, so the guard against a grown ceiling refused essentially every send. A live drive on Base Sepolia loan 3 hit exactly this. The batch "Refinance all" late re-check had the same flaw.

The review now fixes the request it describes. The expiry it was quoted at travels with the figures shown, and the send checks, signs and posts that same request: the payoff ceiling, the permit's maximum and deadline, the guardrail window and the request's own expiry all come from it. A send therefore refuses only when something real changed: the loan, the fee configuration, the payoff route, or a ceiling that grew at the reviewed deadline. The time between review and send no longer counts as a change.

A fixed expiry only gets closer, so a review now has an age limit: 10 minutes of chain time, measured against the latest block's timestamp and never the device clock. Past that, the send refuses with a new message asking for a fresh review, and the page refreshes its figures. Ten minutes covers reading the receipt, giving consent and approving the wallet prompts. In a long batch, the last loans can reach the limit and are then left out, each with that message.

Because the request's window now counts from the review, the receipt says it expires "30 days after this review" instead of "after posting", so the disclosure matches what the chain records. Both new strings are translated in the nine translated locales.

The live refinance drive now anchors the borrower's time-stamped fields on the block it reads before the borrower page loads, which is the review's chain time, instead of a block read at submit. The permit deadline it expects is still derived from the expiry the posted request actually carried.

Closes #3311

_Committed 2026-11-08 03:07 UTC (f204ddad6)._
<!-- assembled-fragment: 3311-refinance-send-at-reviewed-request.md sha256=01414850ba0667fc71d67c952127a5b42bcaf2d596c4b73d83ad1f688c84a375 -->

## Thread — Anyone may clear a listing whose position moved (PR #3389)

A position NFT moves freely, and a listing or request tied to it can never complete once the position has moved. Before this change, only the offset and lender-sale offers could be cleared by anyone once their position moved. A collateral sale listing, a swap-to-repay order and a refinance request stayed in place until their own expiry. Until then the record stayed in storage and stayed visible in listing views, and the new holder had to deal with a flow that was never theirs.

Each of the three existing permissionless cancels now clears its route as soon as the position has moved:
- The collateral sale listing cancel works at once, fixed-price or Dutch, without waiting for grace or the auction's end. It is recorded with the position-moved reason.
- The swap-to-repay order cancel works at once, before the order's deadline. Both fill hooks already refuse such an order.
- The offer cancel now also treats a refinance request as dead once it is no longer its loan's recorded request on an unmoved position.

None of these cancels releases the loan's own assets: the collateral stays under the loan's lien. The swap-to-repay cancel, like every teardown of that order, also moves the borrower side to the position's current holder, so the still-liened collateral follows that holder into their vault; the others leave it where it is until repay, claim or default. A moved offer or refinance request can also be cleared inside the usual short cancellation cooldown, since nothing can accept it any more. What a creator put in personally, such as a refinance request's fresh collateral, goes back to that creator through the same refund an ordinary cancel makes. The caller receives nothing. No selector, event or storage changed.

This advances #3336. Still to come under that issue: the keeper sweep that finds moved positions and calls these cancels (the keeper thread's work, shipping disarmed), and hiding dead listings in the apps and indexer.

> Caveat: until the keeper sweep is armed, a dead listing is cleared only when someone calls the cancel.

_Committed 2026-11-08 23:01 UTC (ac2a2535b)._
<!-- assembled-fragment: 3336-moved-position-cancels.md sha256=68513b276986be0bbc2f4cf2c5b2afafc4387c6e6a63acd48896490be49f9bba -->

## Liquidity status reads pool depth that persists, not a single block (PR #3370)

Whether a token counts as liquid, and which depth tier it earns, used to be read from each pool exactly as it stood in the current block. Depth added and removed around one transaction could therefore make a weak token look liquid when a loan opened, and depth pulled just before a liquidation could make that liquidation refuse. The owner chose an on-chain fix.

A V3-style pool now counts only when its own on-chain record covers the averaging window (30 minutes by default), and its depth is the liquidity it held on average over that window. Opening a position, reading a tier or checking an offer's bounds credits the lower of the current depth and the average. A liquidation or a time-based default credits the average alone, so depth withdrawn in the same block cannot turn a liquid loan's sale into a refusal. The sale's own minimum output and the in-kind fallback decide what a genuinely thinner pool can fill. The recent-price check that compares the window's average price with the current price is now required, where before it was skipped for a pool without history.

V2-fork pools are no longer consulted at all, because they keep no time-weighted record of their reserves. Their three factory setters and getters, their events and the factory configuration script are removed. The three storage slots stay unused so the storage layout only grows.

The testnet mock pools now answer the same oracle query, with a record that starts a day before deployment and follows every later liquidity change. Deployed mock pools predate this and must be redeployed with the change, so it reaches the testnets at the next fresh deploy.

Closes #3354. Advances #830 and #1275: an attacker who holds real depth for longer than the window is not stopped by this, and keeper confidence and exposure caps remain open there.

> Caveat: a real pool created at the default oracle size has no history and reads illiquid until someone enlarges its record and the window passes.

_Committed 2026-11-08 16:39 UTC (6e0d10672)._
<!-- assembled-fragment: 3354-durable-liquidity-depth.md sha256=c5578eea57cc4f34298e7923223aba879bccd88ebcc182b17b9c7ea30344a3f7 -->

## Thread — Forced sales lose less on deep, calm markets (PR #3380)

Every forced sale of collateral used to accept losing up to the full 6% slippage cap to the market, whatever the asset. On a deep market in a quiet hour a sale fills for far less than that. The rest was room for a searcher to take from the sale, and the borrower paid for it, since what a forced sale fails to raise comes out of what is returned to them.

A new rule, read by every forced seller through one self-call (the health-factor liquidation on both routes, the partial liquidation, the liquid time-based default and the periodic-interest settlement), now tightens the floor to a figure set by depth tier. A collateral that clears the $5M probe at no more than 2% impact gets 2.5%, the $500k probe gets 3.5%, and the $50k probe gets 4.5%. The tighter floor applies only while the pair is calm and the loan is well cushioned. Calm means the collateral-to-principal oracle rate now is within 2% of the rate at each of the last two hourly checkpoints. Well cushioned means the collateral is worth at least 110% of the whole loan's debt, also for the periodic-interest sale, which covers only one period's shortfall. Anything else uses the full 6% at once. These are the owner's "Balanced" figures, chosen on 2026-11-08.

Every input the rule cannot establish falls back to the full cap: no checkpoint for either asset in either hour, a price that cannot be read, or a collateral shallower than the $50k probe. The rule can make a sale's floor tighter only when it has positive evidence, so a missing keeper or a stale price returns a sale to the behaviour before this change and never tightens it. The depth tier is measured the way a close-out measures liquidity (window-mean depth, no check against the pool's current price, #3354 and #3371). This change also values that depth at the oracle price instead of the pool's current price, for every close-out liquidity read, because the pool's price is part of how its depth is computed and a swap in the sale's own block could otherwise move the tier. Nothing in the sale's own block can move it now. A sale whose routes cannot meet the tighter floor takes the ordinary failed-swap path.

The hourly checkpoints are a new permissionless step. Anyone may record each asset's oracle reading for the current hour, and the first caller wins. A keeper pass will back it and will ship disarmed, so until it is armed every forced sale keeps the full 6%. The figures, the calm bound and the cushion are governance settings with bounded ranges, and the sale preview now reports the floor each sale will use.

The liquidator incentive is unchanged: it is still sized against the fixed 6%. The failed-swap retry and the borrower's own swap-to-repay keep their own floors.

The rule lives in a new facet, `SaleFloorFacet`, because the forced-sale host had about 300 bytes of contract-size headroom left. OracleFacet gains the close-out depth-tier read. The curated redeploy script refuses a Diamond that does not already route the rule, so the crossing is a fresh deploy or the all-facets refresh.

Closes #3359.

> Caveat: the tighter floors take effect only once the hourly-checkpoint keeper pass is armed; until then every forced sale uses the full 6%.

_Committed 2026-11-08 20:17 UTC (91fa95bd9)._
<!-- assembled-fragment: 3359-tiered-forced-sale-floor.md sha256=f205771789e49b3f13cb4f2b4e784f6d8628971c9e1a13267216add796447f76 -->

## Thread — Keeper fee balance alert

The keeper can now warn the ops chat when its wallet on a chain could not pay for the liquidations it may have to send. The liquidation backstop costs gas, and gas prices jump in the same market crash that makes liquidations due, so a wallet that drains quietly would fail exactly when it is needed.

Every tick, on each chain with a Diamond, the keeper reads its wallet's native balance and the fee a send is prepared at right now. It compares the balance with a reserve: twenty liquidations by default, each assumed to need 2.5 million gas, which is a deliberate overestimate. Both figures are settings. Below the reserve it posts a low-balance alert; below the cost of a single liquidation it posts a critical alert straight away, without waiting out the low alert's interval. Either repeats every six hours while it holds.

Each message gives the balance, how many liquidations it pays for, the fee and the assumptions behind the reserve, and on an OP-stack chain it says that the L1 data fee and operator fee are not counted. Once the balance is back above 120% of the reserve, one recovery message is posted and the alert closes. The margin stops a balance sitting on the line from flipping between low and recovered every tick. A balance or fee that cannot be read changes nothing and is noted in the run log.

The check is read-only and sends no transaction. It ships disarmed behind its own flag, so it stays off until an owner arms it on the keeper machine.

Closes #3365

_Committed 2026-11-08 16:03 UTC (821ee5c21)._
<!-- assembled-fragment: 3365-keeper-fee-balance-alert.md sha256=ba8a0dd774e157e779094d18cf47dafb60113d327b6998d4aa15cde291d92c2f -->

## Thread — Distinct liquidators per chain on the loan stats (PR #3368)

The indexer's loan stats now report how many distinct addresses carried out liquidations on the chain over the last 7 and 30 days. This is the trigger for the liquidation bonus auction (#3355): the auction gets built once a chain has at least five independent liquidators over 30 days. Before this, nothing measured that.

The protocol keeper is counted separately from third parties. It is identified by the chain's published keeper address, which is now recorded for Base Sepolia, Arbitrum Sepolia and BNB Testnet. The routes the auction threshold counts (Health-Factor liquidation in its single and split forms, partial, discounted) are kept apart from the internal match and the periodic auto-liquidation. Those two routes are shown, but they don't count toward the threshold.

The time-based default's liquidation event names no caller, so those liquidations are counted only as events and never assigned to an address by guesswork. #3367 adds the caller to that event.

Closes #3366.

> Caveat: The count is of distinct addresses, not independent operators. One party can run several wallets, so the auction threshold is a lower bar that still needs a human check.
> Caveat: A liquidation through a flash-loan receiver contract names that contract, so each receiver deployment counts as one address.

_Committed 2026-11-08 16:19 UTC (5dd76e01b)._
<!-- assembled-fragment: 3366-distinct-liquidators.md sha256=40467ab210158ed1a574d7b217e543468f96a81d17eaa835f4d430ea9dc86072 -->

## Thread — Liquidations keep running through a fast price move (PR #3374)

Whether a liquidation or a time-based default may sell its collateral depends on the collateral reading as liquid at that moment. Until now, that check refused every pool whose current price had moved more than about 3% from the pool's own 30-minute average, or away from the price feed. A sharp genuine drop does exactly that. So in a crash the collateral could read as not liquid: health-factor liquidations were refused, and a time-based default either moved the collateral in kind or was refused outright, until the pool's average caught up. Anyone willing to push a pool's price for one block could cause the same refusal on purpose.

Close-out checks now skip those two price checks, and credit the pool's 30-minute average depth (#3354) at its current price. New positions, tiers and offer bounds keep both checks, so a manipulated pool still cannot admit a position. A close-out does not need them: the forced sale demands an oracle-derived minimum output, and the in-kind fallback takes over when no route meets it. So a moved or pushed pool can fail to fill a sale, but never fill it at a bad price.

Closes #3371.

_Committed 2026-11-08 17:48 UTC (25e14d3d1)._
<!-- assembled-fragment: 3371-closeout-liquidity-price-checks.md sha256=562e4189c2e4374d950d4e39c0206d1d4afabceac9605681d8c1bcf8b1b8103d -->

## Thread — Vault-to-vault, fixed-rate positioning (PR #3317)

The website, the new app (alpha05), the whitepaper and the functional spec now
describe Vaipakam as non-custodial, vault-to-vault lending and borrowing at a
fixed rate and term that the lender and borrower agree, with no pool and no
middleman. The owner chose this on 2026-11-08 after a check of the contracts
confirmed the claim: a loan's rate is set when it opens and no pool,
utilization curve or oracle moves it.

The copy says "vault-to-vault" instead of "peer-to-peer (P2P)", because "P2P
lending platform" is a regulated category in several jurisdictions and
"vault-to-vault" names what actually happens: funds move directly between the
two parties' own vaults. "Vault" is always paired with "non-custodial" or "your
own vault" so it never suggests that Vaipakam holds people's assets. The
website's call to action no longer says "start earning", and its Spanish,
Chinese and Arabic versions no longer speak of yield.

Where the rate can change, the longer texts say so, without claiming every
change needs both parties: an extension near maturity needs both position
holders within limits each sets, while a handover to a replacement borrower is
started by the borrower alone, needs no lender consent, and pays the lender any
interest the new terms would cost them. The copy also says where funds sit:
offered funds and collateral wait in each user's own vault, and the loan amount
is paid from the lender's vault to the borrower's wallet. A refinance replaces the
loan rather than changing its rate. These rules are recorded as a copy rule in
the website spec.

alpha05's Home adds a fourth getting-started card, "A fixed rate you agree",
and its Borrow and Lend explanations state that the rate and term are fixed
when the loan opens. The frozen Terms of Service version is unchanged; a future
Terms version adopts the wording.

_Committed 2026-11-08 04:05 UTC (f290204eb)._
<!-- assembled-fragment: positioning-vault-to-vault-fixed-rate.md sha256=028682e69e436c06f35edb3374c3259cd1325294e1fd6595e46adad992f8201f -->
