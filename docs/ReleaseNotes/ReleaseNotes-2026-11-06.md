# Release Notes — 2026-11-06

The day a loan ends no longer earns an interaction reward. Illiquid deals now need a standing pair consent armed ahead of the accept, and risk-access changes can no longer be relayed or pre-signed. Under protected mode, removing a Telegram alert chat now waits the protected delay. The next connected app, apps/alpha05, can now borrow and lend end to end:
- take an offer, or post a borrow request or lending offer;
- ranges, parts and fill modes;
- interest schedules and the Full fee tariff;
- NFT and multi-token collateral;
- the risk-access step;
- a review table with shortened figures.

On the keeper and ops side:
- a fresh Base can no longer launch rewards with an unfunded pool;
- a refused remit alerts the ops chat;
- Arbitrum remit acknowledgements are no longer sent twice;
- the mesh watcher names JSON-RPC errors instead of calling them unclassified.

Each section records its change as it was merged.
## The day a loan ends earns no interaction reward

Interaction rewards count whole days, each priced at a full day of the loan's notional interest. A loan's reward days started the day after it opened and ran through the day it closed, so the closing day counted in full however little of it the loan lived. A loan opened at 23:59 and repaid at 00:01 earned a full reward day for both sides, for two minutes of interest and the 0.2% initiation fee, and both sides could be wallets one person controls.

The owner chose on 2026-11-05 that the closing day earns nothing. A loan's reward days now run from the day after it opens up to, but not including, the day it is repaid, preclosed, refinanced, defaulted or liquidated. A loan opened and closed across one day boundary earns no reward day. A refinance ends the old loan like any other close; the new loan earns from the day after it starts, as every new loan does.

Where the same loan continues, no day is lost: an in-place extension, a preclose obligation handover, a lender position sale, and a consolidation that splits an entry between its earner and the holder all split at the start of the day they happen on. That day belongs to the continuing entry, the holder the day ends with; before, the outgoing entry kept it. A continuation followed by a close on the same day therefore earns nothing for that day on either slice, so no sequence of steps can carry a closing day out of the rule. On a loan's opening day the continuing entry still starts the next day.

Funds: nothing is transferred differently. A loan closed on or before the reward day its term ends gives its lender and borrower one reward day less than before (the closing day), so a loan repaid at maturity earns all its contracted days but the last; only a loan closed on a later reward day keeps the whole window, so the day's reward pool is shared among the loans that were open for the whole day. The per-loan and per-interest caps are unchanged.

This changes contract code only, so it reaches a chain through a fresh deploy or the all-facets refresh. Closes #3171.

_Committed 2026-11-06 00:26 UTC (2b2bb6c30)._
<!-- assembled-fragment: 3171-closing-day-earns-no-reward.md sha256=5188984a551c5e3aae9b0bde0112877a6fc7b00d49fa903f43a89553f8079b2b -->

## App — The next app asks for a standing pair agreement before taking an offer on an illiquid pair (PR #3234)

Taking a lender's offer on an illiquid pair used to go through on the acknowledgement every acceptance carries, without a standing agreement to that pair. The owner decided on 2026-11-06 that this acknowledgement no longer stands in for the agreement: the borrower taking an offer needs a recorded agreement to that exact pair, in effect after any waiting period, just like the lender who posted it. The protocol change is #3231.

The next app's Borrow page now applies this rule. An offer on an illiquid pair that the wallet has not agreed to is shown as needing a step, the review offers the pair agreement in place, and the offer can be taken once it is in effect. This is also correct on networks still running the earlier rule: the agreement clears the block there as well, so nothing is wrongly held back. The Advanced guide's risk-access section says so in every language.

Epic #3180.

_Committed 2026-11-06 09:55 UTC (b7d17719a)._
<!-- assembled-fragment: 3180-alpha05-accept-pair-consent.md sha256=011d6e101ab064a502d7028dc9e441733ca161e7edccac57df76c4ff1dd51162 -->

## App — The next app can borrow: take a lender's offer whole, with every figure shown (PR #3221)

The Borrow page of the next connected app opens. A borrower chooses what to borrow and what to lock, from the tokens the network's deployment record suggests or by pasting a token address, and each token's class is read live from the protocol: priced and liquid, illiquid (valued at zero and handed over as-is on default), or a price the protocol currently distrusts, which closes new loans on it. A pasted address carries a note that no token-safety screening runs on this network. The pair is remembered per network in the browser only.

