# Release Notes — 2026-11-15

Signed offers grew up on this day. A maker can now cap the protocol fees they accept, name the one account allowed to take the offer, and require a co-signer on every fill, and one signature can cover a whole set of offers that a single nonce cancels together (#3327). Auto-lend gained an end date and a pro-rata opt-in, and pro-rata matches now admit a shorter borrower term, with the keeper matcher pairing such offers across terms and matching new or re-priced offers first (#3615, #3618, #3622). Protected mode is now held by each vault, the treasury lives only in the vault code, and every price read runs on a fixed gas budget (#3379, #3569, #3608). The rehearsal flows moved onto the staged runner (#3574).

The new app gained a wallet's whole history, the protocol's public figures and the VPFI token's facts, claim-and-withdraw in one action, key risks beside the Terms and in every review, editing an open offer in place, taking an open offer instead of posting, recovering an asset sent straight to a vault, and plain answers to why an offer is not matching and what wallet is needed (#3180).

## Keeper: unused Telegram bot handle setting removed (#1722 follow-up)

The keeper used to declare a `TG_BOT_USERNAME` setting, carried over from when it ran the user-facing Telegram bot. No keeper code ever read it. Since #1722 the agent owns the user bot completely, so the keeper's code, its Worker config and its machine env template no longer list the setting.

Nothing changes in behaviour. An operator can delete the line from the keeper machine's env file. The ops bot settings (`TG_OPS_BOT_TOKEN`, `TG_OPS_CHAT_ID`) stay: the keeper's operator alerts still use them.

_Committed 2026-11-15 03:46 UTC (0abcecb76)._
<!-- assembled-fragment: 1722-keeper-drop-bot-username.md sha256=1fb4133dd6f9a9f8ace435cd89b1759820546181e7347b0328d57a60fe876294 -->

## New app: one wallet's whole history, served by the index

The new app gains an Activity page, reached from Positions and from Alerts. It lists everything on the connected network that involved the wallet: the events on any loan it ever held a position in, and the events that name it, such as offers it posted, its vault, its settings and its rewards. Each transaction is one line, led by what happened, with the rest of that transaction folded under it. Every line names its loan or offer, the wallet it is recorded for (which may not be the one that sent it), when, and links to the transaction.

An amount is shown only when the index recorded one; otherwise the line says no amount was recorded, rather than working one out from raw event data. An event whose meaning turns on a yes or no it records, such as whether a retried collateral sale went through, whether a keeper permission was given or withdrawn, or whether a withdrawal was paid or queued, says which, and never reads one way for both. Events in the newest blocks are listed first and marked not final, with no time yet. A loan whose ending was found by the index's own check, rather than seen as an event, says what was and was not seen. Rows the app cannot read are counted, and an index that does not answer is never shown as an empty history.

The index now answers for one wallet itself. Before, a client had to page the whole network's feed and keep the rows that were the wallet's, which on a busy network could only promise recent activity. Reading one wallet's page costs the index in step with that wallet's own history, not the whole network's. The index records which wallets each event concerns, by the same rule the app uses, as it reads each event, and fills the same record from the history it already holds, a page at a time. Until that fill reaches the newest stored event, the index says its answer may be missing older rows, and the page says so too. Closes #3677.

_Committed 2026-11-15 17:04 UTC (36549e241)._
<!-- assembled-fragment: 3180-alpha05-activity.md sha256=41fb8c011733ba48ae448cc0596414bbb80d6af1a8d3ecb15d7dbff0e7bfbd7a -->

## Thread — alpha05: Analytics, the VPFI token's facts

The Analytics page now has a VPFI token section. It reads the token the protocol names on the chosen network, at the same block as every other figure: its name, symbol, decimals and supply. The decimals are the token's own, and if they cannot be read the supply is shown in base units with that said, never with an assumed 18.

VPFI is issued on one network. There the page shows the cap written into the token, the supply now, what may still be minted under the cap, the amount minted at launch, the minter and the token's owner, naming the protocol contract or the governance timelock when it is one of them. It says only the minter can mint and only the owner can change the minter, and that a change waits out the timelock's delay only when the owner is the governance timelock; otherwise it says it cannot claim such a wait. On any other network the page shows the supply there and says the cap belongs to the home network, where VPFI is issued, with each VPFI there backed by one locked at home; it never shows a cap of zero. A network with no VPFI token set says so, a fact that could not be read says so, and a token or cap that differs from the app's record or the published allocation is flagged.

Below that, the page lists the VPFI address this app's deployment record names on every network it serves, each linked to its explorer and marked home or moved from home, and the published allocation of the 230,000,000 cap. Each allocation line is stated as the most that may be minted for it, not VPFI already minted; the 24% reserve is shown as undecided, with none minted until governance chooses; and the page makes no claim about price, return or scarcity. Advances #3180.

_Committed 2026-11-15 05:04 UTC (0a8b4e86f)._
<!-- assembled-fragment: 3180-alpha05-analytics-vpfi.md sha256=e0c6d86a5a59d973146dcfc88ab835bc9bd5ddbc9a9950b96f559c8bcd55b13f -->

## Thread — alpha05: Analytics, the protocol's public figures

The new app now has its Analytics page, reached from the Advanced navigation or by its address, with no wallet. It shows the protocol's own figures on one network: how many loans are open and have ever opened, the offers in the book and ever posted, the wallets that took part and the average agreed rate. It shows no default rate: the protocol's counter for it also counts loans settled after an ordinary repayment, so the page says that instead of showing a misleading figure, and #3616 asks for a counter that counts only defaults. A picker lets a visitor choose any network the app serves; without a choice the page describes the wallet's network, or the default one.

Every figure is read from the protocol contract on that network at one block, and the page states the block, how old it is, and the block this deployment began at, where every counter starts. A figure that could not be read says so in its place and is never shown as zero, and a rate with nothing to divide by, such as the average rate before any loan has opened, says there is none yet rather than 0%. Small amounts keep their significant digits, so a fraction of a cent is never shown as 0.00. A block time ahead of the device clock is an unknown age, never "0 seconds ago". If the latest re-read fails, the page says the figures are as of the block shown, not now. The page states that nothing on it comes from the app's indexer database. A pause that could not be read is said, never shown as not paused; under a pause the page says whether withdrawals of free holdings have reopened by the escape route, when they do, or that none is scheduled, and points to the Vault page for the reader's own account.

Values in the reference currency use the protocol's own valuation rule, the one it applies to loan-to-value. The value on open loans and the lending totals since the start are valued now, not when each loan opened, and an asset the rule cannot value counts as nothing in them; so the page lists every asset ever lent with its own amounts and value at the same block, and names each asset a total leaves out. Interest counts what borrowers paid: collateral a lender received after a default is a recovery, not interest, and the page says so. NFT collateral has no price, so the page counts the open loans that carry it instead.

The fees section shows the treasury's share of interest and the loan start fee as set now, and the fees collected since the start, in the last day and in the last week, each valued when it was collected. Beside them it says a fee the protocol could not value then counts as nothing, and that the day and week figures are a lower bound once more fees than the scan limit fall in the window. The page names and links the treasury that current vault code pays fees to. A vault still on older code pays the treasury its own code names, and fees that reached the protocol contract earlier stay there, so the page always shows what the contract holds as well, saying why and that it counts only assets of open loans. A treasury that differs from the app's deployment record is flagged. The page shows no price, return or buyback, and states the treasury is not invested to earn a return. Advances #3180.

_Committed 2026-11-15 05:04 UTC (0a8b4e86f)._
<!-- assembled-fragment: 3180-alpha05-analytics.md sha256=c09b6efd34c846e0040436f34aa0332134c3a699557afc7053d03fe407ce7348 -->

## alpha05 — claim and withdraw as one action, and "ready to claim" totals

A loan claim pays the position holder's own vault, and only a withdrawal takes the money on to the wallet. That second step is the one a protected account's delay applies to. The new app now offers both steps together, without hiding that there are two. Every claim entry point gives a choice up front: "Claim and withdraw" (the lead) or "Claim to my vault", for a holder who wants to lend the money again or post it as collateral. This applies to a payout's card on Claims, the loan page, and Claim everything. The review says which was chosen. For a withdrawal, it explains the two steps and says the wallet will ask a second time.

Once the claim confirms, the app opens the ordinary vault withdrawal for exactly what the transaction's logs show the claim credited to the vault, including a token a claim-time match paid in. It never uses the amount the review promised. Each asset gets its own withdrawal, with its own review and protocol dry run. A protected account's withdrawal is queued for the account's delay, as on the Vault page. If a withdrawal is refused, fails or is closed before anything moved, the claim still stands and the money stays in the vault. The app says so and offers the withdrawal again. One that went through is not offered again, and the withdrawals open only while the same account and network are connected. The claim's finish card cannot be closed while a withdrawal it opened is still out. In Claim everything, only the loan payouts are withdrawn: every other part goes where its own row says, and the review says so.

Claims and Home now lead with "Ready to claim". This is the per-asset total of every loan payout whose claim can run now, decided by the same rule each payout's button follows. Payouts that are still waiting, that could not be read, or whose amounts a loan in fallback can still change when claimed, are counted separately and named rather than added in. A claim pays the vault, so the total is never described as received.

Advances #3631. The payouts made while a loan is still open wait for the contract change in #3629, which routes them through a claim as well. Letting a wallet send both steps as one batch is a later step; the issue keeps that open.

> Caveat: the wallet asks twice (once for the claim, once per withdrawn asset). Combining both steps into one wallet confirmation is not built yet.

_Committed 2026-11-15 07:08 UTC (4c489b53b)._
<!-- assembled-fragment: 3180-alpha05-claim-withdraw.md sha256=463ac7aa7adf4d045f3b56ec767f698b2a0bd0ebbad37d9876c36710a5db2814 -->

## Thread — alpha05: the Protocol Console

The new app now has its Protocol Console: a public, read-only page that states the protocol's settings and switches on the network the screen describes. It opens by direct link with no wallet, has no controls, and links the queued governance changes, which is where every change waits before it takes effect. Each value is labelled by name, and a setting whose zero means "none set" (the rate model, the dust floor, the grace schedule, a contract address) is written as unset or off, never as 0.

The page always says where its settings came from. It shows the index's snapshot only while the snapshot is dated, less than a day old, not behind a governance change the index has seen, and labelled by name. Otherwise it reads every setting straight from the chain at one block and says why (no snapshot, the index did not answer, the snapshot is behind a change, too old, undated, or its names could not be tied to the protocol's code). A chain answer older than the snapshot counts as failed, and with no usable answer the page says the settings are unknown rather than showing anything as unset. An answer dated ahead of the reader's clock is marked unverified, one more than a day old is flagged, and when the protocol's code has changed since the app was built the page says so instead of showing the settings bundle under names that may no longer fit.

