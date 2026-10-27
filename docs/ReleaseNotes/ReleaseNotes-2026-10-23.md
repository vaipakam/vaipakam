# Release Notes — 2026-10-23

Today's changes are mostly about saying exactly what is known. The Rate Desk now shows each fill at the terms it was agreed at, and when it cannot confirm a loan's terms it says so instead of guessing. The Activity page admits a wallet's events by one shared rule and names every event filed under a loan or offer. On the governance side, a fresh Diamond now stays paused until a launch step proves it is ready, the live handover has its own check, and each chain's storage layout is recorded so an in-place upgrade can be checked against it. The keeper machine stopped starving the keeper during its own builds, and the connected app can now be installed to a home screen and refuses inline script. None of the contract changes has reached the testnets yet; testnet refreshes wait until the current waves of work are done.

## Thread — Rate Desk fills show the terms they were agreed at (PR #2689)

The Rate Desk's recent-loans tape, its "last agreed rate" header and the chart's per-fill markers read each loan's live terms. A loan's rate and term can be extended, and its outstanding amount falls as it is repaid or matched. So a past fill could appear at a rate it never traded at, with an amount smaller than was lent. An extended 30-day loan also left the 30-day tape and showed up in the 60-day one. The rate-history candles already used the agreed terms, but when the indexer could not confirm them from the loan's opening record they silently drew, and filed under a tenor, the best figure it had.

The desk now follows one placement rule in the indexer, shared by the tape, the candles and the market key served on every loan row: a loan is a fill of a tenor market only once its agreed terms are confirmed from its opening record, and then of the tenor it was agreed in. A loan whose terms are not yet confirmed has an unknown tenor, so it appears under no duration rather than under a guessed or current one. The candle response counts such loans on the pair for the period, read in the same snapshot as the candles so a loan confirmed mid-request is counted exactly once, and the chart states that count. The count stops at 1,000; past that the chart says "more than 1,000". When nothing at the chosen duration can be drawn, the chart says only that no confirmed loan sits there. The recent-loans list states the pair's count too (all time), and when it is empty it says no loan with confirmed terms sits at this duration rather than that no loans were agreed. The empty messages that used to say "for this pair" now say "at this duration", since both views show one duration. The indexer re-checks unconfirmed loans on every pass, and a loan joins its market once its opening record confirms the terms. New indexes keep both market reads cheap.

The app turns a loan into a desk fill in one place, which keeps only the agreed rate and amount. When only the agreed amount is unconfirmed, the tape says "not recorded" for it, and the chart still draws the loan as its own marker, with "not recorded" in its hover detail. A bucket's hover detail says its total is a minimum when it leaves out loans whose agreed amount is not confirmed. The chart also states a clipped history when nothing in the range is drawn. When the tape already shows a loan in the period that the chart's last refresh missed, the chart says it is catching up instead of claiming the period is empty. The tape now states the market and placement rule it was read under, so an empty tape is trusted only when the indexer says it applied them; the old page walk for indexers that ignored the market filter is gone.

The existing fields on the loan routes keep their meaning, and the market key and the new candle fields are added to them. The app now requires the new fields: a rate history that does not state what it leaves out is shown as unavailable, and a loan row without a market key is placed in no market. The indexer deploys on merge and the app is deployed later, so the app never meets an indexer without them; the app deployed today reads neither field. Closes #1142.

_Committed 2026-10-23 08:37 UTC (0faedafc4)._
<!-- assembled-fragment: 1142-desk-fills-agreed-terms.md sha256=8ff0e3372ce4e4fb44b595c3d8dfb8878811990e2a896b2cda796438b7ef3c02 -->

## Thread — retired "Buy VPFI" shortcut removed (PR #2688)

The marketing site still served a web-app manifest left over from the retired app. It offered a "Buy VPFI" launcher shortcut to the in-app purchase route that the #687-A excision removed. No page on the marketing site has ever linked it, so no browser could install it from there. The retired app linked its own copy on its own host, and that copy went with the app. The shortcuts did not lead where their names said. The marketing site reads an unknown first path segment as a language, so "/app" showed the landing page and the purchase shortcut was redirected to the VPFI information page. The file has been deleted. Three comments that still pointed readers at the retired route now point at the connected app's VPFI vault page, and say plainly that there is no protocol VPFI purchase surface.

The website spec's intent is that the connected app be installable, with real shortcuts and no purchase entry. That was never built, and it is now recorded as a gap tracked in #2687. A guard against text that names the retired route is left to the excision triage in #1728. The gate matches normalised prose, and a route spelled that way also matched unrelated names. Closes #1742.

_Committed 2026-10-23 06:18 UTC (893724e2a)._
<!-- assembled-fragment: 1742-retired-buy-vpfi-shortcut.md sha256=ac8d655b854371a0ca7d2226048eccb0cca5e713883fe8913d403d05e3db33c5 -->

## Thread — the lender's sale listing states and binds the seller's minimum, and says when it can no longer sell

The connected app's listing form now shows a lender, before they list, the least they will come out with if a buyer takes the listing at any moment before it ends, and the balance already set aside for the lender that goes to the buyer with the position. Both figures come from the protocol's own quote for the rate and window on the form, never from the app's own arithmetic. The quote allows for the time the listing takes to confirm (half an hour) and for the protocol's rounding. Both allowances only lower the figure shown, so it is one the listing can actually meet. The listing is then submitted through the bound entry point with the figures the seller reviewed. If the loan has moved so that the listing would record a lower minimum or a larger set-aside balance, the chain refuses it and nothing is listed; the review closes, the quote is read afresh, and the seller reviews again. A listing transaction that fails after it was sent closes the review the same way, and every review starts with the consent box cleared, so consent always covers the figures on screen. When the minimum cannot be read, the form says so and does not offer the listing. The four new refusals (the two at listing, and the two a buyer meets once a listed loan has changed) have plain-language messages in every translated locale.