The page then lists the lender offers open for that pair, read from the protocol's own index through the wallet's connection (or the public read path without a wallet). Each offer is written as the borrower would live with it: the amount at the lender's floor rate for the term, the collateral asked, the loan-to-value at today's prices or why it cannot be worked out, the interest mode, partial repayment, any interest schedule and what a missed period costs, the expiry, and what the borrower would receive after the initiation fee. An offer the protocol would refuse says why, in its own terms, and offers no button. Offers the page cannot take yet (borrow requests, NFT legs, the reader's own) are counted, never silently dropped, and the order (takeable first, then lowest rate, then larger amount) is stated as an order, not advice.

Taking an offer opens the full review before the wallet: what arrives in the wallet, the fee and how it is set (including the small share of it the protocol pays back to whoever sends the acceptance, which on a direct take is the borrower), the amount locked in the borrower's own vault (opened in the same transaction if needed), the rate, the amount owed on the due date (labelled as the figure with no pause, since a pause moves the date and interest keeps running), the grace period, the interest mode and schedule, every lifecycle term the signature binds even when it is the default (partial repayment, selling the collateral during or before the loan, stated as unusable on token collateral since both sale routes need an NFT, any refinance or linked loan), the lender, and whether a token approval is needed. The consequences follow plainly: default after grace, liquidation or, for each leg that is illiquid, that leg named and the in-kind handover, the lock, the interest commitment, and that signing records a binding agreement. Confirm waits for an explicit consent to the Risk Disclosures and Terms, bound to the figures shown: a re-read that changes them clears it. A wallet short of the collateral is told by how much and cannot confirm; the review is read again each block while it is open, so funding the wallet (or any other blocker clearing) lifts it without reopening the panel. The offer list reads the same risk-access verdict as the review, so an offer the protocol's risk check would refuse for this wallet is never shown as takeable. When the protocol refuses because a vault is below the required version, the review says whether it is the borrower's own vault or the lender's. When Terms are in force and not yet accepted, they are asked for first.

The wallet is asked to sign the exact terms first, which costs nothing and moves nothing; then, only if the allowance falls short, to approve exactly the collateral locked; then the acceptance is dry-run with the real signature and sent only if the protocol would accept it. The allowance is read again before the first prompt, and if anything stops the acceptance after an approval, including a sent acceptance that reverts because someone took the offer first or that the wallet cancels or replaces, the app asks to put the approval back to that value and says whether that happened. Every approval step, the reset included, is judged by reading the allowance back after it lands, never by the transaction's status, so a step the wallet cancelled or replaced is reported as not done. A token that will not move one non-zero approval straight to another, which the app asks the token itself, gets a step to zero first, and the review counts that as an extra wallet prompt. Terms are read again right before the wallet opens. The outcome is measured from the acceptance's own transaction: the loan it opened for this borrower, the amount that arrived in the wallet, checked to add up with the rest of the fee to the principal the loan records, and the collateral that moved into the vault, each against the review's figures, with anything the logs do not show reported as unknown.

Posting one's own borrow request, NFT collateral, pair consents and the Advanced options come in the next Borrow updates; the page says so instead of hiding them. The user guide's Basic and Advanced editions gain Borrow sections in every language.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-CONFIDENCE, RB-REVIEW, RB-FUNDS, RB-CLICKS. Epic #3180.

> Caveat: the initiation fee shown is the protocol's own preview for the wallet; the tier applied is the one in force when the acceptance lands.

_Committed 2026-11-06 03:34 UTC (69f14603b)._
<!-- assembled-fragment: 3180-alpha05-borrow-accept.md sha256=71e1f9cf8b0cb933e0141ddc4aa8fdef56d43bc6eb59dfe95e800e1c2349e325 -->

## App — The next app can post a borrow request: your own amount, rate and term, with the protocol's own verdict before you sign (PR #3226)

When no lender offer fits, a borrower on the next app's Borrow page can now post their own request for the pair instead. The form asks for the exact amount, the collateral (with a Max button for the whole wallet balance), the yearly rate, the term, how long the request stays open, how interest is charged if the loan is repaid early, and whether partial repayments are allowed. Every figure is read exactly as typed: more decimals than the token has, a rate above 100% or two decimals, or a term beyond the longest one the network allows are each refused in place with the fix, never rounded. The terms offered are only those the protocol has open, read from it, and a term can also be typed in days. A live line shows what the borrower would receive at today's fee rate and owe at the due date if a lender took it now. On a phone that line and the Review button rest just above the bottom bar, full width, where the thumb reaches.

The review is the protocol's own answer to the request, asked as a dry run from the borrower's wallet, so every rule the protocol applies when a request is posted is in it without the app restating any of them. It shows what is locked in the vault now (the vault is opened in the same transaction if needed), the amount asked, that it is filled whole by one lender or not at all, the rate, the due date counted from when a lender takes it, the grace period, what would arrive in the wallet and the fee behind it, both at today's fee rate and labelled as not bound by the request (the fee is set at the rate in force when a lender takes it, less the borrower's discount tier then), what is owed at the due date, every lifecycle term the request binds, even the defaults, when it lapses, the loan-to-value at today's prices, and whether a token approval is needed. The consequences say plainly that the collateral stays locked while the request is open and can be taken back by cancelling from five minutes after posting, that a lapsed request can no longer be taken but its collateral stays in the vault until the borrower or anyone closes it and then returns only to the borrower's wallet, that a lender who takes it opens the loan at once without asking again, and the usual default, liquidation and interest commitments. A wallet that does not hold the collateral is told by how much and cannot confirm; the review is read again each block while it is open.

Posting takes an approval for exactly the collateral when the wallet's current approval does not cover it, and then the request itself. Before the approval the protocol's dry run can only get as far as pulling the collateral, so a stop there is named as the approval's to clear, and only an error the protocol names counts as a refusal; after the approval the request is dry-run again and sent only if the protocol would accept it. If anything stops it after an approval, the app asks to put the approval back and says whether that happened. The outcome is measured from the transaction's own logs: the request the protocol recorded for this wallet, and the collateral that moved into the vault. This app's Offers page is not built yet, so the review says before anything is locked that following, cancelling and closing the request is done on the current app's Offers page, and links there; the finish card hands on to the same page. Both links come from the page map, so they switch to this app's own Offers page the day it is built.

The approval steps that taking an offer and posting a request share now live in one module, so the two flows cannot drift apart on how an approval is judged, reported or put back. Buttons gain a hover state across the app.

NFT collateral, pair consents and the Advanced options (ranges, fill modes, interest schedules) come in the next Borrow update. The user guide's Basic and Advanced editions gain sections on posting a request in every language.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-CONFIDENCE, RB-REVIEW, RB-CLICKS, RB-A11Y. Epic #3180.

> Caveat: the amount received and the fee shown are today's figures, not a promise: the fee is charged when a lender takes the request, at the rate in force then, less whatever discount the borrower's tier gives at that moment. A request left open can meet a different fee rate.

_Committed 2026-11-06 07:16 UTC (4f397e2a2)._
<!-- assembled-fragment: 3180-alpha05-borrow-request.md sha256=7e8beb16d43ea924e01115c422ded8e371331b872848f419d3596c779aec2082 -->

## App — The next app lets a borrower lock a quantity of a multi-token NFT as collateral (PR #3245)

A borrow request on the next app's Borrow page can now lock NFTs that come in quantities (the multi-token standard, ERC-1155), not only single NFTs. Until now the page named such a collection and sent the borrower to the current app; that hand-off is gone.