Every switch the rulebook lists is named with its class and what it blocks: the new-position switches, the lifecycle-feature switches and the keeper switches. The ones this first version does not read yet (among them the full fee tariff, the solver capacity limit, the keeper reward, the fee-discount price source, the reward custody cutover and the reward claim horizon) are still named, with their state stated as not read. The global pause is read live at one block, with what it stops, what stays open (full and partial repayment and adding collateral), and when an automatic pause could next start by the reader's clock.

The page says it shows a subset and names what it leaves out, says a change never reprices an open loan, and lists no running total as a setting. Keeper posture stays out until its data source is decided. Advances #3180.

_Committed 2026-11-15 00:45 UTC (4767776f8)._
<!-- assembled-fragment: 3180-alpha05-console.md sha256=e056e1920c910a5072c5841d265571a5c48c3d9a43313a42ea32f51cba5839c3 -->

## New app: key risks with the Terms and in every review

The new app now says plainly what can go wrong. When the Terms of Service are asked for, the prompt shows a short list of key risks above the accept step: funds can be lost and nothing is insured or reversible, what a lender receives if a borrower does not repay, what a borrower can lose, that the software, price feeds, tokens and networks can fail, that only you control your wallet, and that nothing here is financial advice. The list wording was approved by the owner.

Every review that opens a loan or a rental now carries one "If things go wrong" line for that side and that loan. A lender on two liquid assets is told the collateral is sold to repay them, or given to them if it cannot be sold; where either asset is illiquid the loan never closes by a sale and the collateral itself goes to the lender. A borrower is told what can cost them their collateral. A posted offer or request and a signed order fill later, and the protocol checks both assets again then, so their reviews get a line that holds either way. No extra signature is asked: the review you sign carries the line.

A new public page, Key risks, linked from the footer and from every such line, holds the list and four more points: a pegged token can lose its value, a price feed can be wrong or late, tax and local rules are the user's own, and wallets, networks and transfers are run by others.

The list is also part of a new Terms of Service version 2, published on the site with the final clauses the owner approved: the site and app are an interface and not a party to any loan, no one holds your assets, who may not use the platform, provided as is, a limit on liability with a ceiling of the fees a user paid in the last 12 months (at least $10, at most $1,000), and indemnity. Dispute handling and governing law are left out. Version 2 becomes the one wallets accept once it is set on each network. This is #3661 and needs no contract change. The rule is in the rulebook as RB-KEY-RISKS.