The standing listing card now reads the listing's own record: it says until when buyers can take it, that a buyer has taken it and settlement is still finishing, or that it ended without a buyer and why the NFT is still locked. It explains that a loan change breaking the recorded figures (a partial repayment is enough) makes buyers' attempts fail, and that the remedy is to cancel and relist. It also states the one thing it cannot check: no view returns the figures a listing recorded, so the card cannot yet say whether that has happened (the view is tracked in #2672). The lender exit chooser now stops presenting a listing's costs as pending once the record shows it can no longer complete, though only on a current read. When the latest read has failed, the card no longer presents the last answer as current: it states nothing drawn from the listing's record and says it could not read the current state. An accepted listing is no longer also described as live, and the card mentions cancelling only where it offers the cancel button.

The app also stops asking sellers to fund the sale (#2674). The protocol has deducted the settlement from the buyer's payment since the listed-sale escrow landed, so nothing comes from the seller's wallet. The listing no longer sets a token approval, the card no longer watches the seller's balance or offers to restore an approval, cancelling no longer revokes one, and every payout line now says the seller receives the buyer's payment less the settlement. A buyer's review no longer reads the seller's wallet either: it checks that the settlement fits inside the payment, which is the only way that part of a sale can fail. Approvals set by earlier versions of the app stay in place until the seller removes them, and the cancel message says where.

Closes #1810, #1848 and #2674. The functional specs carry the intended behaviour, and the code-versus-docs audit entry for #1848 is marked resolved. The audit entry also records the spec contradiction settled here: a partial repayment makes a bounded listing unfillable, where an older line said a buyer simply re-signs. The offset-acceptance review (#2523) follows separately. This needs the listing-bound and quote selectors routed on the target Diamond, which they are on Base Sepolia and Arbitrum Sepolia.

_Committed 2026-10-23 02:52 UTC (b6bc3a1f8)._
<!-- assembled-fragment: 1810-1848-sale-listing-floor.md sha256=ea27172ea9622a0f38173202eaa9b4745e162b15b48b02494dedd9f9c6dae675 -->

## App — the local erasure as one operation per tab, and an end to the cross-tab clearer (PR #2670)

**The erasure and its report now outlive the page that started them (#2038).** Erasing resets the display language first, so the erasure clears what that change saves. In any language other than English, that reset rebuilds the whole page while the erasure is still running. The page used to hold the "working" state and the result itself, so the rebuilt page forgot both. A second erasure could be started over the first one, and the first one's report went to a page that no longer existed, so the user saw no report at all. The erasure is now a single operation for the tab, held outside the page. The rebuilt page shows that it is running, refuses to start a second one, and shows the report when it finishes. A new browser test drives this in Spanish. Against the old code it finds no report.

**A wallet that is still reconnecting is waited for, not misreported (#2039).** When the app restores a wallet connection from a previous visit, there is briefly no real connection to close, only a stored record of one. Closing that record did nothing, and the restore then finished anyway and put the session back. The erasure now waits a bounded few seconds for the restore to finish, then closes whatever is actually connected. If the wait runs out, it says the wallet could not be disconnected yet, that it may sign the user back in, and that erasing again once it has will finish the job. Each wallet is handled on its own, so a wallet that has finished restoring is still closed when another one is stuck restoring. Before, this case was reported as a wallet that refused.

**A wallet connection that reloads the page is closed last, and the report survives the reload (#2035).** Coinbase Wallet's mobile link ends its connection by reloading the page, and the app cannot stop it. That connection is now closed only after everything the erasure counts has been cleared, so the reload can no longer interrupt anything. Just before that last step, the report as it stands is kept for this tab only. It holds counts and outcomes, nothing about the wallet or the user. If the page reloads, the report is shown again and then discarded. That wallet's library can fire its reload a moment after it reports the connection closed, so the kept copy is not removed the instant the step finishes: it lasts thirty seconds from when that step comes back, and is removed when that time runs out, when the report is dismissed, by the next erasure, or when it is read after a reload. It is shown only on an actual reload, so a tab opened from this one, which inherits its per-tab storage, does not show a report for an erasure it never ran. It is the erasure's own record, so it is never counted as an item the erasure failed to remove. For the same thirty seconds, a further erasure in that tab waits before doing anything, so a late reload cannot cut it off. After a reload, the report says only what is known: the connection was asked to close last and the page reloaded during that step or shortly after it, before its outcome was known. It does not claim the wallet was disconnected, nor that the earlier steps all succeeded (only that they had finished; the report's other lines say how they went), and it tells the user how to check.

**Other open tabs no longer clear the stores they share with the erasing tab (#2037).** Another tab told about an erasure used to clear the shared browser storage and the wallet databases again after closing its own wallet. That second, uncoordinated clearer had two failures that could not be fixed inside the design. Arriving late (a background tab can receive the request long after it was sent), it deleted things the user had stored since, sessions included. Arriving early, it emptied the wallet databases before the erasing tab had counted them, so that tab reported erasing nothing over records it had removed. Other tabs now act only on their own per-tab data, their own wallet connection and their on-screen preferences. Their language reset removes exactly what it wrote and nothing else, and it keeps a language the user chose since; theme and mode now follow the same rule, so a tab that hears of the erasure late shows a theme or mode chosen since rather than the default. A tab never runs its own erasure and a follow-up of another tab's side by side: a request from another tab that arrives during this tab's own erasure is carried out after it, and an erasure requested while this tab is still closing its wallet for another tab waits for that first (for up to thirty seconds after a wallet that reloads the page, since its reload can come late), so that reload cannot cut an erasure off before its report is kept. Requests from other tabs heard one after another wait the same way for each other. A tab handling another tab's erasure decides which of its wallets to close when the request arrives, so a wallet connected while it waits its turn is left alone.

**The erasure ends exactly the connections the request found.** It decides which wallets to close when the user asks, counting a connection that was still being restored then as the restored connection once it settles, and closes only those, so a wallet the user connects while the erasure runs, or while that restore finishes, is left alone. A wallet that is still connected while the user is part-way through connecting another is now closed too; the erasure used to skip it. And a close that finds nothing left to end is no longer reported as having signed the user out. Cleanup after a wallet that answered late now waits until every connection the erasure was closing has finished, so it no longer gives up because the erasure's own last connection still looked live. The cost is that a wallet closing in another tab can write a small connection record back after the erasing tab has finished. The Data Rights page now states this, along with the remedy: erasing again from any tab removes it.

Closes #2038. Closes #2039. Closes #2035. Closes #2037.

_Committed 2026-10-23 01:15 UTC (69dcd879f)._
<!-- assembled-fragment: 2038-2039-2035-2037-erasure-lifecycle.md sha256=3d316c968f31e3760321cb32cbc48389edae47619062257f25c4425baefd8be2 -->

## Thread — the protocol console shows every protocol-wide setting, read from the chain when the snapshot falls short (#2071, #2074)

The protocol console used to show only the fees, a few risk limits, two durations and three feature switches. It now also shows the loan-admission health-factor floor, the swap-to-repay slippage limit, the quote-time rate model and its deviation limit, the whole price-oracle stack (the secondary-oracle limits, the Pyth oracle and its cross-check limits, and the layer-2 sequencer guard), the periodic-interest and reference-currency settings, the automation switches and the keeper pause, the cross-chain day-close grace window, and the treasury address. An unset address or id reads as "not set", and an unset grace window shows the documented four-hour default, marked as the default, rather than showing zero. The Pyth rows say the cross-check needs both its oracle and its feed id, the keeper pause says what it does not stop (an owner's own actions, liquidation, and reward-commitment submission, so a compromised keeper key must also lose its role), and the sequencer uptime feed row says that, because changing it emits no on-chain event (#2685), the indexer's snapshot can show its previous value until the next scheduled refresh. Each automation switch now says what it does and does not stop, and the console adds the standing-intent fill switch, since the auto-lend switch only refuses new opt-ins and stops no fill; the parameter reference gains a section for that switch. If a direct contract read comes back from an older block than the snapshot it was meant to replace, the console keeps the newer snapshot and says the contracts could not be read; for a snapshot the indexer already knows is behind, the indexer now records the block at which it saw the change, and both a direct read and the indexer's own next snapshot must reach that block before they count as current (a snapshot marked before this change needs only a later block than its own). The console also shows the ETH price feed in the reference currency, which changes together with it, and the indexer now refreshes its snapshot after any upgrade of the Diamond's code as well as after setting changes.

Every setting in the canonical parameter reference is now accounted for. Each is either shown, or carries a recorded reason it is not: it differs per asset or per chain, it is a fixed constant, it belongs to the rewards and recycling surfaces, it is off on this deployment, the contracts offer no way to read it, or it is not shown yet. A build check fails when the reference gains a setting without one of the two. The few protocol-wide settings readable only as part of a larger answer are tracked for a later change.

The indexer now publishes those settings in its configuration snapshot, read in one call at one block, and re-reads them when governance changes any of them. The console uses that snapshot only while it is dated, recent, not known to be behind, labelled and complete. Otherwise it reads the same values directly from the contracts at one block, and the line at the foot of the page says so, with the block, when it was read, and why the snapshot was not used. A snapshot that is not current is shown only if that direct read fails too, and then with a warning that the values may be out of date. All nine translated languages carry the new wording.

One finding came out of this work: the contracts report the grace window as zero when it was never set, rather than the default the protocol actually uses. That is filed separately for the contracts.

_Committed 2026-10-23 05:54 UTC (6e45e4db4)._
<!-- assembled-fragment: 2071-2074-protocol-console-knobs.md sha256=a4435a532a295b854760d38e54f3fdabe318002623db3e038385ef8a1b71b618 -->

## Thread — One address per app page: trailing slashes redirect (PR #2692)

Asking the connected app for a page with a trailing slash, such as `/vpfi/` instead of `/vpfi`, used to serve the page itself. The response carried a "do not index" header, but the page declared itself indexable. A browser ignored that disagreement. A search crawler that does not run the app saw only the header, so it treated a valid spelling of a public page as withheld.

The app's host now answers every such request with a permanent redirect to the address without the slash, keeping any query string, before anything is served. Each indexable page now has one address, and the header and the page can no longer contradict each other. The site root and deeper per-item addresses are unchanged.

This was checked against the same static-asset server the deployed app runs, and it is checked again on the live site after the next app deploy. Closes #2079.

_Committed 2026-10-23 09:16 UTC (d47d3cbb0)._
<!-- assembled-fragment: 2079-trailing-slash-redirect.md sha256=cbde5b4900c7f51e6bd6db5d004e07a2fa496747b4ef06e6bab6da023bdbd6c3 -->

## Thread — Each chain's storage layout is recorded, and in-place upgrades check it (PR #2684)

The storage-layout guard added on 2026-10-20 stops a layout break from merging,
but a chain does not run the newest code: it runs whatever last reached it. So
each deployed chain now carries its own record of the storage layout it runs,
next to its addresses. A fresh deploy writes that record, and every script that
upgrades a chain's code in place (the full and changed-facet refreshes, the two
curated refreshes, the oracle and risk-terms upgrades, and the vault
implementation upgrade) first checks the new code against the chain's record,
refuses before sending anything if a recorded fact would be lost, and rewrites
the record once its change is in. A chain with no record is refused, because
the layout it runs is unknown. Each record is also bound to the live
deployment it describes, all of it: the Diamond's facets, the vault and
adapter templates, and every upgradeable proxy the chain reaches, such as the
cross-chain messengers and receivers. An upgrade is refused when any of that
code has changed since the record was written, for example by an upgrade from
another checkout whose record was never committed, or by a refresh that
stopped part-way after upgrading one proxy. The token and cross-chain deploy
scripts check the record too and rewrite it with the proxies they add. Two upgrades of one chain still must
not run at the same time, and an interrupted upgrade is finished by running it
again, never by replaying its saved transactions, since a replay skips the
check. Declared renames count; acknowledged breaks
never do, since an acknowledged break means that chain needs a fresh deploy.

The check runs inside each script rather than in a wrapper (owner decision
2026-10-23), so no entry point can reach a chain around it. These scripts
therefore run with forge's `--ffi` flag, and the deploy and refresh wrappers
pass it; a run without it is refused before its first transaction. The
project's forge configuration is unchanged.

The three live testnets (Base Sepolia, Arbitrum Sepolia, BNB testnet) are
seeded with today's layout: the code they were deployed and refreshed with is
contained in it, as measured when the guard merged, and no break has been
acknowledged since. The retired Ethereum Sepolia and OP Sepolia carry no
record, so a refresh of either is refused. Refs #2092 (item 1).

_Committed 2026-10-23 11:32 UTC (03c26ad20)._
<!-- assembled-fragment: 2092-per-chain-storage-layout-record.md sha256=9aa9f7868924e5e7e1cab67a84cd264e74a3ab1f509dd03b4003124633067acd -->

## Keeper — risky-loan and pre-grace warnings send through the shared Push sender (PR #2676)

The keeper sends two kinds of Push alert: the warning when a loan's health
gets risky, and the warning before an auto-refinance loan reaches its grace
period. Until now it sent them with its own copy of the Push sender, which had
drifted from the agent's: it could not post as a delegate of the channel, and
when it had no usable signing key it printed one "skipping" line per
subscriber and said nothing else. It now uses the same shared sender as the
agent, so a correction to the sender lands once for both.

Two things change for operators. The keeper reads `PUSH_CHANNEL_ADDRESS`, the
channel to post as, from its machine's env file, exactly as the agent reads
it. With it unset the keeper posts as its signing key's own address, as
before; set it in both places, or the two senders post as different channels.
And each warning pass now reports what Push did not do in one line: how many
alerts Push could not send, with the reason (no signing key, a key that cannot
be used, or a malformed channel address), and how many sends failed. Failed
sends are never counted as delivered. Part of #2248.

_Committed 2026-10-23 03:25 UTC (ef0aaa3ba)._
<!-- assembled-fragment: 2248-keeper-shared-push-rail.md sha256=746f93f9f3c108a237dc23153611d953d57a5a78e096b6fcddf9b482ca22d483 -->

## Thread — Loan risk values carried at 1e18 numeraire precision (PR #2690)

Every value the protocol computes for a loan leg is now expressed in the active
numeraire with eighteen decimal places, through one shared rule, instead of in
whole numeraire units. That covers each leg of the loan-to-value and health-
factor readings (so loan initiation, liquidation, add-collateral and
refinance), the create-time collateral floor and lending ceiling an offer is
checked against, the partial-liquidation snapshots, the partial-withdrawal
simulation and every KYC comparison (both parties' on acceptance, the lender's
at default, both parties' on a counterparty change, and the liquidator's). An
asset that is not liquid still counts for nothing in a KYC comparison. The rule
rounds once, in the lender's favour: a debt or principal leg rounds up, a
collateral leg rounds down, and a value compared against a threshold rounds
down. The offer-time bounds are derived from the same rounding the binding
check uses: a health-factor bound is exactly the tightest value that check
accepts, and a loan-to-value bound holds the unrounded ratio to the cap, so it
is never looser than the check and at most one basis point stricter. A small
loan's risk figures are therefore exact to a billionth of a billionth of a
unit, and the pair-level loan-to-value preview reports the binding check's own
figure, computed by the same rule, rather than an approximation of it. Offers so small
that they fell below one numeraire unit now meet the same collateral bounds as
any other offer.

The rule lives in one library and is served to the facets close to the
contract size limit by a new view-only facet, the numeraire value facet, with
three reads: the value of an amount of a token, the amount of a token worth a
given value, and the value a KYC comparison uses (zero for an asset that is
not liquid). It reads the price through the oracle, so staleness, sequencer
and quorum refusals apply unchanged. A price of zero is refused rather than
used, and a token whose decimal count cannot be read is refused by name and is
not classified as liquid. A facet that values through the new facet,
refreshed onto a Diamond without it, fails with a clear "function does not
exist" revert rather than misreading a value. The change spans more facets
than either curated refresh script carries (the oracle's liquidity check, the
admin facet's dust floor, the offer bounds), so a Diamond reaches it only by a
fresh deploy or the full in-place refresh; both curated scripts refuse a
Diamond that has not crossed it, by name, before sending anything.

A time-based default now takes its route first from what the loan was when it
began. A loan whose two legs were both liquid when it began, and whose pair
cannot be priced (either leg has no price, or a price of zero), still
completes. It attempts no sale, because a sale with no oracle floor is not one
the protocol will make, and enters the fallback directly, the same entry a
failed sale takes: the lender's claim is the collateral, and the loan stays
curable until claimed. A missing collateral price no longer leaves such a loan
to the illiquid route, where a loan without both parties' illiquid consent
could not default at all. A loan that began illiquid on either leg keeps its
consented in-kind transfer, even when its collateral has since become liquid,
instead of failing in the risk calculation; its default does not consult the
live market check at all, so a price the oracle's sources disagree on cannot
hold it up. A token whose decimal count cannot be
read counts as having no usable price there, so such a loan takes the same
unpriced fallback. A price the
oracle's sources disagree on still refuses the default until they agree,
except where the other leg has no price at all, where the missing-price rule
wins as before.

Health factor and loan-to-value readings, the pair-level preview included,
are computed at full precision, from one shared rule, so a very large loan
never fails on an intermediate figure when each leg's value and the reading
itself can be stated.

An asset whose decimal count cannot be read is now classified illiquid before
any other check, including the wrapped-ether shortcut, so no part of the
protocol treats it as liquid while its valuation refuses.

**Operator action — the partial-liquidation dust floor.** The dust floor is
a numeraire value, so it moves to the same 1e18 scale: one thousand dollars is
now written as one thousand followed by eighteen zeros. A nonzero floor must
sit between one and one hundred thousand numeraire units, and the setter
refuses a value written on the old whole-unit scale by name. A floor already
stored on the old scale is below that minimum, so after the refresh it reads
as no floor: dust handling is off, and the sizing getter reports a floor of
zero. Set it again on the new scale if dust handling should stay on. Changing the active numeraire now also resets the floor to
zero (dust handling off) until governance sets one in the new numeraire. Dust
handling ships off by default, so a deployment that never set a floor needs
nothing.

Part of #2419.

_Committed 2026-10-23 20:28 UTC (ad3d53438)._
<!-- assembled-fragment: 2419-numeraire-value-1e18-scale.md sha256=003ac9236c24c088cf4298e5af838f917c7efdc622a86a8b417151580ceaacf9 -->

## Thread — The rooted wire is the only reward-budget wire (PR #2669)

A mirror's remittance receiver now refuses every reward-budget payload older
than the rooted (d6) wire: the bare day list, the list with a receipt, and the
list with a stated split each revert with a named error before anything reaches
the platform, and the transport keeps the message for re-execution. No current
sender produces those shapes, and every chain running the transport-epoch slices
is a fresh deploy, so none is in flight anywhere. The owner chose to retire them
outright while the platform is pre-live (2026-10-22) rather than keep dormant
paths for a population that cannot exist.

Everything that existed only for those older deliveries is gone with them: the
canonical chain's split-attestation message and its fee quote (an arriving one
is now refused as an unknown message kind on the mirror), the flat-list day
writer, the flat-list proof for a delivery that holds no epoch, the
retrospective admission of an older delivery into the epoch ledger, and the
budget ingress for the flat-list wire. The receiver and the reward messenger
both move to generation 7. On a chain whose reward custody is activated, a rooted
delivery is attested by its own wire on arrival and opens a transport epoch;
before activation it is booked to the typed ledger from the split it carries.
Either way its days land one proven chunk at a time against the root: indexed
into its transport epoch when it holds one, or proven for the day-delivery gate
when it arrived before custody activation.
Compensation deliveries are unaffected.

The keeper's delivery-proof pass drops its flat route to match. It lists as work
only deliveries whose packet carries a stamped root, so a flat-list delivery is
never queued, and its only "already done" signal is a chunk already indexed. The
runbook, the keeper's README and coverage matrix, and the tokenomics spec now
describe the rooted routes only; the spec marks the old-wire bullets as
superseded, and the code-versus-docs audit records the owner decision behind the
spec change. Refs #2516, #1566.

_Committed 2026-10-23 01:03 UTC (03d5deb27)._
<!-- assembled-fragment: 2516-retire-pre-d6-budget-wire.md sha256=58c3b4684afc299bf7a83a3bc7a21bd0b7fdc3be70d0560e5c7acdbc46e6b90e -->

## Thread — a borrower's offset offer can be taken in the app (PR #2675)

A borrower who closes a loan early by posting an offset offer (preclose option 3) was told the loan closes once a borrower takes the offer. The app itself, though, refused to let anyone take it: every offer tied to a running loan, other than a position sale, was blocked at review. The connected app now gives an offset offer its own review. The taker's loan is an ordinary new loan on the offer's own terms, and the usual receipt describes it. The review and the receipt also state what else the same transaction does: it pays off and closes the poster's earlier loan from the poster's own wallet, the taker owes nothing toward that loan, and if the close-out cannot complete the whole acceptance is refused and nothing moves.

Signing waits until every condition that close-out needs is read live and is clear. The earlier loan must still be active. A loan started now on the offer's terms must still end by the earlier loan's due date. No swap-to-repay order may be waiting on the earlier loan. The poster's standing approval and wallet balance must both cover the most the close-out can pull, the same bound the poster's own offset card watches. Each failed condition is named in plain words, an unanswered check pauses signing with a retry, and the submission re-reads every condition before any signature or approval. All nine translated languages carry the new messages.

Two related corrections came out of review. The app now tells a position sale from an offset by which side of the book the offer sits on, the same split the protocol makes, rather than by who created it; before, a borrower who also held the lender position of the same loan would have had an offset treated as a sale and asked to sign terms the protocol rejects. And every acceptance review that is re-read at submission (a refinance, a position sale, an offset) now treats a failed re-read as unknown: the review switches to its check-failed state with a retry instead of leaving the earlier clear answer on screen and signable. A position-sale review whose background refresh failed was also still signable; it now pauses like the others.

Closes #2523. The connected-app spec used to exclude accepting an offset by intent; that exclusion is reversed by owner decision (the approved issue plan) and recorded in the code-versus-docs audit. A new end-to-end scenario drives the whole option-3 outcome with three wallets.

_Committed 2026-10-23 03:32 UTC (ac2f952ae)._
<!-- assembled-fragment: 2523-offset-accept-review.md sha256=6fd2435cfc297175412cbb267eb06a3313911360e909a2ab8f762270b873ae0e -->

## Keeper — the flash-loan discount path is armed by one setting the keeper actually reads (#2633)

The keeper's discounted liquidation path was meant to be switched on per chain by a line such as `DISCOUNT_PATH_ENABLED_84532=true` in the keeper's environment. The keeper never saw that line. Its settings are passed to every pass through one resolver, which carries only the settings it names, and the per-chain switch was looked up by a name built at run time that the resolver did not carry. So the path stayed off on every chain whatever the operator set, and nothing said so. Two reward passes read their tuning knobs the same untyped way; those knobs happened to be carried, so they worked, but by luck rather than by construction.

The switch is now one named setting, `DISCOUNT_PATH_CHAIN_IDS`, a comma-separated list of the chain ids to arm. It ships empty, so nothing changes on any chain. The machine keeper states how it read the setting once at every start, from the same parser the passes use: which chains are armed, and for each one whether the running build has a route there (it needs both a FlashLoanLiquidator and a flash-loan provider), read from the same table the path itself reads. It claims nothing more: whether the keeper serves a chain at all stays the existing per-tick chain line, and the Diamond's own switch is still read per loan. When it considers the path for a loan and the chain is not armed, it also logs why: the setting is unset, it does not name that chain, or it could not be read (a malformed entry is described by its position and never echoed). Every setting the keeper reads is now looked up by its declared name, and a test checks that every declared setting reaches the passes, so a setting can no longer be dropped silently. The old per-chain gas-headroom override, which was never carried either, is gone; the headroom is a fixed figure until it is sized properly.

The path still does nothing anywhere today: it also needs a deployed FlashLoanLiquidator, and no chain has one. Its debt and gas sizing are placeholders, recorded in #2697, and arming it must wait for that. The rollout, incident, machine and restore runbooks now describe the real setting, say that the old line does nothing, and include it in the restore's disarm-and-capture lists.

Closes #2633. Follow-up: #2697.

_Committed 2026-10-23 16:34 UTC (89f06c8e6)._
<!-- assembled-fragment: 2633-discount-path-setting.md sha256=9737256e4233780dbfdf1f36936281afb1ca1a9889c5c4ddce68e08e7ce1d35d -->

## Thread — Health warnings start fresh for a withdrawn loan's number (PR #2655)

When the indexer finds that a loan it published never existed on chain (say,
its opening was undone by a chain reorganisation), it withdraws the record and
clears its own memory of the alerts sent for that loan number. The keeper keeps
a separate memory of which health-factor band it last warned each loan about,
in its own database, which the indexer cannot reach. That memory was only ever
cleared for loans that had ended, so a withdrawn loan's entry stayed forever.
If the chain then gave the same loan number to a real loan, owned by the same
wallet and sitting in the same health band, the keeper treated it as nothing
new and the owner's first warning never went out.

The keeper now also clears its memory of any loan number the indexer has
withdrawn under the current deployment, but only what it remembered before the
withdrawal. Anything it learned afterwards is about the real loan and is kept,
so that loan's warnings follow their normal rules and are never repeated on
every check. A warning the keeper was about to post for a loan that the
indexer withdraws in the same moment is no longer posted after the withdrawal,
so it cannot bring back an alert for a loan that never existed or take the
place of the real loan's first warning that day. A withdrawal recorded under an earlier deployment of the
contracts is ignored. The health-factor check also now hands the database
each list of loans as a single value, so a busy check covering thousands of
loans can no longer run past the database's limit on values per request and
stop sending warnings. Closes #2638.

_Committed 2026-10-23 02:59 UTC (78bac5164)._
<!-- assembled-fragment: 2638-hf-band-state-withdrawn-loans.md sha256=89f68d656cb4045725d51385e2148256727cb3791831e5a6f3a36003788cf98a -->

## Thread — The Activity page shows a repaired loan's ending (PR #2701)

When the indexer misses a loan's ending event for good, its reconciliation pass reads the loan's status from the chain and closes the loan's record. Since #2195 the indexer serves what that check observed beside the activity feed, but the app ignored it, so such a loan's history on the Activity page simply stopped, with no ending.

The Activity page now asks for those entries and shows each one for the wallet's own loans as an observation, not an event. It says the chain showed the loan repaid, defaulted, settled or closed by internal matching by a given block, and that when and how it ended was not recorded. It offers no transaction link and names no one who acted, because neither was seen, and the only time it shows is the time of the checked block. The entry sits in the feed in that block's order and opens the loan's page.

When the indexer cannot say whether any such entries exist, because the read failed or the answer was not in a shape the app recognises, the page now says a loan's ending may be missing instead of presenting the history as complete. A single malformed entry counts as not knowing, since keeping the rest would present a partial record as the whole one. Closes #2643.

_Committed 2026-10-23 11:40 UTC (7c896f701)._
<!-- assembled-fragment: 2643-activity-repaired-loan-endings.md sha256=34d7706f84ebce1e0e0dc559566ff82b029f5c2f70a9f118e2ed4779408d18f1 -->

## Keeper machine — builds no longer starve the keeper (PR #2691)

The keeper's late-acknowledgement pass missed its read deadline on about one tick in twenty. Most misses fell on all three chains in the same tick, and the next tick always caught up. The machine's own logs gave the cause: 60 of the 63 failing ticks in one day ran while the machine was building a new keeper release. The machine is small (about 1 GB of memory), and it rebuilt the keeper after every merge to the main branch, about 32 times a day, whether or not the merge touched the keeper. During a build, ticks started several seconds late and 37% of them missed the deadline. Outside a build the miss rate was 0.2%. No RPC provider was at fault.

Two changes keep builds out of the keeper's way. First, a build is now given only the files it needs: the keeper, the shared packages it depends on, and the root manifests and lockfile. The machine compares that exact source between the running release and the new commit. If they are byte-identical, a build would make the same bundle, so the machine stays on the release it has and logs that once. Most merges that touch only the app, the indexer, the contracts or the docs are skipped this way. The comparison checks what the build actually receives instead of guessing which changes might matter, so it cannot skip a commit that would build differently. A file the build needs but the list leaves out makes the build fail loudly, and a test checks the list against what the keeper bundle really reads. As a result, the release the keeper reports can be older than the main branch. Second, the updater and its build now run at the lowest CPU and disk priority, so the keeper always comes first.

Nothing here moves funds or changes what the keeper does on chain. The deploy model and its trust statement are unchanged: the machine still builds the commit it deploys, from its own checkout. Closes #2651.

_Committed 2026-10-23 08:04 UTC (97c428036)._
<!-- assembled-fragment: 2651-keeper-builds-out-of-the-way.md sha256=999e9025354183e8266ff25a28c5a64e7a72b4128fafa8595f5e28c5bcd63bc1 -->

## Keeper machine: the keeper's memory is protected from the rest of the machine (#2651 follow-up)

The keeper machine has about 1 GB of memory. Readings taken after #2691
showed the kernel pushing the keeper itself into swap: 112 MiB of it at one
point, rising by about 70 MiB in a minute. Every swapped page a tick touches
has to be read back from disk while that tick waits.

The keeper now runs in a slice of its own with a memory protection of 320 MiB.
That figure is its measured footprint, about 140 MiB resident plus 110 MiB
swapped, with room to grow. Up to that amount, the kernel reclaims the
keeper's memory only once there is nothing unprotected left to reclaim, so a
build, an updater run or anything else on the machine is swapped out first.
The protection reserves nothing: memory the keeper is not using stays
available to everything else. If the machine still runs out of memory, the
kernel's out-of-memory killer now picks a build before the keeper, and the
next deploy run retries the build.

Two things are stated rather than implied:

- **The build gets no memory cap.** A cap would have to be sized from the
  build's peak memory. systemd's logged peak for the build unit reads 256K to
  1.8M for builds that use nearly two CPU-minutes, which is not a real figure.
  Protecting the keeper does not depend on knowing the build's size.
- **The low disk priority #2691 gave the build has no effect on this
  machine.** Its disk scheduler is `none`, which ignores I/O priority. The
  setting is kept for hosts whose scheduler honours it, and the runbook now
  says so. The low CPU priority does take effect.

The deploy updater now also re-installs the running release's units whenever
any installed unit or script differs from that release's. That is how the new
slice reaches the machine at the run after this change deploys, instead of
waiting for the next build.

_Committed 2026-10-23 09:31 UTC (2faf2ab22)._
<!-- assembled-fragment: 2651-keeper-memory-protection.md sha256=da97e12b484510d7c7f6b749da33b7b1c351a8bb6f5366f716cbee23c5fe92ac -->

## Thread — Activity names every event filed under a loan or offer (PR #2702)

The indexer now files every event that names a loan or an offer under it (#1794), read from the contract interface by one rule. A wallet's Activity page lists events for the wallet's loans, so about forty-five kinds of event that used to arrive with no loan attached now reach it: a lender selling a loan, collateral added or withdrawn, liquidations and their steps, failed collateral sales and what followed, fees recorded against a loan, keeper and auto-extension settings, rental access updates and others. The app had no name for them, so each showed a name generated from the contract's event, in English, in every language.

Each of those kinds now has a plain-language name in all ten app languages and a deliberate place in the row order. None is hidden: each is something that happened on the chain to the wallet's loan or offer. Record-keeping and companion events (a status change, a fee record, a swap route tried) never name a row when their transaction did something more meaningful, and are counted in that row's "more in this transaction" instead; an outcome such as a liquidation or a claim names the row over the steps inside it. The one event that concerns a share held back while a wallet is flagged uses the in-app wording only.

A failed collateral sale is named by what happened: "Collateral sale failed" for a liquidation, with "no price available" added when the split could not be priced, and "Settlement pending after a failed sale" for a default. The event that records a loan's VPFI entering or leaving the discount-tier exclusion is named for the update, not one direction, since the same event records both. Clearing the opt-out from automatic grace-period listing is named by the resulting setting ("Automatic grace-period listing on"), because the event also fires when the setting was already on. A transaction whose only sign of the outcome is the loan reaching an end state, such as the last daily rental deduction that completes a rental's repayment, is now named by that end state ("Loan repaid") instead of by the deduction.

Thirty Korean Activity names that still read in English (loan repaid, offer created and others) are now translated.

Events that reach the page only because the wallet's address appears in their details are not covered yet: about two hundred kinds, mostly administrative, can do so, and which of them a wallet's page should show is an open question (#2703).

The test that guards this no longer keeps its own list of event kinds, which had fallen forty-odd kinds behind the indexer's rule. To make that hold without a second copy of the rule, the indexer's filing rule itself (which loan and offer an event concerns, and which wallet it is filed under) moved into the shared library that both the indexer and the app use. The indexer files rows by it exactly as before, and the app's test reads the same rule, so an event the indexer starts filing later, by a loan, an offer or a wallet, fails the app's tests until it has a name. Closes #2658.

_Committed 2026-10-23 12:45 UTC (6581a661c)._
<!-- assembled-fragment: 2658-activity-labels-for-filed-events.md sha256=5ef2282e8be36c3e2d28be1d2a74fd44262bd77915ed0ef47ab33709414fb1a7 -->

## Push readiness covers both senders (PR #2682)

The app asks the agent whether Push can be sent before it offers the Push opt-in. Until now the agent could answer only for its own rail, the one that sends payment reminders. The risky-loan warnings come from the keeper, which signs with its own copy of the key on the keeper machine. So the Alerts card had to say its check covered payment reminders only, and suggest keeping another channel on for the warnings.

Each time its health-factor watcher runs, the keeper now writes one row to the shared database: whether its rail can send, and on which channel or why not. The row carries nothing about the key itself. The agent reads that row alongside its own rail and answers for the whole service:
- Push is available only when both rails can send on the same channel, because a user subscribes to one channel.
- If either rail is down, the answer names which rail and gives the reason.
- If the two rails post as different channels, the answer says so as a channel mismatch.

The app already drops its reminders-only caveat for a whole-service answer. A new Push opt-in is judged against the same answer.

The keeper's row is trusted for 15 minutes. If it is missing, unreadable or older than that, the agent knows nothing about the keeper's rail. It then answers for its own rail alone, scoped to it, which keeps the app's caveat, rather than borrowing its own answer for the keeper. A new shared table, `push_rail_status`, holds the row. It is additive, carries no chain id, and is cleared before a restore replay like other republished state. Closes #2667.

_Committed 2026-10-23 04:27 UTC (915e38542)._
<!-- assembled-fragment: 2667-push-status-both-senders.md sha256=13c7b949c4b4650b94e0e5a442da5d68f343539173f8d39fb30f79609e3a5d75 -->

## Keeper — settled remittance alerts close again (PR #2678)

The keeper's late-acknowledgement pass could not find its own "undelivered remittance" ops alerts on the live database, so it never closed one whose remittance had since settled. Those alerts stayed open and kept repeating on their schedule. The pass looked them up with a SQL text pattern that includes the Diamond address. That made the pattern about 76 bytes long, and Cloudflare D1 refuses any such pattern over 50 bytes. The keeper machine's log showed the refusal on nearly every tick since at least 00:43 UTC on 2026-10-23. The pass itself kept running and new alerts still went out.

Every pass now finds its open alerts by a literal key prefix instead of a pattern. A literal prefix has no length limit and no wildcard characters. Where a pass needs only one chain's alerts, it narrows the result by the chain named in each key, which is how the families are already keyed. The keeper's test database now refuses an over-long pattern the same way D1 does. This class of bug used to pass every test while failing every run on D1; now it fails in tests too. Nothing in this path moves funds. Closes #2677.

_Committed 2026-10-23 03:41 UTC (5049e19b9)._
<!-- assembled-fragment: 2677-ops-alert-prefix-lookup.md sha256=80753b3ce75c0bb966dc15ee69a8346fdb57cd32a7a5ea68dee2ca7680cf5588 -->

## Thread — The connected app can be installed to a home screen (PR #2700)

The connected app now carries a web app manifest, so a phone browser offers to add it to the home screen and a desktop browser offers to install it. The installed app uses the Vaipakam name, colour and icons, and its long-press shortcuts open the Offer Book, My positions, the VPFI page and the alert settings. The only manifest that existed before was a leftover on the marketing site from the retired app, whose shortcuts landed on marketing pages and included a purchase route that no longer exists; that file was removed in an earlier change.

A production build also registers a small service worker, and it is deliberately narrow. It keeps a copy of this build's own static files (the scripts, styles, icons and logo the build produced) so repeat visits load faster, and it refreshes each copy from the network as it serves it. It answers nothing else. Page loads always come from the network, even when the network is down, because a stored page would run an old build with that build's contract addresses and interfaces at a time when the app cannot know they are out of date. Chain reads, the indexer, the agent, quotes and wallet services are never touched by it, so no balance, position or price is ever served from a cache. Each build keeps its files under its own name and removes earlier builds' copies when it takes over.

The worker registers only in production builds, does nothing on browsers that lack service workers, and is off in the automated test build so tests cannot leak cached files into one another. A new read-only live drive checks the deployed app for all of this after each deploy. Closes #2687.

_Committed 2026-10-23 11:03 UTC (353d1376e)._
<!-- assembled-fragment: 2687-installable-app.md sha256=34e30915631c3e9347c0f7d9266828946065fcb5a448fffdce580db7c1f6b755 -->

## Thread — A wallet's Activity page shows the events it took part in, by one rule (PR #2708)

A wallet's Activity page used to keep an event when the wallet's address appeared anywhere in its details. That let about two hundred kinds of event onto the page with no name of their own, most of them administrative: a role grant, a treasury setting, an operator being approved. It also offered no way to say which events a wallet's page was meant to show.

The page now keeps an event when it concerns one of the wallet's loans, as before, or when the wallet is one of the event's participants. A participant is the wallet that acted in the event, or a wallet the event names as affected: a counterparty, a buyer, or the owner of a setting, a lending intent, a vault, a perk or a reward. Assets, contracts, the treasury, and addresses an event only approves or permits are never participants. Administrative and treasury records, accounting between deployments, a service operator's own accounting, and sanctions screening records are not shown on a wallet's page. Each of those groups is written down with its reason.

The rule lives in the shared library beside the rule the history service already uses to file each event's wallet, so the two cannot drift apart. Its test checks every address in every event the platform emits. Each one has to be a participant, never a participant, or part of an event recorded as not shown with its reason. A new kind of event that names a wallet therefore fails the test until someone decides whether it belongs on the page.

Thirty kinds the rule admits now have a plain-language name in all ten app languages. They cover a wallet's own settings and consents, lending intents, vault creation and token recovery, terms acceptance, perks, reward claim windows and expiry, and reward delivery. The funds consequences for a flagged wallet (rewards set aside or forfeited, and set-aside rewards becoming claimable) use the in-app flagged wording only, with no list or provider named.

The history service no longer files two events under the protocol's sale executor contract: a settled collateral sale, and a sold offer whose creator could not be looked up. Both are still filed under their loan or offer. A wallet's first offer is named by the offer, not by the vault created inside it, and a reward share set aside for a flagged wallet is named as set aside, not as delivered.

One gap remains and is tracked as #2707. Risk-access consents that are recorded against a wallet's vault, not the wallet itself, are not shown yet. They never reached the page before either. Closes #2703.

_Committed 2026-10-23 14:28 UTC (85a2155ed)._
<!-- assembled-fragment: 2703-activity-participants-rule.md sha256=309500080ff7a0c109c018ea4f4c582d543a4794734ce3c0ed6b308eb048578e -->

## Thread — The connected app refuses inline and evaluated script (PR #2694)

The connected app's content security policy used to allow any inline script and the evaluation of text as code. Both settings were copied from the retired app on a note about wallet software needing them, and nobody had checked that note. Together they meant that a script injected into the page would have run with the app's full authority, which includes building the transactions a wallet is asked to sign.

Both allowances are gone. The policy now allows script from the app's own address, plus three small boot scripts that must run before anything else loads (theme, language and direction, and the start-up failure notice). Each boot script is allowed by a fingerprint of its exact content. The build computes those fingerprints from the page it has just produced, so the policy always matches what ships, and the build fails rather than ship an incomplete policy.

Before the change we measured the effect. No part of the app's code evaluates text as code. A local copy served by the same static-asset server the app runs on, under the new policy, loaded seventeen pages and the wallet picker with no refusals. That included the Coinbase Wallet and WalletConnect flows. A deliberately broken policy was refused as expected, which confirms the check can catch a refusal.

Inline styles are still allowed, because the interface sets them per element and they cannot run code. The marketing site's policy is handled separately. Part of #43.

_Committed 2026-10-23 10:00 UTC (64a5a0e47)._
<!-- assembled-fragment: 43-app-script-policy.md sha256=87b3c5ef24b5193932e3ba7fd41055a84117ca6147be0d50661f36d7b4eff68b -->

## Thread — The NFT verifier gives visitors something a copy cannot fake (PR #2698)

Position NFTs carry real claim rights, so a buyer might check one on the NFT verifier before paying for it. A copied verifier could show any verdict it liked. It could also add a "connect your wallet to confirm" step that drains the visitor's wallet. Nothing stops a web page from being copied, so the real verifier now tells visitors what they can check for themselves, without trusting whichever page they are on.

The verifier page now says, permanently, that checking a token never needs a wallet, a signature or an approval. It also says that any "verifier" asking for one of those is not Vaipakam's. The page shows the full contract address it checked against, linked to the network's block explorer, and explains that this address is what makes a token a Vaipakam position, while a token's name and picture can be copied by anyone. Every verdict, whether "live" or "does not exist", now links to the same token on the block explorer as an independent cross-check.

The Help page lists the Vaipakam contract address for every supported network. It also has a new answer on how to spot a fake verifier or a fake position NFT. The verifier's search listing no longer calls it a "rental" verifier, and the Help answer about the verifier no longer claims it shows loan terms, which it does not.

These changes cover the in-app half of the issue. The operational half stays open: watching for clone domains, reporting them to wallet blocklists, marketplace collection verification, and content-addressed hosting. Part of #745.

_Committed 2026-10-23 10:35 UTC (3aa45d3e8)._
<!-- assembled-fragment: 745-verifier-clone-resistance.md sha256=1c6e8effe677e8e098dd348a2000c65f5a33915015e3354bdeb020294dbffd65 -->

## Thread — Live handover check and bot-role rotation (PR #2660)

The governance handover is now proven against the deployed chain. A new
read-only phase, `handover-gate`, in both the mainnet and testnet deploy
ceremonies, rebuilds the complete list of accounts holding every role on
the Diamond and on the Timelock from the chain's own role events since the
deployment block, confirms each one directly, and fails on any holder the
governance plan does not name. The Diamond's role registry cannot list its
members, so asking "does the deploy key still hold this role?" could never
find a third key holding it; reading the history can. The check refuses a
history it cannot prove complete. It also checks the Diamond owner, that
every role is administered by the role root, the Timelock's delay, floor,
proposer, canceller and executor, every cross-chain contract's owner and
pending owner (the Chainlink token pool by its ownership events, since its
pending owner is private), each guardian, and the VPFI Cross-Chain Token
administrator. On a production chain anything it cannot check fails; on a
testnet it is reported as not checked. The old exit gate,
`DeployerZeroRolesTest`, built its own throwaway Diamond and never read the
chain, so it passed whatever the chain held; it stays as a unit check of
the model only.

The handover itself now finishes the job. Before, the keeper, watcher and
notification-biller roles stayed on the deploy key "until the bot keys are
set up", a step nothing ever ran, so the deploy key kept those powers for
good. The handover now grants them to the keys in `KEEPER_ADDRESS`,
`WATCHER_ADDRESS` and `NOTIF_BILLER_ADDRESS` (the zero address leaves one
unheld on purpose) and the deploy key renounces every role it held. All
three variables are required, a bot key may not be the admin, either Safe,
the Timelock or the Diamond, and the handover script and the live check
read one shared plan so they cannot drift apart.

Closes #944 and #669. Nothing was run on any chain: this is tooling for the
next fresh deploy, tested on local Diamonds only.

_Committed 2026-10-23 02:53 UTC (16990c296)._
<!-- assembled-fragment: 944-live-handover-gate.md sha256=25f40888425f2ac443a5b22acfb271ddeb025270b1896b987635b2a4ad1187b0 -->

## Governance — a new Diamond stays paused until a launch step proves it is ready (PR #2686)

The deploy used to unpause the Diamond at the end of its contracts phase.
That opened offers and accepts to the public before the later phases had
wired a price feed, set a sanctions screen or registered a swap route, so a
chain could be live with every wallet reading as unsanctioned and no way to
liquidate. The deploy now leaves the Diamond paused on every chain, and the
first unpause belongs to a new launch step.

The launch step reads six requirements off the live chain and prints each
as met, not met, or not checked: a treasury is set, a sanctions oracle
contract is set, the declared WETH is configured and priced, at least one
enabled swap adapter exists, VPFI is routed through the declared
cross-chain pool, and that pool carries exactly the declared lanes, each
reaching exactly the remote token and the one remote pool the other
chain's deployment records (a lane whose remote pool was removed, or that
points at the wrong token, is refused even with its rate limits in place).
On a mirror chain the VPFI token's own mint authority must also be that
routed pool, and the token must be owned by governance. A
requirement the chain cannot answer is never read as met. On a production
chain every requirement must be met and the governance handover must be
complete, and the step broadcasts nothing: it prints the Timelock proposal
for the governance Safe, so the first unpause waits out the same 48-hour
window as any governance action (owner decision 2026-10-23).

The proposal is not a bare unpause. It is one call to a new launch
function on the Diamond, which first asks a new stateless launch-gate
contract to read every requirement again, and unpauses only if the gate
agrees, in the same transaction. The gate also checks that the deploy key
still holds no role, that the Diamond is still owned by the Timelock the
Safe reviewed, and that no role has changed hands since the handover check
proved who holds each one. The Diamond's role holders cannot be listed
on-chain, so the Diamond now keeps a count of every change to its role
table; the handover check prints that count when it passes, the proposal
carries it, and the launch refuses if the count has moved. So if a
requirement stopped holding during the 48-hour wait (a swap route was
removed, the sanctions oracle was cleared, the deploy key was given a role
back, or another queued operation gave an administrator role to someone
new), the execution fails and the Diamond stays paused. A moved role count
needs the handover check run again and a fresh proposal. The launch must
also be the Timelock's next action: the Timelock now counts every call it
executes, the handover check prints that count beside the role count, the
proposal carries the count the check proved, and the launch refuses if any
other governance action ran after that check (a facet change, a pool
ownership transfer, a rate-governor upgrade, anything). The proposal itself
refuses to be printed once the count has moved, because an action executed
between the check and the proposal is one the check never saw; the
handover check is then run again. The Timelock also refuses to start one
governance action while another is still running, so no action can run
the launch from inside itself before it has been counted. Everything the
launch depends on is governed by the Timelock, and not every effect of a
governance action can be read back on-chain, so this binds the launch to
exactly the state the Safe reviewed. Other queued operations are run or
cancelled first, then the launch is proposed.
The unpause is
also tied to the pause count at the time of the proposal: if the Guardian
pauses or the watcher auto-pauses during the wait, the launch can no longer
execute, so a launch decided before an incident never lifts the incident's
pause. A fresh proposal is needed once the incident is closed. The gate has
no owner and sits at an address fixed by its own code, so reviewers can
check exactly what the proposal calls; the contracts phase deploys it. The
Diamond accepts only a gate call about itself, so a gate's answer about a
different Diamond cannot launch it.

No requirement is met just because an address has code. The sanctions
oracle must answer a sanctions lookup (the Diamond treats a failing lookup
as "not sanctioned", so a wrong contract would screen nobody), the price
requirement asks the platform's own price oracle to price ETH right then,
under the same rules every other flow uses (so a missing, malformed, stale
or distrusted price does not count), and a swap route counts only when the adapter
is enabled and answers as an adapter. The cross-chain lane check reads the
VPFI pool from Chainlink's token registry for the token the Diamond itself
records, rather than trusting a pool address from the deploy files. A production launch also
refuses while the deploy key still holds any Diamond role, not only the
unpause role.
A Diamond is recorded as launched only on evidence, the Diamond's own
record of its first unpause (described below), and on a production chain
that record must name the Timelock and this checkout's launch gate. A
Timelock operation that only unpauses leaves no gate on the record, so it is
refused rather than counted as a launch that no readiness check vouched for,
and so is an unpause through any other contract that merely answers the
gate's call, since nothing shows what it checked. Any other unpause makes the launch step
refuse instead of recording it, and the deploy scripts record the launch
from that same evidence rather than from whether the Diamond happens to be
unpaused. Once a Diamond has launched, the launch step never offers to
unpause it again: a later pause is an incident and is lifted through
incident response. The readiness
report printed by the verify phases now reaches the same verdict the
launch would, handover included: they load the same recorded handover
proof the launch step binds. On
a testnet no answered requirement may be unmet and the admin unpauses
directly. A local development chain only warns. The deploy scripts' verify
phases print the same report, and fail if a Diamond was unpaused outside
the launch step. They also end with the launch verdict in words, so a
"verify OK" never reads as "ready to launch": verify runs before the
handover, when a production launch still refuses by design, so that verdict
is stated rather than turned into a failure. After a launch, the scripts say
whether the Diamond is paused now: one launched and then paused for an
incident is reported as launched and paused, never as live.

The Diamond now records its own launch: the first time its birth pause is
lifted, it stores who lifted it and when, and never changes that record
again. The launch step reads whether a Diamond has launched from that
record. Before, it rebuilt the Timelock operation it expected, which a later
build of the launch gate, a different registry or admin address, or a
Pauser repeatedly re-pausing to inflate the pause count could all hide; a
launched Diamond under an incident pause could then have been offered a
second launch. On a production chain the record must name the Timelock, so
a Diamond first unpaused by anyone else is refused and named. A testnet
Diamond paused again before it ever went live no longer needs the operator
to confirm it never launched: the record says so.

The launch checks the chain against what the launch DECLARES, not against
itself. The lane list is the same per-chain list the cross-chain wiring
phase uses, and the pool must carry exactly those lanes: a missing lane
would leave a destination unreachable, and an extra one is a route nobody
reviewed. The pool Chainlink's registry routes VPFI through must be the pool
the deploy recorded, the one the handover check proved is owned by the
Timelock; the handover check itself now also fails when the registry routes
VPFI through any other pool, or when that pool's rate limits can be set by
anyone but the bounded rate governor. The launch-gate contract re-reads that
authority when the Timelock executes the launch: the token's registry
administrator, the pool's owner and the rate governor's owner must all still
be the Timelock, with no transfer pending where one can be seen, and the
pool's rate-limit admin must still be the governor, so a change queued in the
same 48-hour wait cannot hand the route to someone who could lift its limits.
(A Chainlink pool keeps a started ownership transfer private, so the gate
cannot see one; the handover check reads it from the pool's events.) The
configured WETH must be a token
contract with 18 decimals, because the price oracle prices whatever address
is stored as WETH from the ETH feed. Nothing on-chain records which token is
a chain's bridged WETH, so the Timelock proposal prints the WETH (with the
registry, pool and lanes) for the governance Safe to check against the
chain's official bridge registry, and the on-chain re-check refuses any
other value than the one signed. A deployment built without the VPFI token
that declares no pool or lane reports both cross-chain requirements as met
because they do not apply, and says so, so a testnet deployed that way can
still launch.

The cross-chain readiness check now reads every lane of the VPFI pool, not
just whether one exists. Each lane's inbound and outbound rate limits must
be enabled and inside the bounds the rate governor enforces. A lane wired
without its limits (for example when the limits transaction failed after
the lane was added) carries no cap at all, so it refuses the launch, and the
Timelock's launch also fails if a limit is switched off during the wait.

Because the Diamond now stays paused until launch, the two risk settings
(per-asset risk parameters and the loan-admission health-factor floor) no
longer refuse while paused (owner decision 2026-10-23). Without that, a chain
could not set its risk limits before going live. They still need the risk
admin role, which the Timelock holds after the handover, so every change keeps
its governance delay.

The testnet configure phase now also sets the admin's test sanctions list as
the Diamond's oracle (#946), so a testnet launch passes the sanctions check.

The launch report and the verify verdict count the admin key only when the
admin's private key is actually supplied, as the launch itself does, so they
never predict an admin unpause the launch could not make.
On mainnet the sanctions source is still waiting on the #2443 adder-host
decision, so a mainnet launch refuses until that is settled, by design.

The launch checks do not cover per-asset risk parameters, and the launch
step now says so on every run. No deploy phase sets them and there is no
declared list of collateral assets to check, so a chain can pass every check
while each ERC-20 collateral still has a zero loan-to-value cap, which
refuses every liquid loan (loans against illiquid assets and NFTs are
unaffected). Until asset onboarding is designed (#2696, owner decision
2026-10-23), governance sets those parameters through Timelock proposals
before scheduling the launch.

Closes #945. Closes #946.

_Committed 2026-10-23 23:07 UTC (3f7c502da)._
<!-- assembled-fragment: 945-946-launch-readiness.md sha256=e162914e6d00e4af4b8ee35fceb6171242ac589adbfbbf3694c9d28293144aca -->

## Thread — Treasury reserve routing and flash-loan profit measured per run (PR #2679)

The productive treasury reserve now refuses any venue it has no route for.
Before, routing a deployment or a withdrawal was an open chain of cases with
no final refusal, so a venue value added to the setter later without a route
would have moved the books (principal recorded as deployed, an event saying
so) while the tokens never left the Diamond. Both directions now end in an
explicit refusal, which unwinds the bookkeeping with it. Closes #964.

Aave supplies and withdrawals are now measured rather than assumed. A supply
must take exactly the amount supplied from the Diamond's own balance. A
withdrawal must be reported by the pool as the amount requested, and the
treasury is credited with what actually arrived, never the request: for a
token that charges on transfer, crediting the request would have recorded a
treasury balance with nothing behind it, later paid out of other funds the
Diamond holds. A new withdrawal event states both the requested and the
received amount, so any shortfall is visible rather than silent. Setting the
Aave pool now also checks that the pool's own Aave addresses provider names
it back. That is a guard against a mistyped address or a contract that is not
an Aave pool; it is not proof a market is genuine, which remains the job of
the governance timelock's review window. The two Aave pool interface copies
in the codebase are merged into one, and an unused Lido interface is removed.
Closes #965.

The flash-loan liquidation receiver now judges each run on its own. It keeps
earned profit between runs until the owner sweeps it, and its safety check
used to compare against its whole balance, so a swap that lost money could
pass by spending that kept profit and still report a positive net profit. The
check and the reported net profit are now measured from what the receiver
held when the run began: the run must at least cover its own flash-loan fee,
and collateral left from an earlier run is neither counted as seized nor
offered to the swap. Closes #961.

_Committed 2026-10-23 04:44 UTC (172cacee7)._
<!-- assembled-fragment: 964-965-961-treasury-yield-and-flash-profit.md sha256=bfc120c98d7721db0515e4c53d4370f6e9ee08ee3da368098f83a6061aeaab16 -->