For a multi-token collection the form asks for the token's number and how many of it to lock, and says straight away how many of that token this wallet holds, with a button to fill all of them. The review names the quantity and the token, says the collateral is valued at zero so there is no loan-to-value and no price-based liquidation, and that on default the lender receives the tokens themselves. A wallet holding fewer than the quantity is blocked in place with nothing offered to sign.

The multi-token standard has no approval for one token: the protocol can only be allowed to move every token the wallet holds in that collection. So posting grants that approval for this request alone and takes it back in one more wallet step afterwards, whether the request went through or not; the review counts both steps among its wallet prompts and says so. If the wallet had already granted that approval before, it is left exactly as the wallet set it and only the request is signed. Each step counts only when the chain reads it back, and a take-back that did not land or could not be read is stated with what to check in the wallet. While the request's own receipt cannot be read, the page says the approval still stands until it settles. The outcome is read from the transaction's own logs: the request recorded, and exactly that quantity of that token moved from the wallet into the borrower's vault.

The testnet faucet on Home gains a multi-token test collection that mints ten of a fresh token at a time, so the flow can be tried. It reaches each testnet with that testnet's next test-asset deployment; until then the collection is not offered there.

The user guide's Basic and Advanced editions describe locking a quantity of a multi-token NFT in every language.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-NFT-APPROVAL, RB-REVIEW, RB-CONFIDENCE. Epic #3180.

_Committed 2026-11-06 11:38 UTC (6131396e5)._
<!-- assembled-fragment: 3180-alpha05-erc1155-collateral.md sha256=332000166b4b5e9b4c431a2d78d4d255b40293ba7c85ce30ca2edafa3c2b21f4 -->

## App — The next app gains icons with fixed meanings and a left navigation column (PR #3224)

The next connected app now uses a small set of icons. Each icon has one meaning and is never reused for anything else. An icon is there to catch the reader's eye. It never replaces the words: every icon sits beside text that says the same thing and is hidden from screen readers, so someone who cannot see it misses nothing. The closed list is: something to act on (warning notices), something blocked (refusals), done (confirmations), funds leaving the wallet (a review row that moves funds out, or an approval that lets them move), a wallet signature (the confirm button), waiting on the chain (signing, sent, mined), a figure the app could not read (beside the word "unknown"), and the info button. Plain information notices carry no icon, so an icon always means "look here".

The info button "(i)" replaces the old "Why?" link. It shows only the icon, right after the sentence it explains, and opens the same help panel. Screen readers hear it as "Why?" followed by that sentence. Its tap area is 44 px square on every screen, though the icon is drawn small so lines keep their height. It opens on a tap, never on hover, because touch screens have no hover. The choice follows usability research: icons need visible labels, and the info button is the one shape whose label is the sentence it follows.

On phones, each destination in the bottom bar shows its icon above its name, and the name always shows. The phone's More sheet now always covers the page beneath it: before, an info button further down could show through.

On wider screens the navigation leaves the header, which had wrapped onto several rows in Advanced mode. From 720 px the header is one row (brand and wallet) and the destinations sit in a left column below it. Up to 1023 px it is a slim rail, each icon above a short name. From 1024 px it is a panel, each icon beside its name. The pages only Advanced adds are grouped after the Basic ones under their own label, and the mode and theme controls sit at the foot of the column. From 1024 px the panel can be collapsed to its icons with the main-menu button, three lines at the far left of the header with no words beside it, the control most web apps use for this. Screen readers hear it as Main menu, along with whether the panel is expanded, and a pointer resting on it shows the same name as a tip. The browser remembers the choice. While it is collapsed, resting the mouse on it for about a third of a second, or moving keyboard focus into it, shows the full panel over the page without moving the page. Moving away for half a second, or pressing Escape, folds it back. Folding, revealing and unfolding are animated: the panel and the page beside it slide over about a quarter of a second while the names fade, and the icons stay where they are. A device set to reduce motion gets no animation. On touch screens, which have no hover, the menu button is the way to expand it. The header also grows when the wallet control has a notice to show, such as a network the app does not serve, and the column moves down with it. The layout follows the common pattern: a bottom bar on phones, a rail on medium widths, a side panel on wide ones. The breakpoints are close to the compact, medium and expanded window classes those systems use. Counts on navigation, such as how many claims are waiting, will come with the pages that own them. The rule is recorded as RB-ICONS in the alpha05 design rulebook. The shapes are from an open icon set (ISC licence), carried in the app as data, so the app adds no dependency. The user guide's Basic edition describes the info button in every language.

Advances #3180.

_Committed 2026-11-06 05:31 UTC (18469c08e)._
<!-- assembled-fragment: 3180-alpha05-icons.md sha256=0a77a417aa1fac0f75602441438d97550e6d41113cdbb57853cd63e1632d2401 -->

## App — The next app can lend: fund a borrower's open request, with every figure shown (PR #3252)

The Lend page of the next connected app opens. A lender chooses what to lend and what collateral to accept, from the tokens the network's deployment record suggests or by pasting a token address; both must be tokens, and an NFT collection chosen on either side is named as such with the reason this page does not take it yet. The page lists the borrow requests open for that pair, read from the protocol's own index through the wallet's connection (or the public read path without a wallet). Each request is written as the lender would live with it: the amount at the borrower's highest rate for the term, the collateral the borrower has already locked, the loan-to-value at today's prices, the interest mode and any schedule, and how much of the borrower's fee comes back to the lender. The reader's own requests, lender offers, NFT legs and sales of running loans are counted apart, never silently dropped, and the order (fundable first, then the highest rate, then the larger amount) is stated as an order, not advice.

Funding a request opens the full review before the wallet: what leaves the wallet, what the borrower receives, the borrower's initiation fee and the share of it the protocol pays back to whoever sends the acceptance (here the lender), whether the borrower chose the Full fee tariff (which can only lower that fee), the collateral held for the lender, the rate, the interest owed at the due date, the protocol's share of that interest at today's rate as an upper bound (fixed when the loan opens and lowered by the lender's fee-discount tier while the setting is on, which the review says when it is off), what comes back if repaid on the due date, the grace period, every lifecycle term the signature binds, the borrower, and whether an approval is needed. A wallet short of the amount is told by how much and cannot confirm. A borrow-side offer that is really the sale of a running loan's lender position is blocked by name, because buying a running loan is a different flow.