_Committed 2026-11-15 12:24 UTC (ee3a0d5ef)._
<!-- assembled-fragment: 3180-alpha05-key-risks.md sha256=c9c8e662a4e9b4408dd147d6a078a9226c8624e51bc39eb695c648cd1662b441 -->

## New app: change an open offer without cancelling it

The creator of an open loan offer or request can now change it in place from the offer's page: its rate range, its amount range and its token collateral. A refinance request can change only its rate, and the term and the repayment options stay as posted; to change those, the offer is cancelled and posted again. A sale or early-close listing, a rental, an expired or ended offer and another wallet's offer are not offered the change, and a pause or a standing sale order refuses it by name.

The form starts from the offer as the chain holds it and applies the protocol's own shape to what changes, so an out-of-order range, a rate above 100% a year or an amount below what is already filled is caught before review. The review states each figure before and after and what moves. Raising what the offer locks pulls the difference from the wallet into the vault, through an approval of exactly that much; lowering it returns the difference to the wallet, routed like any payout when protected mode is on. A rate change moves nothing. The review also says the offer cannot be taken for a short wait after the change, so no one takes it on terms they did not see, and that a backstop opt-in ends.

The protocol's own check runs before the wallet opens, or, for a pull the approval does not yet cover, right after the approval and before the change; an approval the change did not use is put back. The finish card checks the protocol's record of the new figures against the review and measures what left or reached the wallet.

The "why isn't my offer matching" section now links a rate gap to this change, filled in with the rate that closes it, instead of saying the offer cannot be changed. Closes #3659.

_Committed 2026-11-15 18:35 UTC (0b9f038bd)._
<!-- assembled-fragment: 3180-alpha05-offer-edit.md sha256=291c0eeebb5b7db2ae86158bdece9e558499ee66056ec4e5e8cdb7915ea60647 -->

## New app: what pro-rata interest does to the term

The lending and borrowing forms in the new app now explain how pro-rata interest changes the term, as soon as it is chosen, and the review repeats it.

A lender choosing pro-rata is told that the term it sets is the longest it lends for. A match can pair its offer with a pro-rata borrow request for that term or a shorter one, and that loan runs, and earns interest, only for the borrower's term. A borrower who takes the offer directly still gets the whole term.

A borrower choosing pro-rata is told that a match can also pair its request with a lender's pro-rata offer for a longer term, and that its loan always runs for exactly the term it asked for.