Signing follows the same path as Borrow: Terms first when one is in force, then the exact terms signed for free, an approval of exactly the amount only when the allowance falls short (with an approval that a stopped flow leaves behind put back and said so), a dry run of the acceptance with the real signature, and only then the acceptance. The outcome is measured from the acceptance's own transaction: the loan it opened, the amount that left the wallet and the share of the fee that came back, each against the review.

Under the hood, Borrow and Lend now share one accept flow whose role is the acceptor's side, so a fix to the review, the signing or the measurement reaches both. Posting one's own lending offer, NFT legs and the Advanced options come in the next Lend updates; the page links to the current app for the first. The user guide's Basic and Advanced editions gain Lend sections in every language.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-LEND-ACCEPT, RB-CONFIDENCE, RB-REVIEW, RB-FUNDS. Epic #3180.

_Committed 2026-11-06 17:57 UTC (ec05aa14d)._
<!-- assembled-fragment: 3180-alpha05-lend-accept.md sha256=815eaf5826216607fbdc77333020e233a936f70adf0b052f3eda0e0b90e89fd3 -->

## App — The next app lets a lender post an offer in parts (PR #3258)

In Advanced mode, a lender posting their own offer on the next app's Lend page can now let matches lend it in parts, and can choose how it fills. The amount typed stays the whole amount: posting locks all of it, and a borrower taking the offer directly still borrows all of it, which is how the protocol sizes a direct take of a lending offer. The lender adds the smallest part one match may lend; a part larger than the whole amount is refused on the form.

The review's figures are the whole amount's. It also states the smallest part and the least collateral a match asks for it: the protocol pro-rates the collateral the lender asks for the whole amount to the part matched, rounding down. The consequences say that matches lend the offer in parts at the lender's rate while matching is switched on for the network (the switch is stated whether on, off or unread), that once a match has lent a part no borrower can take the rest directly (cancelling takes it back), and that when less than the smallest part is left the protocol returns it to the lender's wallet and closes the offer.

The fill mode is now offered to a lender as well as a borrower: partial by default, all or none for one loan of the whole amount (so not with parts), or immediate or cancel, which needs an expiry. Any mode other than the default, and any offer in parts, is stated as fixed once posted. Options set in Advanced still apply in Basic, which says so and offers to clear them.

When the protocol refuses an offer because it asks for less collateral than the whole amount needs at today's prices, the review now names that as the lender's to fix and states the least collateral the protocol asks, instead of showing the raw reason. The lender's interest schedule and fee tariff follow in a later update; in Advanced mode the form says so.

The user guide's Basic and Advanced editions describe an offer in parts in every language.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-LEND-POST. Epic #3180.

_Committed 2026-11-06 20:50 UTC (e5df3f1c6)._
<!-- assembled-fragment: 3180-alpha05-lend-offer-parts.md sha256=82b4349dd554e6ed64fad5585041e7317a3b0f579e8bef3a79758a21d94eb7f3 -->

## App — The next app lets a lender choose an interest schedule and the Full fee tariff (PR #3259)

In Advanced mode, a lender posting their own offer on the next app's Lend page can now choose an interest schedule and opt into the Full fee tariff, the two options a borrower posting a request already had. Both use the same form fields and the same protocol reads on both sides, worded for each.

A lender's schedule is admitted at the smallest part one match may lend (or the whole amount, without parts), because that is the amount the protocol checks when the offer is posted. So a schedule the whole amount would clear stays closed, with both figures stated, while the smallest part is under the protocol's threshold. Each loan's own amount is checked again when it opens. The review states each period's interest on the whole amount and on the smallest part, the whole term's interest as a total that the instalments count toward, and that a period left unpaid past its grace lets anyone sell part of the borrower's collateral to pay the lender, with the loan staying open.