This follows the matching rule for pro-rata offers (#3615). Full-term interest keeps the two terms equal, so nothing changes for it. The new rule is in the rulebook as RB-PRORATA-TERM.

_Committed 2026-11-15 08:09 UTC (0c79ce1e5)._
<!-- assembled-fragment: 3180-alpha05-prorata-term.md sha256=314a50c14b059c3838530d04c96eeadb7296d671d40e798d390a2d851c37c29f -->

## Thread — alpha05: Recover an asset sent straight to your vault

The new app now has its Recover page. Your vault counts only what reaches it through the protocol, so a token or NFT sent straight to its address, from a wallet or an exchange, sits there uncounted and cannot be withdrawn. You name the asset (and the token id, for an NFT; its kind is the one its contract claims, never chosen), and the page states the protocol's own figure for what of it sits uncounted. A figure that could not be read is said to be unread, never shown as nothing. The Vault page's link from an uncounted holding now opens Recover with that asset filled in.

If you sent it yourself, you can adopt it. Nothing moves: adopting counts the asset as yours, and it then leaves only through an ordinary withdrawal (which waits out the delay when your account runs protected mode). You name the address it came from, read the declaration word for word, type CONFIRM, sign the protocol's own declaration and send the adoption, two wallet prompts in all. The finish card reads the outcome from the transaction's own record.

What stops adopting is stated in the order the protocol checks it: a wallet a replacement retired, a contract account (which cannot sign the declaration), a vault an earlier adoption barred, the wallet's own sanctions screen, a network with no sanctions screen set, a pause, or a declaration the protocol binds that differs from the one the app shows. Each fact the app could not read is said to be unread, and adopting is then not offered. The protocol screens the declared source again when it confirms, and a flagged source credits nothing and bars the vault until that address is de-listed; so the app never sends an adoption for a source the screen already flags or cannot answer for. It asks the screen before the signature and again after it, as the last read before sending, because the protocol's dry run passes for a flagged source; a flag that lands after that is the protocol's to find when it confirms, and the review says so. A barred vault is told so, with the source its adoption declared. Once that source is de-listed the protocol keeps its record but lifts the bar, and the page says that and offers adopting again.

You can also disown what you do not claim: a public record on the chain that it is not yours. It moves and credits nothing, asks no declaration, signature or screen, and stays open to a replaced wallet, a barred vault and a pause. While the protocol is paused the page states the escape route and links the Vault page, which carries it. Advances #3180.

_Committed 2026-11-15 02:09 UTC (d95482340)._
<!-- assembled-fragment: 3180-alpha05-recover.md sha256=53a88aec43ce54c4646c203e29df33645da93bb73f5a89d993195288ba337d06 -->

## New app: take an open offer instead of posting

When a lending offer or a borrow request is about to be posted in the new app, and an open offer on the other side already fits it, the app now shows that offer first. The reader can take it at once, on that offer's own terms, or post anyway.

An offer is shown only when taking it stays inside every limit the reader set: the same term, interest mode, partial repayment and interest schedule, an amount within the reader's range, a rate no worse than the reader's, and collateral no worse than the reader's for that amount. It must also be open and takeable by this wallet now. A draft that arms a price-move guard or the Full fee tariff is never offered a take, because a direct accept carries neither. If the latest re-read of the offers failed, the step says the list is from the read before. Taking opens the usual review on the offer's own terms. Posting waits for a taker or, while matching is on, a match with an offer whose rate range includes the reader's rate, which lends at that rate. Nothing is taken or posted without the reader's press.

This is part B1 of #3622 and needs no contract change. Until now a new offer waited for the matcher even when a counterparty was already resting. The rule is in the rulebook as RB-TAKE-NOW.

_Committed 2026-11-15 09:35 UTC (320732e68)._
<!-- assembled-fragment: 3180-alpha05-take-now.md sha256=0c0c51121e80a82eeea4db37f2f343c3bba9694b6e0f2d62f0f6084b0f417c04 -->

## New app: what wallet you need, said before you connect

The platform does not create or hold wallets: you bring your own. The new app now says so before anything connects. The wallet picker, and Home while no wallet is connected, state that a self-custody wallet is needed, that the platform never holds its keys and cannot recover them, and that losing the keys means losing access to the funds. The statement links to a new page, also in the footer, that explains what a self-custody wallet is, what a recovery phrase is and how to keep it safe, and how to connect from a computer or a phone. It names no wallet brand.

This also fixes the connect button. On the live site, opening the wallet picker and closing it without finishing left the button reading "Connecting…" and impossible to press until the page was reloaded. The phone connection option prepares its link as soon as the picker opens, and that request stayed pending. The button now stays pressable and reads "Connecting…" only while an earlier session resumes.

The site's FAQ answer on wallets and the user guide say the same, and no longer list wallet brands. Closes #3671.

_Committed 2026-11-15 14:40 UTC (6d22e5d1d)._
<!-- assembled-fragment: 3180-alpha05-wallet-keys.md sha256=5deac7e21d383a776b2fb861ffb3e4f2839dedc467f17c64c096ce508806aa0c -->

## New app: why an open offer is not matching

The page of an open offer you posted in the new app now says why it has not matched yet. It looks at the open offers on the other side of the same pair that sit closest to yours, reads each from the chain, and asks the protocol whether each pair would match now. The reason shown is the protocol's own.

It states one thing: that nothing stands on the other side yet, that matching is off on the network, that a pair would match now (with the offer and the rate), or the closest offer's gap. A rate gap gives both rates and a term gap gives both terms. A gap in how the loan runs names the option that differs: interest mode, partial repayment, prepay listing or the interest schedule. The closest offers, each with its verdict, are one tap away, and the Offers list links each open offer to this section.

The ranking comes from a new indexer route, `/offers/:id/nearest`, which serves the other side's open offers on the pair, closest rate range first, and how many there are. It is a cache ranking only: the page never names a gap the protocol has not confirmed, and a failed index read says the closest offers are unknown rather than that there are none.

Nothing is promised: another taker can reach an offer first. This app cannot change an open offer yet, so for now the page says the way to close a gap is to cancel and post again. This is #3623 and needs no contract change. The rule is in the rulebook as RB-WHY-MATCH.

_Committed 2026-11-15 11:09 UTC (ee92446f2)._
<!-- assembled-fragment: 3180-alpha05-why-matching.md sha256=616f57432b5f789c2db82ba2f91b304a7807c183c60bce2d72c8277f5e4a7fdc -->

## Signed offers carry the maker's protections

A gasless signed offer stays fillable for as long as its maker leaves it, by
anyone holding the signature. Until now the maker could not limit the fees a
fill would charge, who could fill it, or cancel many offers at once without one
transaction per nonce. Four new signed terms and one new action close that gap.

The maker now signs the highest treasury fee and the highest loan initiation
fee they accept, and a fill is refused while either protocol fee is above its
cap (only while it stays above: the offer is fillable again if the fee comes
back down, so cancelling is what stops it for good). They may name the one
wallet allowed to fill (on a match, the creator of the counterparty offer), and
a co-signer whose fresh approval, lapsing within fifteen minutes, each fill
needs. The approval is bound to how much of the offer was already filled, so
it can be spent on one fill only, and a leaked signature alone cannot be
filled.
A new cancel-floor action cancels every offer the wallet signed below a chosen
nonce in one transaction; the floor only rises.

All of these live in one shared fill rule that the direct fill, the keeper
match and the accept preview all read, in one order, and the preview reports
each refusal by name. The off-chain book checks the new fields and the floor on
the way in, drops every offer below a floor as soon as it rises, and removes
offers stored in the old shape, because the signed fields changed the
signature: offers signed before this change cannot be filled after it.

Both apps sign the fees their review showed as the caps, draw nonces above the
wallet's floor, and name no taker or co-signer. The connected app refuses to
post when the fees moved since the review, and keeps a restricted order in the
book as depth with no Fill button and a tooltip saying why. Asking a
co-signing service, choosing a taker and a cancel-all control are follow-ups.

On the live testnet, signed offers stop working between this merge and the
next fresh deploy, since the deployed contracts still expect the old shape.

Advances #3327 (part 1 of 2; Merkle offer sets follow).

_Committed 2026-11-15 08:15 UTC (6c502c003)._
<!-- assembled-fragment: 3327-signed-offer-maker-protections.md sha256=202e74b5f03ec1ecfa6adfa791d1fac03989781c6955d9dc1bd2be2ce5684ec6 -->

## One signature over a set of signed offers

A maker quoting several gasless offers at once, such as a ladder of rates,
had to sign each one separately. A maker can now sign up to 32 offers with a
single signature. The wallet shows that signature as a readable list of every
offer's terms rather than an opaque digest (owner decision 2026-11-15), so
the maker sees exactly what they are agreeing to.

Signing together changes nothing about how each offer lives. Every offer
keeps its own identity, fill record, deadline, expiry and protections, and is
filled, matched, previewed and cancelled on its own. A fill of one offer
carries the other offers' identities and its own place in the list, which is
what lets the signature be checked; a fill that gets either wrong is refused.
Giving every offer of a set the same nonce lets one nonce cancellation stop
the whole set. The wallet-backed fill stays limited to offers signed alone.

The off-chain book accepts each offer of a set on its own post, checks the
signature against the set it names, stores that placement with the offer and
hands it back with the order, so any taker can fill it. The nightly-backup
restore checks the stored placement the same way it checks the order. Both
apps now send an offer's placement with every fill and preview, and read a
book row that names a malformed set as unfillable.

The maker-side screen for signing a ladder in one go is a follow-up (#3653);
until then a set can be signed and posted through the book's interface
directly.

On the live testnet, signed-offer fills need the next fresh deploy, because
the fill entry points gained an argument.

Closes #3327.

_Committed 2026-11-15 11:16 UTC (8ec9e7aa3)._
<!-- assembled-fragment: 3327-signed-offer-sets.md sha256=40997775ed1124cefeaf92561d231583282e2ec9119e8b60bf89a6847601e9bd -->

## Thread — Time-based default sales name their caller in the liquidator count (PR #3633)

The liquidator count on the loan stats (#3366) treated the time-based default as a route whose caller is not recorded, and counted it from an event called `LoanLiquidated`. That event was declared on the default facet but never emitted, so every time-based default sale was missing from the figure, not just its caller.

The caller was already on-chain. Every forced sale emits one settlement record naming the caller who triggered it, and the record says which kind of sale it was. The count now reads the rows whose kind is the time-based default, and files them under that caller beside the internal match and the periodic auto-liquidation. Those rows are shown but not counted toward the bonus-auction threshold (#3355), which covers only the Health-Factor routes. The other kinds of that record repeat a sale that another route's own event already names, so they are left out rather than counted twice.

A time-based default that sells nothing pays its caller nothing, so it is not a liquidator's sale and is not counted. That covers an in-kind transfer of illiquid collateral, and the fallback entered when the collateral is unpriced or every swap failed. The response states this in its caveats.

The dead `LoanLiquidated` declaration is removed from the default facet, together with the indexer branch that handled it, its notification note, and the app's activity label for it in English and the nine translated catalogues. The position NFT's "Loan Liquidated" status is a different thing and is unchanged. The ABI loses one event and gains nothing, so no call changes.

Closes #3367

> Caveat: the indexer's `liquidated` loan status was set only by the removed handler, so nothing produces it now. Removing the status from the indexer and the app is a separate cleanup (#3630).

_Committed 2026-11-15 05:33 UTC (c08dd6139)._
<!-- assembled-fragment: 3367-time-based-default-caller.md sha256=d4798c53428d1fb7897c47e80e61dc6ca5189513f5fc67717c376105b099a429 -->

## Thread — protected mode is held by each vault (#3379 Stage B2, #3393, #3415, #3423)

Protected account mode now lives in each user's own vault, not in the platform. The vault alone records the delay, the lock, the secondary signers, the payout destinations and any pending replacement of the owner's wallet. It accepts a change only from the right key: that key's own transaction, or its signature submitted by anyone (an ordinary wallet or a contract wallet such as a Safe). Each signature names the network, the vault and the exact change, works once, expires, and can be voided before use. The rules are unchanged: two to five days of delay, up to five signers and five destinations, loosening changes that wait the delay and that any signer can cancel, and a lock that drops every pending change.

The vault enforces its own record. It pays its owner or a payout destination only while it is unlocked, and a destination only once its wait is over. An allowlisted address can verify itself (#3415); while the account has signers, a payout to an unverified address needs a signer's co-signature. Whether a payout needs a co-signature is one rule, read the same way by the release, the keeper, the app and the alpha site, so a payout never waits on a co-signature nobody can give; removing the last signer clears the co-sign requirement for good, and a signer added later does not revive it. A signer cannot co-sign a payout addressed to itself, and a destination's verification, and any signature given for it, belongs to one request: cancelling or voiding the request clears it. Whether a release would cancel a payout instead of paying it is likewise read from the platform's own rule, so a review never describes a cancellation as a payment. A lock signed by the owner or a signer can be submitted by anyone, and the keeper's lock from a linked chat goes through the vault too (#3423).

A replacement is permanent. It moves the vault's owner record to the new wallet, which from then on is paid and signs for the account, including the vault's code pin (part of #3522). The vault records that the account was replaced and never clears it: the old wallet can never be named again, the account takes no payout destination, the account stays protected (it cannot be switched off), and every payout, delivery and reward claim for it goes through its vault and the delay to the new wallet (into the new wallet's own vault when that wallet is protected too). Signed replacement approvals and cancels are bound to the proposal they were given for. One wallet may manage several replaced accounts, and the app and the alpha site list each of them.

Vaults are now created at an address derived from their owner (#3393), so a look-alike vault with a forged owner record is refused as a payee.

The platform reads the vault's record and applies its own side on request (anyone may ask): it holds the position NFTs, cancels queued payouts on a lock or a replacement (a vault switch-on, raised delay, lock, unlock, switch-off and replacement apply this in their own transaction and land only with it, refused rather than landing without it if the platform refuses or the gas runs short, every queued payout or pending switch-off from before a lock stays dead even if that part fails, and a request made after an unlock is never cancelled by an earlier lock applied late; an unlock and a switch-off also apply their platform side in their own transaction), and raises the code-pin and NFT-lock delays. The alpha site's protection pages (safety, payout destinations, secondary signers and the known-address check) read and write the vault, report each step of a multi-step action, and on a phone scroll their buttons clear of the bottom bar. Design: `docs/DesignsAndPlans/VaultOutflowPolicyDesign.md` (Stage B2 build notes).

> Caveat: queued payout rows stay with the platform until Stage B3. A row a lock cancels is cancelled when the platform applies the lock; until then it cannot be released, because the release reads the lock from the vault.
> Caveat: until the indexer reads the vault's own events (Stage B4), the keeper finalizes only the vault changes a ledger row names, and the owner alerts for a lock or a proposed replacement do not fire. The app, the alpha site and the keeper reach the vault by direct transactions only; the signed and relayed forms reach them in Stage B4.

_Committed 2026-11-15 21:43 UTC (8ec306b61)._
<!-- assembled-fragment: 3379-stage-b2-vault-held-protection.md sha256=4f8316f1d0fcdc74f7bb3a630bed6a4e8e41daee2a01fb88ff57c9e88a675c8d -->

## Price reads — every guard read gets a fixed gas budget (PR #3608)

Every reading the Diamond takes from the price guard now gives the guard one fixed amount of gas (500,000), whatever the transaction carries. Before the read, the reader checks that it holds enough to pass all of it on, and fails with a named reason (`PriceReadOutOfGas`) when it does not. This covers the strict price read, the status read, the secondary-source count, the sequencer health read and the sequencer-outage reading behind loan deadlines.

The readers that carry on without a price the guard refuses now read through one helper with the same check: the hourly price checkpoints, the daily price snapshot, the pair-calm rule (shared by the maker's price-move guard and the forced-sale floor), the fee-discount and fee-entitlement valuations, and the two reward valuations. A refusal the guard returns still reads as "no price". Running short of gas no longer does. The same holds one level up, for the steps that ask the Diamond for a figure built on a price and carry on without it: the health factor and LTV reported when collateral is added (and the check that cures a loan held in fallback), the health factor reported when a loan opens or its obligation moves to a new borrower, the liquidity tier stamped on a new loan, the liquidity check before a partial collateral withdrawal, and the sale-admission checks. Without this, adding collateral under an estimated gas limit reported a health factor of zero and could leave a cure unapplied.

Why: a read that ran out of gas was caught exactly like a refused price, so the caller's gas limit could decide the outcome. The visible symptom was the hourly checkpoint: a gas estimate found the limit at which the price read ran out and the asset was skipped, so the keeper's estimate-based sends reverted and other senders saw a call that "landed" without writing. The same seam sat one level down, inside the guard, which reads each outside source in its own try and carries on without one that fails. A fixed budget closes both, because what the guard answers then depends only on the chain and its own settings.

The trade is stated: the budget raises the gas limit a transaction reading a price must carry by about half a million (only the gas actually used is paid), and a guard that one day needs more than the budget would read as refusing prices until a facet refresh raises it. Measured on Base Sepolia, a whole price read costs 45,000 to 57,000 gas.

Closes #3504.

> Caveat: a reward cap's ETH reference read goes to the guard's ETH feed directly rather than through the guard's read, so it is outside this rule. It is followed by the claim's own writes, so a starved read there cannot complete the transaction; bringing it under the same budget is follow-up #3581.

_Committed 2026-11-15 03:48 UTC (f3a2587ad)._
<!-- assembled-fragment: 3504-price-reads-fixed-gas-budget.md sha256=d91843f613584014eb916edf37c37ad403a1da1e59b26ca2e8b37813618c8398 -->

## Thread — The treasury lives only in the vault code (#3569)

The protocol treasury now lives in exactly one place: the treasury address fixed into the vault code that every user vault runs. The Diamond no longer keeps its own copy. The admin setter for the treasury and its announcement are removed, the protocol registry no longer holds a treasury entry, and the Diamond's treasury read now reports the treasury named by the current vault code. Before this change the two copies could disagree, and a disagreement either refused fees or sent them somewhere the other copy did not name. This follows the owner's decision to keep the treasury in the vault code only.

Moving the treasury is now a vault code change and nothing else: register new vault code built with the new treasury, propose it as the current version, wait the seven-day vault-code delay, and make it current. After handover the vault version registry is owned by the governance timelock, so the move is visible for the whole wait and the pauser can cancel it. The one exception is the guardian's emergency path: while the platform is paused, the guardian can withdraw the current vault code and make already-registered code current at once, so the treasury can move immediately to one named by any registered version. The runbooks now say this and ask operators to keep only registered versions whose treasury they accept.

Fees follow the code of whoever pays them. A fee the Diamond moves itself, from a payer's wallet or from a share it already holds, goes to the current vault code's treasury. A fee drawn from a vault goes to the treasury that vault's own code names, so a vault whose owner pinned an older version keeps paying that version's treasury until the owner unpins. To end that, revoke the old version; its pinned vaults then run the current code.

The Diamond's own treasury ledger counts a fee only when the fee actually reached the Diamond. Treasury conversion, payroll funding and the backstop seed and withdrawal, which spend funds the Diamond holds as treasury, work only while the current vault code names the Diamond. A fee with no treasury set is refused by name and never sent to an empty address. The deploy refuses a missing treasury, builds the vault code with the one it is given, and checks that the Diamond reports it back; the launch check no longer compares the treasury between two copies, because there is only one.

Off-chain, the protocol console marks the treasury as a setting the Diamond does not announce, since it moves with the vault code, and the indexer no longer listens for the removed announcement. Tests change a test Diamond's treasury by installing vault code that names the new one, and the guard that refused direct setter calls in tests is retired with the setter. The platform is pre-live and every chain gets a fresh deploy, so nothing is migrated.

> Caveat: a vault pinned to an older vault version pays that version's treasury until it unpins or the version is revoked.

Closes #3569

_Committed 2026-11-15 01:22 UTC (0ae3c89da)._
<!-- assembled-fragment: 3569-treasury-from-vault-code.md sha256=9c03bfb00b97d0c6331ce28c5ffb8ac688a2224331015e56a4bcd8586b08faf9 -->

## Thread — The keeper rehearsal flow runs on the staged runner (#3574)

The keeper rehearsal flow (PF-300) now broadcasts through the staged runner. Before this change it could only run as a simulation, because it posted an offer and filled it in the same broadcast, which the offer-age rule refuses before anything is sent.

The scenario now takes three steps. The first posts the lender's offer. The second, once the offer's terms have aged, opens the loan and has the borrower approve a keeper for one action on it. The third has the keeper preclose the loan from its own wallet, then the borrower revokes the keeper.

The keeper approval is recorded as a setting to put back. If a run stops after the approval, the unwind step revokes it when the chain still shows it, so an abandoned rehearsal does not leave a live delegation on the borrower. This was exercised on a run that really broke: the closing check refused, and the unwind revoked the leftover keeper.

The staged runner now sizes each transaction's gas from the node's own estimate, taken when the transaction is sent, instead of from a multiple of the gas forge's simulation measured. A price read through the Diamond needs a fixed gas reserve on top of what it uses, so a transaction that reads a price late in its run was refused for lack of gas even at twice its measured use. The node's estimator finds the limit the transaction actually needs. The timed, swap-to-repay and lender-intent modules were re-run on this sizing.

Advances #3574. The partial and negative flow scripts and the vault and operator-admin modules are still simulation-only; staging them, one module per change, is the rest of that issue.

> Caveat: on a public testnet the node's estimate can come from a slightly stale view of the chain, which the runbook already notes for other broadcasts; a stage stopped that way is handled like any stage that did not land whole: unwind it and start a fresh run.

_Committed 2026-11-15 08:28 UTC (4e76595ea)._
<!-- assembled-fragment: 3574-keeper-staged.md sha256=5ad015a3eedfe74a0372c916dbd8f2fd584b25aea744a8b9d8ad1c0a183229cc -->

## Thread — The operator and compliance rehearsal flows run on the staged runner (#3574)

The operator and compliance rehearsal flows now broadcast through the staged runner. These are the flagged wallet whose close-out stays open (PF-008), the per-asset and global pauses (PF-323, PF-322), treasury accrual (PF-329) and the admin fee setting (PF-324). Before this change they could only run as a simulation, because three of them posted an offer and filled it in the same broadcast, which the offer-age rule refuses before anything is sent.

A scenario that fills an offer it posted now posts it in one step and fills it in a later one, once the offer's terms have aged. The fee scenario takes a third step: it opens its first loan at the configured fee and changes the fee, then opens a second loan at the new fee and puts the original back. The pauses take one step each.

Every setting these flows change is recorded as a setting to put back: the borrower's sanctions flag, the asset pause, the global pause and the initiation fee. If a run stops part-way, the unwind step restores whatever the chain still shows changed, and the closing check refuses while anything is. This was exercised on a run stopped after the fee change, and on a record whose flag and pauses were set by hand. Each time the unwind put every setting back, and a second unwind found nothing left to do.

The rehearsal runbook runs the operator-admin module in the same loop as the other staged modules.

Advances #3574. The partial and negative flow scripts and the vault module are still simulation-only.

> Caveat: unwinding an abandoned run puts the settings back but leaves that run's open offers and loans on the rehearsal chain.

_Committed 2026-11-15 09:27 UTC (3f0568591)._
<!-- assembled-fragment: 3574-operator-admin-staged.md sha256=c71ecdc0366bd629e373358bd3c15b61e463c7b375816d95f392552f50bd23f5 -->

## Thread — The swap-to-repay rehearsal flows run on the staged runner (#3574)

The swap-to-repay rehearsal flows, a full close-out paid from a collateral sale (PF-118) and a partial repayment from one (PF-119), now broadcast through the staged runner. Before this change they could only run as a simulation, because each posted an offer and filled it in the same broadcast, which the offer-age rule refuses before anything is sent.

Each scenario now takes two steps. The first posts the lender's offer. The second, once the offer's terms have aged, registers a fixed-rate swap adapter, opens the loan, sells the collateral and checks every unit of the proceeds as before. It then closes the loan out and takes the adapter off the swap list.

The swap adapter a scenario registers is now one of the settings the staged runner records and puts back, shared by every staged module rather than kept inside the timed module. If a run stops part-way, the unwind step takes the adapter off the swap list when the chain still shows it there. The closing check refuses while it is still listed.

The rehearsal runbook runs the swap-to-repay module in the same loop as the other staged modules.

Advances #3574. The partial and negative flow scripts and the vault, keeper and operator-admin modules are still simulation-only; staging them, one module per change, is the rest of that issue.

> Caveat: unwinding an abandoned swap-to-repay run takes the adapter off the swap list but leaves that run's open offer or loan on the rehearsal chain.

_Committed 2026-11-15 06:03 UTC (0784158f6)._
<!-- assembled-fragment: 3574-swap-to-repay-staged.md sha256=c13718e3691006ad1ddc47f6f615f476fa6ced0146eea310f7448dbb98626593 -->

## Thread — The timed positive flows run on the staged runner (#3574)

The positive flows that must wait between their steps, cancelling an offer after the five-minute cancel cooldown (PF-045, PF-046) and settling a monthly interest checkpoint once it is due (PF-116), now run on the same staged runner as the other broadcastable positive-flow modules. Before this change they had their own three-stage script, and since the offer-age rule its first stage could not broadcast at all: PF-116 posted an offer and accepted it in the same broadcast, which the rule refuses before anything is sent, so the whole timed rehearsal opened nothing.

The staged runner now lets a step say how long its next step must wait, beyond the usual offer-age wait. The record each stage writes carries that wait and the earliest time the next stage may run, and a stage run too early is refused by name. On a local Anvil the runner steps the clock for every wait. On a live rehearsal chain it waits out short waits (up to thirty minutes by default) and stops with a distinct exit code before a longer one, saying when the next stage may run; running the same command again then resumes from the record.

PF-116 now takes three steps: it turns on the periodic-interest switch if it is off, registers its settlement adapter, lowers the finer-cadence threshold if needed and posts its offer; once the offer's terms have aged it accepts it and puts the threshold back; once the checkpoint is due it settles it from collateral, closes the loan out and puts back the switch and the adapter. A setting changed across a wait is written into the run's record with the value to put back, and stays there until the run ends, even after the step that puts it back, because that step's broadcast may stop part-way. Whether a setting still needs putting back is read from the chain, not from the record. A run abandoned part-way can be unwound with a new step that puts back whatever the chain still shows changed, and the closing check refuses while any recorded setting is still changed, so a month-long wait never leaves a protocol setting changed without a record of it.

The separate timed runner script and its record are retired. The rehearsal runbook now runs the timed module in the same loop as the other staged modules.

Advances #3574. The partial and negative flow scripts and the vault, keeper, operator-admin and swap-to-repay modules are still simulation-only; staging them, one module per change, is the rest of that issue.

> Caveat: unwinding an abandoned timed run puts back the protocol settings it changed but leaves its open offers and loan on the rehearsal chain.

_Committed 2026-11-15 03:35 UTC (9dea35e14)._
<!-- assembled-fragment: 3574-timed-flows-staged.md sha256=716472eb0009966275e63a093e8d611a1238136607ed0b08373ab67005c1a8cb -->

## Thread — The vault and VPFI rehearsal flows run on the staged runner (#3574)

The vault and VPFI rehearsal flows now broadcast through the staged runner. They cover recovering a stray token from a vault (PF-280), the ban when the declared source is sanctioned (PF-281), disowning a stray token (PF-282), and the VPFI deposit, discount consent, loan and withdraw sequence (PF-250). With this change every positive-flow module broadcasts in stages, and the rehearsal runbook runs all nine in one loop.

The recovery scenarios take one step each. The VPFI scenario takes two. The first funds the borrower in a mock VPFI token, deposits and consents, and posts the lender's offer. The second runs once the deposit has been held for the Diamond's minimum staking period plus a day, a period it reads from the Diamond rather than assuming. It opens and closes the loan, checks that no VPFI left the borrower's vault, withdraws free VPFI and puts the discount settings back. On a local chain the runner steps the clock past that wait; on a live testnet the run waits for it.

Every setting these flows change is recorded as a setting to put back: the sanctioned source PF-281 flags, and the discount rate, reference asset and borrower consent PF-250 changes. If a run stops part-way, the unwind step restores whatever the chain still shows changed, and the closing check refuses while anything is. This was exercised on a run stopped after the VPFI setup: the unwind put back the rate, the reference asset and the consent, and a second unwind found nothing left to do.

The VPFI scenario never replaces the Diamond's VPFI token. Replacing a token cannot be undone: it retires the deposit period and clears the service capacity settings, and setting the old token back is a second replacement that restores neither. So the scenario registers its mock token only on a Diamond that has none, reuses a mock an earlier run registered, and on a Diamond with any other token it is skipped and says why.

Advances #3574. The partial and negative flow scripts are still simulation-only.

> Caveat: a Diamond with no VPFI token set keeps the mock token registered after the run, because the Diamond refuses to set the token back to none. Only a fresh local chain starts that way.

_Committed 2026-11-15 10:56 UTC (0934d44ff)._
<!-- assembled-fragment: 3574-vault-vpfi-staged.md sha256=0ff6eb4bad998004aa7e529e08fa9a47dcb3a47deb3f51b793c028516fc7806f -->

## Keeper matcher pairs pro-rata offers across terms (#3615)

Since #3617 the contract matches a lender and a borrower offer of different terms when both chose pro-rata interest and the borrower's term is the shorter one (the loan runs the borrower's term). The keeper's matcher still grouped offers by exact term, so it never looked at such a pair and the offers sat idle.

The matcher now groups offers by asset pair alone and checks each lender and borrower pair against the contract's term rule before it spends a preview: equal terms always pass, and different terms pass only for a pro-rata pair with the shorter borrower term. The contract's preview stays the final word. The fairness walk is unchanged, so one wallet's offers still cannot use up a run.

The change takes effect where the #3617 contract change is live, which is the next fresh testnet deploy. Until then the preview refuses the new pairs and the matcher simply moves on.

_Committed 2026-11-15 04:39 UTC (d91c863b5)._
<!-- assembled-fragment: 3615-keeper-matcher-terms.md sha256=01d51832fc83cabd73c1bb90a53c361d8849388575695de5171424ae96565361 -->

## Thread — Pro-rata matches admit a shorter borrower term (PR #3617)

Two resting offers used to match only when they named exactly the same term. That is still the rule when both chose full-term interest, because there the term is part of the price: the borrower owes interest for all of it.

When both chose pro-rata interest, the borrower now matches any lender whose term is the same as or longer than its own, and the loan runs for exactly the term the borrower asked for. Under pro-rata, interest is owed only for the time the loan is held and the borrower can repay at any moment, so the lender's term already meant "the longest I will lend for". A borrower never gets a shorter term than it asked for, and a lender never lends longer than it offered. A ranged pro-rata lender offer can now be filled by several borrowers with different shorter terms, each as its own loan.

Nothing new is stored and no setting was added. The loan already took its term from the borrower offer; only the match check changed, in the one shared match core, so the match, the signed-offer match and every match preview agree. No funds move differently: amount, rate and collateral rules are unchanged, and the loan's term is stated in its creation event as before.

This came from an outside design proposal that suggested tolerance windows around each term with a midpoint, per-offer tolerance fields and an opt-in "accept any shorter" flag. Those were not adopted: under pro-rata the windows protect nothing the interest mode has not already given away, and the flag would repeat what choosing pro-rata already says. The same proposal's on-chain price-time priority (refuse a match when a better offer exists) was also not adopted; it would need an unbounded scan of the book and anyone could revert a match by posting a slightly better offer. The spec now says so.

Follow-ups: the keeper matcher groups offers by term, so it does not yet propose cross-term pairs; and the app should tell a lender choosing pro-rata that its term is the longest it lends for.

Closes #3615

_Committed 2026-11-15 03:57 UTC (608f54f0a)._
<!-- assembled-fragment: 3615-pro-rata-duration-match.md sha256=dde49a58d36a93008bc70436fbb8e7974abc92f54ddc0d84ae0314e8512814e5 -->

## Thread — Auto-lend end date and pro-rata opt-in (PR #3644)

A standing lender intent (Auto-lend) can now carry two more lender choices, set
in the same call that sets its other bounds and stated in its set event, its
read view and the keeper discovery feed.

**Lend-until time.** For money free only for a fixed window, the lender may set
an end time. A fill is admitted only when the loan's agreed maturity (now plus
the borrower's term) falls at or before it, so as the window runs down only
shorter loans fit. A repaid loan is rolled back behind the intent only while a
one-day loan could still fit; after that the roll is refused and the proceeds
take the normal lender claim back to the lender's vault, and the keeper
discovery feed stops listing the intent, since it can fill nothing more. The end
time must leave room for a one-day loan counted from when the newly set terms
may first be filled. Nothing moves when the time passes: un-lent capital stays reserved until the lender withdraws it or sets
a new date. The time bounds agreed maturity only. Late repayment in grace, a
default and a protocol pause can all end a loan after it, so the app must never
say funds return by that date.

**Pro-rata opt-in.** By default an intent still fills only full-term, full-repay
requests. Opted in, it also fills pro-rata requests, including ones that allow
partial repayment, and each loan carries the borrower's chosen mode. A partial
repayment is paid to the lender position's holder exactly as on any loan; it is
not re-committed behind the intent, and the exposure cap keeps counting the
original fill until the loan closes. A later roll re-commits only what the final
repayment measured into the vault, never the original fill. The backstop and the
aggregator adapters keep both choices off.

One shared rule (a new library) decides fills, previews, rolls and both feeds,
so they cannot disagree; the preview gains a "past lend-until" reason. No
fund-moving path changed: the new rules only refuse a fill or a roll. The two
keeper discovery feeds moved from the metrics facet, which had reached its size
limit, to the lender-intent facet beside the per-owner intent list; their
selectors are unchanged. The function signature, struct and event change, so
this reaches a chain by fresh deploy. Design:
`docs/DesignsAndPlans/AutoLendLendUntilDesign.md`.

Closes #3618. Closes #3619.

The keeper's intent pre-filter applies the same pro-rata rule, so the matching service tries a pro-rata request against an opted-in intent. The borrower page's standing lenders count each lender's end date and pro-rata opt-in.

> Caveat: the lender's setup form for the two choices is a follow-up in its own thread.

_Committed 2026-11-15 11:12 UTC (8ff8bf0f9)._
<!-- assembled-fragment: 3618-intent-lend-until-and-pro-rata.md sha256=9d379ad6eddaf08de114c1f3c0b5444beb2765ad7cd3c1000f2742b586231b13 -->

## Keeper — new and re-priced offers are matched first

The keeper's offer matcher now looks at new and re-priced offers before its ordinary walk of the book. An offer created or re-priced in the last ten minutes, and old enough for the protocol's terms-age rule, is previewed against the offers resting in its own bucket at the start of the next matcher run. Before this, a new offer waited until the rotating walk happened to reach its pair, which on a large book could take several runs.

This first look cannot take the walk's turn. It may spend at most a fixed share of each run's previews, matches and time: a quarter by default, set by the plain var `MATCHER_FRESH_LANE_SHARE` (0 turns it off, half is the most allowed). The walk keeps the rest of the run whether or not that share was used, and it skips pairs the first look already previewed. So the walk never has less than three quarters of what it had before, and a test shows a resting pair elsewhere in a busy book is still reached within the same number of runs as without the lane.

Each offer gets this priority once for its creation. A re-price earns it again only an hour after the offer last had it, so re-pricing an offer over and over cannot keep it at the front. Inside the first look the pairs are walked in the same creator-pair turns as the ordinary walk, so one wallet posting many offers at once counts as one counterparty.

The keeper remembers which offers already had their turn only while it runs. After a restart, an offer changed in the last ten minutes may get one more turn, which costs at most one share of a run.

Advances #3622 (part B2). Design: IdleLiquidityMatchingDesign.md section 3, B2. No contract change.

> Caveat: the walk keeps at least (1 − share) of each run's budget rather than all of it, so on a book larger than one run can cover, the ordinary walk can need slightly more runs to reach every pair than before; at the default share the test book above still needs no more runs.

_Committed 2026-11-15 05:30 UTC (4eff6818a)._
<!-- assembled-fragment: 3622-keeper-matcher-fresh-lane.md sha256=a960fbb1433ccb83ea140ca4996979daa8ff161f911a6c3cf7aeb63bd187737b -->