The tariff is quoted in the form at the whole amount, the largest loan the offer can open (a direct take), and in the review at both ends. The review states what it costs, what it gives a lender (10 more points of discount on the protocol's share of the loan's interest, up to the 50% cap, for the loan's term; lost for a new term after an extension; belonging to whoever holds the lender position), the gap before it is set, during which a loan can open without it, and each refusal the protocol's reads predict under the rule the lender chose. A choice that would refuse every loan blocks the review, as it does for a request.

As for a request, the tariff is set by its own transaction once the offer has posted. The Lend page shows that step, measured like the post, and holds back a new offer until it ends. Its text names the offer and says the protocol refuses the step once the offer is taken in full or closed.

The user guide's Basic and Advanced editions describe the lender's schedule and tariff in every language. The form no longer says these options come later.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-LEND-POST. Epic #3180.

_Committed 2026-11-06 21:44 UTC (a5b91be45)._
<!-- assembled-fragment: 3180-alpha05-lend-offer-schedule-tariff.md sha256=9ac0015180c9a861ea333b49dba8490db8eb49a4a9db4649b751849851f8d573 -->

## App — The next app lets a lender post their own lending offer (PR #3255)

The next app's Lend page now lets a lender post their own offer when no borrow request fits. The lender types the exact amount they lend, the collateral a borrower must lock, the rate, the term, how long the offer stays open, the interest mode and whether partial repayments are allowed. Every figure is read exactly: more decimals than the token has are refused, never rounded. Because the amount lent is what posting locks in the lender's vault, the form shows the wallet's balance of it, with a Max button.

The review is the protocol's own verdict on the offer, tried as a dry run from the lender's wallet. It states what locks now, the amount a borrower takes and the collateral they must lock, and what the borrower would receive at today's fee. The fee is the borrower's and never comes out of the amount lent. It also states the interest at the due date, the protocol's share of that interest at today's setting as an upper bound, and what comes back if the loan is repaid on time. Every term the offer binds is listed, along with the loan-to-value at today's prices. If the protocol's share cannot be read, the review says so rather than showing zero. The consequences are the lender's own: the lock while the offer is open, the lapse, a borrower opening the loan at once, a match lending the whole amount at the offer's rate, default, liquidation, and the position token. A wallet that holds less than the amount is told how much is missing and offered no signature.

Posting asks the wallet to approve exactly the amount if needed, tries the offer again as a dry run, and only then sends it. If anything stops it after an approval, the approval is put back. Some tokens, wrapped ether among them, refuse a pull beyond the approval without naming an error, and the protocol reports that as a failed vault deposit; while the approval is short, the review now reads that answer as the approval still to give rather than as a refusal. This also fixes the same case for a borrower's request. The outcome is read from the transaction itself: the offer recorded as a lender's, and the amount that moved into the vault.

The borrower's request and the lender's offer now share one posting flow, keyed by the side that posts, so the two cannot drift apart on a shared rule. The lender's Advanced options (a range, a fill mode, an interest schedule and the fee tariff) and offers that ask for an NFT follow in later updates; in Advanced mode the form says so.

The user guide's Basic and Advanced editions describe posting a lending offer in every language.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-LEND-POST. Epic #3180.

_Committed 2026-11-06 19:13 UTC (28b9d1ff2)._
<!-- assembled-fragment: 3180-alpha05-lend-offer.md sha256=892a79da9a50573ab60cfe9a8879ee4d37ff3b1c6692094cbd936d0aa06a5050 -->

## App — The next app lets a borrower post a request that locks one NFT as collateral (PR #3234)

A borrow request on the next app's Borrow page can now lock an NFT instead of a token. The test NFT collections a testnet publishes are offered beside the tokens, marked as NFTs, and any collection can be pasted. Whether a pasted address is a token or an NFT collection is the contract's own answer, read from it; if that read fails, the page says the kind is unknown and offers no request rather than guessing.

For an NFT, the form asks for the NFT's number (its token id) instead of an amount, and says straight away whether this wallet holds it, another wallet does, or no such NFT exists. The review names the NFT being locked, says the NFT is valued at zero so there is no loan-to-value and no price-based liquidation, and that on default the lender receives the NFT itself. A token another wallet holds, or one that does not exist, blocks the request in place with nothing offered to sign.

Posting asks the wallet to approve the protocol for that one NFT only, never the rest of the collection, and only when it is not approved already. The approval counts only when the chain reads it back after it lands. If the request does not go through afterwards, the approval is put back while it still reads the protocol and the wallet still holds the NFT; otherwise the app says what it found instead of overwriting it. Moving the NFT into the vault clears the approval by itself. The outcome is read from the transaction's own logs: the request recorded, and that exact NFT moved from the wallet into the borrower's vault.

NFTs that come in quantities (the multi-token standard) need an approval over the whole collection that must be taken back afterwards, so for those the page says so and links the current app's Borrow page until that step is built. Taking a lender's offer that asks for an NFT as collateral is also still left to the current app; the offer list counts such offers.

The user guide's Basic and Advanced editions gain a section on NFT collateral in every language.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-NFT-APPROVAL, RB-REVIEW, RB-CONFIDENCE. Epic #3180.

_Committed 2026-11-06 09:55 UTC (b7d17719a)._
<!-- assembled-fragment: 3180-alpha05-nft-collateral.md sha256=4896e5809584435c3b9269f98a0c6c844d05c137e3f3b2b537e9da50e169de54 -->

## App — The next app's review table reads cleanly, with shortened figures (PR #3260)

The review shown before signing in the next app was hard to read: a long label set the width of the label column and squeezed every value into a narrow strip, and long token amounts broke across lines in the middle of a number. Labels and values now sit in two even columns with a hairline between rows, a number never breaks across lines, and on a phone each label sits above its value.

Token amounts are now written for reading across the app: digit groups (1,000 rather than 1000), and the fraction shortened to four places once there is a whole part, or to four significant digits below one. The cut is always toward zero, never rounded up, so a small amount never reads as zero. A shortened figure is marked approximate (≈), and a review that holds one offers "Show exact figures", which shows every digit in place, in the table and in every sentence of the review that names an amount. A figure the protocol acts on exactly as written, such as an approval or the tariff ceiling, is always shown in full.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-FUNDS. Epic #3180.

_Committed 2026-11-06 22:32 UTC (cee5f1ccb)._
<!-- assembled-fragment: 3180-alpha05-readable-figures.md sha256=df56452a73fd397f91c445776b08aeaba0eadc959f85bce5bb87ad268261efe3 -->

## App — The next app lets a borrower opt a request into the Full fee tariff (PR #3251)

In Advanced mode, the borrow request on the next app's Borrow page gains the Full fee tariff. It is a VPFI fee, paid from the borrower's vault when each loan opens, that adds ten points to the discount on the loan fee, up to the protocol's cap. The loan fee itself is still charged in the lending asset. The form offers the choice only while the protocol has the tariff switched on, and says so when it is off.

The form shows today's tariff as the protocol quotes it for the amount and term typed. The borrower sets the most VPFI one loan may take, which defaults to today's tariff for the largest loan, and chooses what happens to a loan that cannot take the tariff when it opens: it is refused, or it opens without the tariff.

The review states the choice, whether the tariff is switched on now, today's tariff (at both ends of a range), the ceiling, the rule, and the free VPFI in the vault, read the way the protocol's charge reads it. In Basic too, it warns that each loan pays its own tariff and it is not refunded, and that the tariff is set by a second transaction after the request posts, so a lender who takes the request before that transaction confirms opens a loan without it. Each condition that fails now is stated as what it does to a loan under the chosen rule. A choice under which every loan would be refused stops the review until it is changed.

After the request posts, the tariff opens as its own step under the finish card. It reads the request again before the wallet opens, refusing in place if a lender has already taken it, and confirms the result by reading the request back.

The form also states that backstop lending for requests nobody takes is not offered in this app yet. The user guide's Basic and Advanced editions describe the tariff in every language.

A single-amount request's review no longer lists the default fill mode as "one or more matches" beside the line that says one lender takes all of it; it names the fill mode only when the request has a range or uses a mode that changes how it fills.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-TARIFF, RB-MODE, RB-SWITCH. Epic #3180.

_Committed 2026-11-06 16:32 UTC (32eeeae81)._
<!-- assembled-fragment: 3180-alpha05-request-full-tariff.md sha256=5070601a381ada2b49ce8b5901e2003de6b8d32a4a25df38829393ce89e435b8 -->

## App — The next app lets a borrower choose an interest schedule, offering only what the protocol admits (PR #3250)

In Advanced mode, the borrow request on the next app's Borrow page gains an interest schedule. Instead of paying all the interest at repayment, a borrower can choose to pay it every month, quarter, six months or year. The form asks the protocol which schedules the terms on screen allow. The protocol answers with the same rule it enforces when the request is posted, so the form offers exactly what posting will accept and the app never works the rule out for itself.

Under each closed schedule the form says why, using the protocol's own reason. Periodic interest may be switched off on the network. One of the assets may have no price. The loan may be worth less than the protocol's threshold, in which case both figures are named. Or the period may not be shorter than the loan. While that answer is loading, or could not be read, only interest at repayment is offered, and a schedule already chosen holds the review until the answer is known.

The review states the schedule and each period's interest, worked out as the protocol expects it. For a range, it gives both the figure a lender taking the request directly would charge and the figure on the largest loan a match can make. It also gives the grace a missed period gets, read from today's settings, or says plainly that the grace could not be read. With a schedule, the amount owed is labelled as the whole term's interest plus principal, with the instalments paid counting toward it, so it does not read as a sum still due at the end. In Basic too, it warns that a period left unpaid past its grace lets anyone sell part of the collateral to pay it, and that the schedule cannot be changed after posting. In Advanced, it adds who may settle a missed period: anyone may, and whether the keeper service does so on this network is stated as reported, or as not known.

A schedule is an Advanced choice. Switching to Basic keeps it, says so, and offers to clear it along with the other Advanced options.

The user guide's Basic and Advanced editions describe the interest schedule in every language.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-CADENCE, RB-MODE, RB-SWITCH. Epic #3180.

_Committed 2026-11-06 15:02 UTC (7bb5bfee6)._
<!-- assembled-fragment: 3180-alpha05-request-interest-schedule.md sha256=ad8f84a32b0827bb326ea22e0e5b09007f5d62c5ce0b691b171cb3c6deaa0b4d -->

## App — The next app lets a borrower post a ranged request with a fill mode, and shows its risk at both ends (PR #3248)

In Advanced mode, the borrow request on the next app's Borrow page gains its Advanced options. A borrower can accept a range: a smallest and a largest amount a lender may lend, at their one rate, with an optional, smaller amount of collateral for the smallest loan. They can also choose how matches may fill the request: partial (the default), all or none, or immediate or cancel. The form does not offer a shape the protocol would refuse: all or none takes one amount, so it is greyed out while a range is on, and immediate or cancel needs the request to lapse, so it is greyed out while the request stays open forever.

The review states both ends of a range instead of one figure. It says what a lender taking the request directly lends (the smallest amount, against the floor collateral, with the rest of the collateral going back to the wallet) and what the largest loan a match can make is, with what is owed at the due date for each. The loan-to-value at today's prices is the protocol's own figure at each end. A collateral that the protocol values at nothing is said to support no loan, never shown as 0%. The fill mode is stated, along with the fact that it cannot be changed after posting. The amounts, the rate and the collateral can be: the protocol lets the borrower edit an open request, never below what matches have already used. The next app does not offer that edit yet, and the review says so plainly instead of telling the borrower they must cancel because the protocol forbids it.

A match locks only the collateral its lender asks for, not everything the borrower posted. With a collateral range it locks at least the floor, so the review states the largest match from all the collateral down to only the floor. Without a collateral range it locks the lender's requirement, so the review says the largest match may lock less. Either way, the collateral a match does not lock is not sent back after the match: it stays with the request for later matches and comes back to the wallet only when the request closes or is cancelled, and the review says so for every request a match can fill. Any request a match can fill, a single-value one included, now warns in Basic that a matched loan can start riskier than the figures shown, bounded only by the protocol's start-of-loan limit. In Advanced, a start-of-loan limit that could not be read is stated as such, never left out.

The protocol's create check covers the largest end of a range only. When the largest amount asks for more than the collateral supports, the review blocks the request and names the protocol's own ceiling, so the borrower knows how far to lower it. The direct end is asked separately, as its own dry run. When a lender could not take the request directly at today's prices, the review warns that only a match locking more collateral can fill it. When that answer cannot be read, the review says so rather than promising either way. Every range states whether matching across several lenders is switched on for the network, and what the range does while it is off: it fills once, by a lender taking it directly, for the smallest amount. In Advanced mode, the review also states the health factor a loan must start at, read live from the protocol.

The options are Advanced, but switching to Basic never drops them silently. Basic says which ones still apply and offers to clear them, and every risk warning they cause stays visible in Basic.

The user guide's Basic and Advanced editions describe the range and the fill mode in every language.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-RANGE, RB-MODE, RB-SWITCH, RB-CONFIDENCE. Epic #3180.

_Committed 2026-11-06 14:22 UTC (6c0a0a5bd)._
<!-- assembled-fragment: 3180-alpha05-request-range-fill-mode.md sha256=39b82e23e1149f6d8a6e703aa5148b9451863d61d7f87c6b635ad2bfbf260ba0 -->

## App — The next app clears a risk-access block in place: raise your level or agree to the pair, then carry on (PR #3230)

On networks where the protocol's risk-access gate is switched on, every account starts at the lowest risk level (blue-chip assets only), and a pair whose riskier token needs a higher level is refused until the account raises it; an illiquid pair also needs the account's agreement to that exact pair, and an account in strict mode needs an acknowledgement for each liquid pair. Until now the next app's Borrow page only named such a block and sent the reader to the current app. Now taking an offer and posting a request both clear it in place.

Which step is needed is always the protocol's own answer for that flow: the acceptance preview for an offer (after checking that the lender is not the one blocked), or the dry run of the request. The review states the block, the level the pair needs and the level the account has, and offers the one step that clears it as a single wallet confirmation with its own receipt: what changes, how far it reaches (a level covers every pair up to it, an agreement exactly one pair), when it takes effect, that no funds move, and what undoes it. A raise names the account's change counter and the risk-terms version it was read with, so it is refused, changing nothing, if another device or a terms change acted in between. The outcome is read back from the chain, and the reader returns to the review, which checks again. An offer in the list that needs such a step says so and stays one tap away instead of looking untakeable.

Where the protocol sets a waiting period, the step never claims to work at once: the review says when it would take effect, the finish card gives the time read from the chain, and while it waits the review states that time and does not offer the step again, because a second one would start the wait over. The protocol has no read for when an agreement to a pair takes effect, so while one waits the review says it cannot read that time; only the step's own finish card gives it, measured at the receipt's block. A time remembered from earlier could belong to an agreement that was withdrawn and given again since, so none is kept. #3229 asks for the read. A transaction the network refused is reported as having changed nothing, never credited with what the chain shows afterwards; this holds for every action in the next app. A step that finishes while the reader is on another page shows its outcome when they return. A stale level after a risk-terms change is offered as a re-confirmation of the level the account chose. A block that comes from the lender's own level is shown as the lender's, with nothing offered to the reader.

The user guide's Basic and Advanced editions gain a section on risk access in every language.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-RISK-STEP, RB-REVIEW, RB-CONFIDENCE. Epic #3180.

_Committed 2026-11-06 08:29 UTC (bffa7a021)._
<!-- assembled-fragment: 3180-alpha05-risk-access-step.md sha256=726bbd5827fcf4a19bac2e02f46be86302f98583e181ab42b5e61146b43dc978 -->

## Thread — Illiquid deals need a pair consent armed ahead (PR #3232)

Accepting an offer on an illiquid pair (an unpriced token, an NFT, or a rental) now needs the acceptor to hold a standing per-pair consent, exactly as the offer's creator already did. Before this change the acceptance signature itself, which names the illiquid assets, counted as that consent.

That shortcut skipped the unlock cooldown. Someone holding a stolen key could approve a worthless asset and take the deal in the same sitting, with no window for the owner to notice. With the consent required in advance, a raise recorded just before a deal stays pending for the configured cooldown (48 hours on the testnets, and on mainnet from the first deploy), and the owner can withdraw it instantly in that time.

The accept preview now reports a missing or still-pending consent as a block. The soft "the acceptance acknowledgement will cover it" result it used to give is retired and never returned. The connected app treats any non-zero preview result as a block, which is also the safe reading on a network that has not yet been refreshed past this change.

Nothing changes while the risk-access switch is off, and liquid pairs are unaffected. The storage slot that carried the acknowledged risk-terms anchor for the retired rule is kept unused, because storage is append-only. The signed acceptance terms still carry that anchor for now; removing it from the signed message is a follow-up, because every signer would have to change at the same time.

Closes #3231.

_Committed 2026-11-06 09:30 UTC (faa6ff797)._
<!-- assembled-fragment: 3231-illiquid-consent-armed-ahead.md sha256=70e2a2d5e38246494c506fd6473e3c3fbb4d74d77357b594a3741c7f942510c1 -->

## Security — risk-access changes can no longer be relayed or pre-signed (PR #3244)

The risk-access facet used to accept five relayed, signed grants: a tier
change, a checked tier change, an illiquid-pair consent, a strict-mode toggle
and an explicit mid-tier acknowledgement. A user signed the grant and anyone
could submit it. They are removed, together with the view that reported their
replay nonces.

Why: nothing in the app, the keeper or the public keeper-bot used them, and a
signed grant was a standing risk. It carried no upper bound on how long it
stayed valid, and the user had no way to cancel one they had signed but nobody
had submitted. A user tricked by a fake site into signing one could have it
used later to loosen their own safeguards. With the relayed form gone, every
risk-access change is the vault owner's own direct transaction, and a request
to sign one is never genuine.

What stays the same: the direct setters, the conditional tier change, the
terms anchor, the cooldowns and the gate itself are unchanged. The storage slot
that held the replay nonces is kept, unused, so the layout stays append-only.

The removed selectors stay unrouted on a fresh deploy; the all-facets refresh
removes them from an existing testnet Diamond by itself.

Closes #3238

_Committed 2026-11-06 11:54 UTC (267e1230d)._
<!-- assembled-fragment: 3238-remove-relayed-risk-grants.md sha256=392a09d06b84187357231875941d260dea0f66d12f2f79eac70c4db0564587c2 -->

## Security — removing a Telegram alert chat waits under protected mode (PR #3247)

Protected account mode makes every payout wait a delay. Its alerts, and the Telegram LOCK command, are how the owner sees a payout in time to lock the vault. Until now a thief holding only the owner key could silence them first: an unlink, or linking the thief's own chat in place of the owner's, took effect at once.

Now, while a wallet's account is protected on a network, the chat linked for that network is not removed at once. An unlink, or a link handshake from a different chat, waits the account's own protected delay (two to five days). The wait starts only once Telegram has accepted the message telling that chat about it; a message that does not go through is retried every half hour, and until one does the change can never take effect, so an outage (of Telegram, or of the agent's own bot secret) delays a removal but never lets it pass unseen. Each notice states its own networks' deadline when they wait different delays. Until then the chat keeps every alert. It can reply CANCEL to stop the change, and it is told to lock the vault in the app (or with LOCK, where Telegram locking is allowed). Only that chat can cancel, and only from its private chat with the bot. The agent applies the change on its scheduled tick once the delay has passed, and tells both chats.

Adding a chat where none is linked, or linking the same chat again, stays immediate, because it only adds a listener, and it closes any change still pending for that network. Handshake codes are revoked at once, since a code can only link. Accounts without protected mode keep the immediate unlink. If the agent cannot read whether the account is protected, it changes nothing and says so, so a failed read never silences a protected account. The app says, for the network the card shows, that the chat is not unlinked yet and until when it keeps its alerts (or that the wait starts once the chat gets the message), and names other networks still waiting when this one was cleared at once.

The pending changes live in a new shared table. A fresh Diamond on a network keeps them, because they are the user's own requests. A restore clears them, which only cancels them and keeps the chat linked now.

Part of #3246; the recovery address and clawback in the contracts follow separately.

> Caveat: a Push subscription is held by the Push network, so unsubscribing there is not delayed. Telegram is the channel the protected-mode alerts and LOCK rely on.
> Caveat: a secondary signer cannot yet approve a removal early; a genuine owner who lost the old chat waits the delay.

_Committed 2026-11-06 14:41 UTC (e9ae37ba0)._
<!-- assembled-fragment: 3246-alert-chat-removal-waits.md sha256=533856fe89a804a3395379bbb777c9d29b1b0519394e3a2b10e723499c00a1a9 -->

## Keeper — Keeper alerts the ops chat when Base refuses a reward remit (PR #3254)

The keeper sends each mirror its daily reward budget from Base. On 2026-11-06, Base's delivered reward budget was empty because its reward pool was never funded after the fresh deploy, so the Diamond refused every one of these sends. The keeper retried every run for hours and wrote only a log line, so nothing told an operator.

Now, when the Diamond answers and refuses a remit, the keeper posts one alert to the ops chat for that lane, naming the refusal and its figures. It re-posts every six hours while the refusal persists, and the alert clears once the lane next completes. A refusal that a later run resolves by itself (a duplicate send finding the days already remitted) is not alerted, and neither are network failures, which say nothing about the call.

_Committed 2026-11-06 17:57 UTC (64ac8a882)._
<!-- assembled-fragment: 3253-remit-refusal-alert.md sha256=2d3357a63aac817837f7ea8f661c97462e9ad85d46f93e3d2e2c5d0a7fbdf617 -->

## Keeper — a fresh Base can no longer launch rewards unfunded (PR #3263)

On the canonical chain the daily reward budgets sent to the mirrors draw only on what an admin has delivered into the reward pool. The 69M interaction pool is an allocation, not a balance, so a fresh Base starts with nothing to send. After the 2026-11-03 fresh deploy nobody funded it, and day 1 never reached Arbitrum Sepolia or BNB Testnet until an operator spotted it by hand.

Two places now refuse that state. The script that sets the one-shot rewards launch anchor refuses on the canonical chain while the reward pool has no delivered headroom, and names the funding step. The deploy scripts' verify phase (testnet and mainnet) gains a reward-funding step: it prints what was received, paid and what remains. It fails a canonical chain whose rewards are launched with nothing left to send, and it states "not funded yet" before launch. A read that does not answer fails the step; it is never taken as funded. Mirrors are funded by Base's sends and are not checked.

The check asks only that some headroom exists. How much to fund is the operator's decision, so the figures are printed for them to read. The deployment runbook now orders the funding before Base's anchor, and the two-chain test harness funds Base before it sets the anchor, as a real deploy must.

The lens documentation for the delivered-fresh bound also said the bound does not apply on the canonical chain. That has been untrue since the canonical bound was introduced, and is now corrected.

Closes #3253 (the keeper alert half shipped in #3254).

_Committed 2026-11-06 23:47 UTC (bcdb1f754)._
<!-- assembled-fragment: 3253-reward-pool-funding-check.md sha256=03dde66cef4e7fc05ba37ac24762e7972daaaee60a497637149d86abe0478b22 -->

## Ops — Mesh watcher names JSON-RPC errors instead of calling them unclassified (PR #3249)

On 2026-11-06 the ops channel received a critical "Mesh watcher tick failed … an unclassified error occurred" alert. The alert pointed the operator at the Worker logs, but the Worker logged only that same sentence, so the cause could not be found there.

The watcher's error classifier now recognises a JSON-RPC error from an RPC endpoint by its structure. This is the case where the endpoint answers normally at the HTTP level but returns an error object, such as "header not found" from a load-balanced provider. The alert names the numeric JSON-RPC error code and the error types involved. Any error that is still unclassified now lists its error types, so the alert itself says what kind of failure occurred. The provider's own message text is still never forwarded, so a key or URL in it cannot reach an alert or a log.

_Committed 2026-11-06 13:32 UTC (38845d61a)._
<!-- assembled-fragment: mesh-watcher-rpc-error-classify.md sha256=623af4bdaa7dd280a01607d42d25404c6a95b979aad9194541a8465d7514a2ef -->

## Keeper — remit acknowledgements are no longer sent twice from Arbitrum (PR #3264)

When a mirror receives its daily reward budget from Base, the keeper sends an acknowledgement back over CCIP from the mirror and pays the CCIP fee. If Base has not recorded the acknowledgement yet, the keeper re-sends it after a backoff. That backoff was 15 minutes. CCIP waits for full finality on the source chain before it delivers, and Chainlink states 17 minutes for Arbitrum (18 for Base, 20 for OP Mainnet). So every acknowledgement from Arbitrum was still in flight when the keeper re-sent it, and the fee was paid twice. On 2026-11-06 the day-1 acknowledgement for Arbitrum went out at 18:55 and again at 19:11. Base accepted it once, as it always does with a duplicate, so the only loss was the fee.

The backoff is now three times the slowest source finality among CCIP's chains, which is one hour. An acknowledgement that is truly lost is still re-sent several times before the eight-hour overdue alert reaches the operator.

_Committed 2026-11-06 23:23 UTC (ef5fbb7e7)._
<!-- assembled-fragment: remit-ack-backoff-finality.md sha256=88761cfe901de83782536f9290d1029f7253eecde520a240c564640ed25dfd38 -->
