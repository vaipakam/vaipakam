# Release Notes — 2026-11-10

The day's contract work hardens timing and claims. Every action that is exposed to a price now carries a required deadline, and an offer can be filled only once its terms have stood unchanged for a few seconds, so a fill cannot land on terms changed in the same moment (#3412, #3443). A maker can put a price-move guard on an offer, and the keeper keeps the hourly price checkpoints those guards read (#3358). A position NFT cannot move for a short cooldown after value has left it (#3413). Reward claims now do a bounded amount of work and read a bounded part of a large wallet per call, so no wallet becomes too large to claim (#1787). A vault now decides where value may go from addresses fixed in its own code, not from registry or platform settings (#3431, Stage B1 of #3379).

The rest of the day covers:
- **Rewards and VPFI:** every Base loan carries the fee-linked reward cap; one chain's absurd daily report can no longer stop the day; the tier rules are readable on-chain with a per-user explanation; buyback orders keep the top-up room their floors need.
- **Operations:** on production chains a price-setting change now waits at least seven days; the keeper pause now stops every keeper; the keeper records daily market-cap rankings used for asset trust tiers, and reads its secrets through the shared reader.
- **The new app (alpha05):** the rate desk (markets, a market's rate ladder, your offers, loans and history), a Rewards page with your VPFI and tier, renting (take a request, close a rental), secondary signers on the Protection page, guards on every address that receives funds, the grace-period countdown, and a reason for every reverted transaction.

## Thread — Reward claims read a bounded part of a large wallet (PR #3487)

The first half of #1787 made every claim do a bounded amount of settlement work, but each claim still read every unsettled reward entry the wallet held, at about 18 thousand gas per entry. A wallet past roughly 500 unsettled entries therefore still could not claim in one transaction. Entries can also be moved onto a wallet by others, because a position NFT can be transferred to it, so the wallet's owner does not control that number.

Each claim now reads at most 128 of the wallet's entries, its claim window. A wallet with no more than that is read whole, as before. A larger wallet is served over several claims: after each claim the settled entries in the window leave the wallet's list, and the window moves on to the next part, returning to the start after the last one. Every entry is reached within a bounded number of claims, and nothing is lost by waiting. A claim domain that is already open continues on every claim, whichever part the window holds.

The window moves on after every claim rather than waiting for its part to be fully settled. An entry that stays open for a long time therefore cannot hold the window, and entries moved onto a wallet cannot keep the owner's other entries from being reached.

An entry outside the window is not the next claim's, so its expiry clock does not run while it waits. Whenever the entries a wallet's window holds change, no claimable time from before the change counts toward any of that wallet's entries expiring, so an entry that left the window and came back is never brought closer to expiry by time it spent outside. A large wallet's entries may therefore take longer to reach expiry; they never reach it sooner than the stated horizon and notice. A new view, the reward claim window, reports which part of the wallet's entries the next claim covers and how many there are in total, so the app can say that a claim covers only part of a large wallet. Both apps now say so. Where the part a claim would read has nothing to pay, the claim still runs and its only effect is to move on to the next part, so the apps offer it described as exactly that rather than hiding it, since hiding it would leave the rest of the wallet's entries out of reach.

Closes #1787.

_Committed 2026-11-10 10:48 UTC (9c12d9dd9)._
<!-- assembled-fragment: 1787-claim-window.md sha256=f314d45a6ec0602650aabef8acaa5db049460f83223c3245466daf1fe1bc8359 -->

## Thread — Reward claims do bounded work per call (PR #3473)

A reward claim used to bound its walk by days alone, at most thirty finalized days per call, while the cost of a day grows with the number of the wallet's entries on it. Measured on the previous code, one claim cost 28.4 million gas for 40 loans over a month, 27.3 million for 200 loans on a single day, and 20.4 million just to prepare a 40-day backlog of 10 loans. All of these are above the 16.8 million gas a single transaction may use on Ethereum. The next claim faced the same work, so the wallet's rewards stayed locked. This needed no attacker: an ordinary user with about twenty loans who skipped a month was enough.

Every claim, and every step that settles a long backlog (a claim domain's preparation and its reservation, revalidation, resolution and unwind pages), now charges its work to one meter and stops when the next step does not fit. Progress is kept, and the next call continues from there. The meter charges each day for its fixed cost plus each entry it settles, with an entry's first day in a transaction costed as cold storage. Its figures are a deliberate over-estimate of the measured costs, and it never reads the remaining gas, so the same state splits the same way whatever gas limit a transaction carries and a simulation agrees with the claim it previews. With the meter, the heaviest shapes above each run in under 10 million gas per call.

A day with more of the wallet's entries than one call can settle is paid over successive calls, its leading entries first. The wallet's total for the day is unchanged, because its per-day ceiling binds the same sum. How that total splits between its loans now follows the order they were settled in. A claim domain takes at most 32 entries into its snapshot, so every day of it fits one call in every step that walks it. Entries beyond that wait for the next domain, as entries accruing after a domain opens already did. The expiry clock does not run for an entry the next claim would not reach, including an entry left outside a domain's snapshot while that domain stands. The claim preview counts only what the next claim would pay, so it never shows more than the claim delivers. Both read one shared model of the next claim's work. Because a claim walks the lender side before the borrower side on the same meter, the preview counts a borrower day only where it can tell the lender side's walk ends first; otherwise it says that a day is left uncounted.

This advances #1787. Each claim still reads every unsettled entry the wallet holds once (about 18 thousand gas each), so a wallet past roughly 500 unsettled entries is still too large for one claim. A bound on how many entries one claim reads, the second half of the fix, follows in its own change.

> Caveat: a wallet with more than about 500 unsettled reward entries still cannot claim until the claim list bound lands.

_Committed 2026-11-10 06:57 UTC (90bc61ad5)._
<!-- assembled-fragment: 1787-claim-work-meter.md sha256=dc0b0f26b24666d794c341077fd9084fc6e551fde0f53df33c14aa152cf2c8a4 -->

## Rewards mesh — one chain's absurd report can no longer stop the day (PR #3471)

Every chain's daily report carries two recycled figures: its lifetime total and the credit it names for the closing day. The canonical chain caps a day's accepted credit at whatever that lifetime total has not yet attributed. That cap is only as strong as the lifetime total, and the total comes from the reporting chain itself. A faulty or compromised chain that reported a near-maximum total together with a near-maximum day credit therefore had the whole day credit accepted. The day's finalization then overflowed while summing the credit of the chains it counts, and stopped. That left the day unfinalized for every chain, not just the one that misreported.

A day's attribution now has a protocol ceiling that no chain's own figures can raise: one chain's accepted credit for one day never exceeds the VPFI hard supply cap (every VPFI that can ever exist). It applies whether or not the canonical chain has set a tighter per-chain ceiling, and a per-chain ceiling above it is refused. No honest day comes near it. Anything a day names above the ceiling joins that chain's backlog and is attributed on later days, the same as anything a per-chain ceiling trims, so nothing is lost.

The supply cap is now stated once, in the token's interface. The token and the reward mesh both read it from there, and the token's code is unchanged.

The lifetime total still ratchets to whatever a chain reports. That figure measures availability, and funding is already re-bounded against it, so a huge total does not stop the day.

Closes #2045

_Committed 2026-11-10 00:13 UTC (3b739e0fb)._
<!-- assembled-fragment: 2045-day-attribution-protocol-ceiling.md sha256=87ae6cbeac2d1c71dac440af0bbf43b950c2b153c69d3ae801b3e45a4ab249b3 -->

## Thread — alpha05 guards every address that receives funds, and adds payout destinations (PR #3494)

Address poisoning works because people compare only the first and last few characters of an address. An attacker makes an address whose start and end match one the user already uses, plants it in their history with a worthless transfer, and waits for them to copy the wrong one. The new app now has one address box for anything that receives funds or control. It always shows the address in full, refuses a broken checksum, and refuses, with no override, an address whose first three and last three characters match one the user already uses while the rest differs. An address the user has not used before needs an explicit "I checked the full address" tick. The Keepers settings already use this box.

The new Protection page keeps the user's saved addresses for each network and wallet. The list lives in this browser only, and the page says so. A wallet joins only after it proves control: the page makes a link the user opens in the wallet that holds the address, that wallet signs a request naming the account, the address and the network (signing moves nothing and costs nothing), and the code it shows is pasted back and checked by its signature. An exchange deposit address cannot sign, so it joins unverified under the exchange's name, and only after the user acknowledges three risks: a wrong address loses what is sent, the exchange may not credit a deposit from the vault, and the exchange may reassign the address.

With protected mode on, the page shows the account's payout destinations and the requests still waiting, with when each becomes usable, by when it must be applied, and when it lapses, by the chain's clock. A destination is chosen only from the saved addresses. Asking to add one, cancelling a request, making a matured one active and removing one each open their own review, which states the address in full, its saved name, the timing and, for a removal, the payouts it cancels. The outcome is measured from the transaction's own events. With protected mode off, the page says destinations do not apply. The Vault page's safety card now links to the page.

Secondary signers, name-service names, flags on unknown senders, test payouts and the remaining parts of the address guard come in a later slice.

Advances #3415 and #3180.

_Committed 2026-11-10 13:14 UTC (b91a22317)._
<!-- assembled-fragment: 3180-alpha05-address-guard.md sha256=98248a7f198666c4a310601ddcc21a675e918026f5c696ae68d591cc7cb05808 -->

## Thread — alpha05 shows an amount's value now (PR #3477)

The new app's borrow and lend forms now show, under each typed amount, what
the protocol values it at right now, in the protocol's own numeraire. The
figure comes from the protocol's own valuation, by the same rule it uses for
loan-to-value: a principal is rounded up, collateral rounded down. It is read
once typing pauses, not on every keystroke.

The line never shows a figure the protocol would not stand behind. For an
asset the protocol gives no price, it says the protocol values it at nothing.
When the protocol's price sources disagree, it says that is why no value is
shown. A value that could not be read is said to be unread, not shown as zero.

The take-an-offer review, for a borrower and for a lender, now states the
principal's and the collateral's value now in the same words. These rows are
informational and never binding, since the price moves after signing.

The line is one shared component, so later routes (Vault, Claims) can carry
it with the same rule and wording.

Closes #3225. Advances #3180.

_Committed 2026-11-10 04:18 UTC (286e895b0)._
<!-- assembled-fragment: 3180-alpha05-amount-value.md sha256=d55eb06f83c9a63ec2cafd9688078ff9c12d509c07e20d626ddcde438d85d43e -->

## Thread — alpha05: trust tiers and token search in the pair picker (PR #3492)

Part of #3446.

When you choose a token to borrow or lend in the new app, it now shows where that token ranks by market value, from two public lists of tokens. The match is by the token's contract address on the network, never by its name, since anyone can name a token anything. A blue chip is in the top 20 and is priced by the protocol; then come the top 100, 200, 300 and 500.

A token outside the top 500 carries a warning that it is used at your own risk. A token that shares a ranked token's name or symbol at another address is labelled a possible copy and shows the real token's address, and when the two lists disagree on where a token lives, it is shown as unverified with both addresses. Test tokens and test networks say so.

Each tier shows the date of the list it came from, and a refresh that failed is stated, so an old list never reads as current. The tier is a guide only: what the protocol does with a token is unchanged and still shown beside it.

The "another token" field now also searches by name or symbol. Ranked tokens come first, each with its tier and full address, and picking one fills in the address.

_Committed 2026-11-10 11:35 UTC (a0ddb0fa3)._
<!-- assembled-fragment: 3180-alpha05-asset-trust.md sha256=d3161d3a13ed852434b0c8b19edbf747320d6daeacc0c4b77b38d6c457f8964e -->

## Thread — alpha05: Borrow names both ways up front and lists offers as a rate ladder (PR #3485)

Once a borrower picks what to borrow and what to lock, the Borrow page in the new app (`apps/alpha05`) now names the two ways to borrow before anything else: borrow now, by taking a lender's open offer whole, or set your own rate, by posting a request and waiting for a lender. Each way has one sentence, so a reader new to on-chain lending no longer has to discover the second way below the list.

The open offers now read as a ladder grouped by rate, lowest first. Each step says how many offers it holds and the amount of each one. The amounts are never added up, because one borrow takes one offer whole, so a total would be an amount nobody can borrow.

A borrower can type the highest rate they will accept, and in Advanced the highest loan-to-value. These only narrow the list: the page says how many offers each limit hid, an unreadable limit applies none and says so, and an offer whose loan-to-value the protocol does not report as a figure is kept and counted rather than hidden on a guess. An offer is still taken at its own terms, which the review shows before signing.

The way to set your own rate, and the request form, now state the lenders standing ready for the pair, read from the protocol's own list of active, funded lender intents: how many there are, the most any one of them can lend now, and the lowest rate any of them accepts. It always adds that a matching service fills a request against them only when its terms fit a lender's limits, so a fill is likely but neither instant nor guaranteed. That claim is made only while the protocol is not paused, the network's matching switch and standing-intent switch are both on and its keepers are running: with the protocol paused, the page says no request is posted or filled against these lenders until it resumes; with either switch off, it says no request is filled against them now; with every keeper paused, it says the matching service fills none until they resume, though a lender can still fill from its own standing offer and anyone can for a lender that has not limited who fills it; and with any of these unread it says that is not known. While the network's aggregator lenders are paused, the intents they own are left out of the figures, since the protocol refuses a fill against them. The list and the switches are read at one block, and a failed re-read keeps the last answer while saying it may have changed. The borrower's own standing intents are never counted, since the protocol refuses a match with oneself, and a lender that lets only fillers it has chosen fill against it is stated apart, without the likely fill, because whether the matching service is one of those fillers is not known. The page also states the terms every standing lender requires, the full term's interest, no partial repayment and no interest schedule, and in the request form a choice that rules them all out, such as an interest schedule, is stated in place of the likely fill.

Closes #3319.

_Committed 2026-11-10 08:53 UTC (6ed43c693)._
<!-- assembled-fragment: 3180-alpha05-borrow-ways.md sha256=f1f4973907c1f869f9e253756a6ba46eba8bb02546e8cac6bd92e89c1c77d057 -->

## Thread — alpha05 rate desk: your live loans in a market and your desk history

Below a market's activity, the new app's rate desk now shows the connected wallet's live loans in that market. They come from the app's own reading of the wallet's positions on the chain, the same one the Positions page uses, not from the index. Each loan says which side the wallet holds, the amount and rate, and its health factor, or that there is no health reading. Each links to the loan's page, where the protocol decides what can be done. If the positions were not read in full, the desk says a loan may be missing.

Below that, the desk lists the wallet's desk history from the protocol's index: every token loan against token collateral it has held a side of, at any status, newest first, twenty at a time. The index keeps an append-only record of who held each side, so a loan the wallet lent, was repaid on and collected from still appears after its position is gone. Each row shows the market by the term agreed when the loan opened (an extension does not move it, and a term the index cannot confirm is stated as not confirmed), the side held, the status on record and when the wallet last took a side. The status is labelled as the index's record, which can trail the chain, and each row opens the loan's page, which reads the chain.

A "Show older loans" button appears only when the index actually returned a loan beyond the current page, so a list that ends exactly on a page boundary does not offer an empty page. A row the app cannot read is counted rather than silently dropped, and a failed read is stated instead of showing an empty history.

The order ticket and signed orders follow in later slices. Advances #3180.

_Committed 2026-11-10 23:47 UTC (e0f312daa)._
<!-- assembled-fragment: 3180-alpha05-desk-history.md sha256=21fa67f2d3f979381352e653b67485eb654372bb68c78518473d3bce4ee788a6 -->

## Thread — alpha05 rate desk: the markets and a market's rate ladder

The new app's rate desk, an Advanced page, now shows the open token loan book as markets and ladders. A market is one lending token against one collateral token for one term. The list comes from the protocol's index and states each side's count and best rate, says when the index listed only its deepest markets, and counts rows it could not read. Like the offer book, nothing is read before a wallet connects on a served network.

Choosing a market opens its rate ladder: lenders' offers from the lowest rate up and borrowers' requests from the highest rate down, each at the rate it binds when the other side takes it. Each rate step says how many offers stand there and their open amounts added up, and says plainly that this total is depth, not one amount: every offer is still taken on its own. The middle rate is worked out from the best two rates and labelled as such, a crossed ladder is stated, and every offer links to its own page, which reads it from the chain before anything is offered. Offers nobody can take at that market (expired, sale or early-close vehicles, offers bound to a moved loan position, fully filled ones, other terms) are left out and counted by reason.

One note above every view says what the desk cannot yet show: the index counts gasless signed orders in each market, but the desk does not list them yet, so a ladder can list fewer offers than its market counts, and the ladder then says both numbers. A failed read is stated, never shown as an empty desk.

A Basic-mode reader who reaches an Advanced page by its address now sees an orientation card on top: what the page is, the guided pages that do the same job (Borrow and Lend for the desk), and a switch to Advanced. It is never shown in Advanced mode and hides for good once dismissed.

The order ticket, signed orders, open orders, the fills tape and chart, and the desk's positions and history follow in later slices. Advances #3180.

> Caveat: signed orders are counted in the market list but not listed on the ladder until the signed-order slice lands.

_Committed 2026-11-10 20:10 UTC (b8cee11e8)._
<!-- assembled-fragment: 3180-alpha05-desk-markets.md sha256=32322c0474723e21b8c72d710fbbedd384aa2b931fccfe9330e69bb3bfdc8da3 -->

## Thread — alpha05 rate desk: your open offers, recent loans and the agreed-rate chart

Below a market's rate ladder, the new app's rate desk now shows three more views, all read from the protocol's index. First, the connected wallet's own offers on that ladder: how much of each was taken against the most it can lend or borrow, and how much is still open, as the index last recorded it. Each links to its own page, which reads the offer from the chain.

Second, the market's recent loans, newest first, with the last loan's rate and how long ago it was agreed on top. Each line shows the rate and amount set when the loan opened. Later repayments or extensions do not change it, and the bookkeeping loan a lender's sale opens is left out. An amount the index cannot confirm is shown as not confirmed. When the market holds no loan the page says so, and when it holds more than the newest twenty it says that too.

Third, a chart of the rates loans were agreed at over the last 7, 30 or 90 days or all time. Each period with a loan shows its last agreed rate as a step and its lowest and highest rate as a shaded bar. Periods with no loan stay gaps: the line is never drawn across them. The ladder's middle rate is a labelled dashed reference, and no change figure is shown. Hover or keyboard focus shows a period's figures, and the same figures are in a table under the chart. The chosen period is kept in the page address.

A loan is placed in a market only when the index can confirm its agreed term. The loans on a token pair that it cannot place are counted beside both views rather than guessed into a term. A failed read is stated, never shown as an empty list or chart.

The order ticket, signed orders and the desk's positions and history follow in later slices. Advances #3180.

_Committed 2026-11-10 22:09 UTC (231a42abb)._
<!-- assembled-fragment: 3180-alpha05-desk-tape.md sha256=cb6767daea171f8add1a5c4d3b5ca888c75d9b981fafce2c2d8f5ab69c8596f1 -->

## Thread — alpha05: repaying in grace counts down to the end and says to send early (PR #3490)

When a borrower repays a loan that is past its due date and in its grace period, the repayment review in the new app (`apps/alpha05`) now counts down to the end of grace. It says that after the end the protocol refuses a repayment and anyone can file a default, and that whichever transaction is mined first wins, so the repayment should be sent well before then. Paying part of a loan shows the same clock.

The countdown runs on the chain's clock, not the reader's: the block time the review read plus the time since. With an hour or less left it says to send now, because a repayment still waiting to be mined when grace ends is refused with nothing moved. If the clock passes the end while the review is open, it says grace has ended and that a protocol pause would move the end later, which the re-read before sending checks. The clock only states; the protocol's own check, read again before sending, is what refuses a late repayment.

The threat model now records block-stuffing near a grace end, to hold a repayment back until a default lands, as an accepted low risk: grace periods are days long, and the app tells the borrower to send early.

Part of #3412. The contract half of #3412, a deadline on every price-exposed action, is separate work.

_Committed 2026-11-10 10:31 UTC (497e34246)._
<!-- assembled-fragment: 3180-alpha05-grace-clock.md sha256=baedf2572372dd061da68cdd5e34475a3cd7566b86cd34e73b3466aa557eedc8 -->

## Thread — alpha05 can put a price-move guard on an offer as it is posted

A creator could already put a price-move guard on an offer from its page, but only after posting, so the offer sat on the book unguarded until that change landed. In Advanced mode the offer form of the new app now has a price-move guard option for an offer of one token against another. With a limit between 0.5% and 50%, the guard and the offer are sent as one transaction, so the offer is guarded from the moment it is on the book, and if either part fails, nothing is posted.

The review is the protocol's own dry run of exactly that transaction. Because that dry run cannot reach the guard while a token approval is still owed, the review also reads both tokens' prices on its own: a pair the protocol cannot price is named before signing, with the remedy of posting without a guard. The receipt states the limit, what the guard refuses and that no one can fill the offer until hourly price checks cover the pair. The finish card reads the guard from the transaction's own event for the offer it created.

The guard reaches the test networks with the next fresh deploy.

Advances #3358 and #3180.

_Committed 2026-11-10 18:03 UTC (110e89439)._
<!-- assembled-fragment: 3180-alpha05-guard-at-post.md sha256=5f1f2490ed250b341068a034f77774f7031e8977d49971341e98833bd79b53f7 -->

## Thread — alpha05 shows and sets the price-move guard on an offer's page

The protocol now lets an offer's creator put a price-move guard on a loan offer of one token against another: once set, nobody can fill the offer while either token's price has moved more than the chosen limit since the guard was set, in either direction, or while the pair has not been calm against its last two hourly price checks. The new app's offer page now shows that guard to everyone who opens it, with its limit, when it was set, and whether the guard would refuse a fill right now and why, so a taker learns about a refusal before signing rather than at it.

The creator of an open offer can set the guard between 0.5% and 50%, change it, or remove it. Each change opens its own review, read at one block and dry-run against the protocol before signing. The review says what the guard does, that the prices are recorded at the change, that it only refuses fills and moves nothing, and whether the offer has a guard right now, so the creator knows a fill can still happen until the change lands. The finish card reads the change from the transaction's own event.

The guard reaches the test networks with the next fresh deploy. Until then the creator is told that this network's protocol has no guard yet, and nobody else sees a section. Arming a guard while posting an offer comes in a later slice.

Advances #3358 and #3180.

_Committed 2026-11-10 16:35 UTC (3ec012c96)._
<!-- assembled-fragment: 3180-alpha05-offer-price-guard.md sha256=aed494ec6fcbf4e142353eba50592704edbb0b7429f75c71e5708a32409a6592 -->

## Thread — alpha05: Positions adds up a wallet's live loans in one card (PR #3488)

In the new app (`apps/alpha05`), Positions now opens with one card that adds up the wallet's live loans whenever it holds two or more, so a borrower or lender with several loans sees the whole picture before the list. With one loan the card is not shown, since that loan's row already says all of it, and the side choice (all, lent, borrowed) narrows the card with the lists.

For each side the card states the principal still owed or still out, per token. Amounts in different tokens are never added together; comparing them at today's prices stays with the exposure line, which says what it cannot price. NFT rentals have no token amount, so they are counted rather than totalled.

It then names the next date something falls due, with a link to that loan: a final repayment, an interest checkpoint, or a rental's close, which is never called a repayment because a rental closes on its prepaid rent. Below it, as warnings, it lists the loans that need the reader now, each linked: grace period over, past due in the grace period, and in fallback. A loan in more than one stage is named once, under the more severe one. Loans whose dates could not be read are counted, because the next date may be one of theirs.

Interest is not in the totals, and the card says so: each loan's page states what repaying it costs now. The card reads only what the list reads, shows nothing until that read answers, and says when the walk was partial. It manages no loan; every loan stays its own position and its own row.

Closes #3320.

_Committed 2026-11-10 09:34 UTC (6504a9904)._
<!-- assembled-fragment: 3180-alpha05-positions-summary.md sha256=7cb65c1a9030d201d5313a4008a470a97d7c7775948846c35f3b9b8a39682ee4 -->

## Thread — alpha05 can close a rental (PR #3472)

A renter can now close a running rental in the new app. The rental's own
page offers "Close the rental" to whoever holds the renter position, in
place of the repayment a loan offers; until now it pointed to the current
app. Anyone else reading a rental is told the three ways it ends: the
renter closes it, it closes by itself once every agreed day is settled, or
it ends as a default.

Closing pays the rent owed and any late fee out of the rent and buffer the
renter prepaid into their own vault, so nothing is taken from the wallet and
no approval is asked. The review states the rent owed if the close lands now
and at a moment a short while ahead, counted by the protocol's own rule
(which the protocol publishes no figure for, so the review names the rule),
the days already settled, the late fee as the protocol quotes it, what comes
back to the renter as a claim, and what the owner receives (the rent and
late fee less the protocol's share). It says plainly that the later
moment is no deadline or limit, because the close is counted when it lands.
A prepayment that cannot cover the close is refused before the wallet
opens. Past the grace period the close is refused, and the review says the
rental then ends by its remaining days being settled or by a default,
whichever comes first.

The close is one wallet prompt, sent only after a dry run. Afterwards the
app checks on the chain that the rental closed, the claim recorded for the
renter (inside the range the review stated) and, from the close's own
log, that the renter's use of this rental was revoked.

Starting a rental, from a listing or a request, now checks the renter's use
from that transaction's own log too, instead of the owner's vault totals,
which other rentals of the same token can move in the same block.

The rental's pause wording is corrected too: a pause moves only the
late-fee and default dates and stops daily settling; the renter's use still
ends on the date set at the start.

Advances #3180.

_Committed 2026-11-10 02:02 UTC (053c93175)._
<!-- assembled-fragment: 3180-alpha05-rent-close.md sha256=8870327281120762dd3e368e29709adcff3214632ff8e865ad386f01415939dc -->

## Thread — alpha05 can take a renter's request (PR #3470)

An owner can now take a renter's request to rent an NFT in the new app. The
request's own page names it a renter's request and offers "Rent out your
NFT"; until now it pointed to the current app.

The review states that the NFT moves from the owner's wallet into the
owner's own vault and stays there until the rental ends, who the renter is
and that the renter becomes the NFT's user at once, the term counted from
now, the rent rule, the rent and buffer the renter already put in the
renter's own vault (with the buffer share the request fixed), what the
owner receives (the rent, less the protocol's share, which this start
fixes, paid into the owner's vault as each finished day is settled, with
the rest at close) and what a default does. Every rental term in the new
app now reads as days of use: a pause moves only the late-fee and default
dates, never the end of the renter's use. A token the wallet does not hold, or too
few units, is said before any wallet step, and the review reads again on
its own once that changes.

The wallet signs the exact terms, lets the protocol move that one token
(for a multi-token collection, the whole collection for this rental only,
taken back afterwards whatever happens), and the rental is sent only after
a dry run with that signature passes. The outcome is measured from the
transaction and the owner's vault: the rental started, the NFT in the
owner's vault, and the vault naming the renter as its user, with a link to
the rental's page.

Advances #3180.

_Committed 2026-11-10 00:34 UTC (f79e16718)._
<!-- assembled-fragment: 3180-alpha05-rent-take.md sha256=70e4e20581737f37f6ff4d868e0eb245a25ccf8ee7080ad1c8fcb60027eb41ee -->

## Thread — alpha05: a reverted transaction says why, and every e2e test starts clean (PR #3483)

When a transaction the reader confirmed mines and reverts, the finish card in the new app (`apps/alpha05`) still says it changed nothing, and now adds why where the chain lets it be read. If the receipt spent the whole gas allowance, the card names that allowance and says the transaction most likely ran out of gas, since a refusal by the protocol returns the unused gas. Otherwise the app replays the same call on the state just before its block and states the protocol's refusal as the likely reason, because a transaction earlier in the same block can change that state, and the replay runs at the earlier block's time rather than its own, so an offer or deadline can run out in between. A replay that goes through says one of those two changed what the call relied on, without claiming which, and a replay that cannot run says so. The reason never changes the verdict.

The end-to-end suite had an intermittent failure on `main`. Several specs reverted the chain after a test without mining a block, so the next write was estimated against a head with a stale timestamp and, with interest accruing per second, could run out of gas. One such failed attempt had also minted tokens outside any snapshot, which a later spec then found in a wallet that should have been empty. Every test now runs inside one shared fixture that takes a snapshot first and, whatever the outcome, reverts it, mines a block and puts every stand-in service setting back (index posture, unplaced loans, added inbox rows, the alert service). The per-spec copies of that cleanup are gone, so no spec can forget part of it.

Closes #3482.

_Committed 2026-11-10 07:04 UTC (e022cdd47)._
<!-- assembled-fragment: 3180-alpha05-revert-cause.md sha256=148512c544d0e082ba7086bbeeb00382d83def15fb7cbcb112718933f69d093c -->

## Thread — alpha05 VPFI deposits can be signed instead of approved (PR #3474)

The VPFI deposit on the Rewards page can now be funded with a one-time
signature instead of a token approval. The review offers it only where
Permit2 is deployed and the wallet has already approved Permit2 for VPFI
elsewhere. The app never asks for that approval itself, because it is
open-ended and shared with other apps. The usual approval of exactly the
amount stays the default and is always available.

The signature covers exactly the amount, names the protocol as the only
spender, can be used once, and lapses after 30 minutes. Only a transaction
the wallet itself sends can use it. The receipt says all of this, and the
deposit is dry-run with the signature before it is sent. The result is
measured from the deposit's own event and the transfer into the vault, so
the VPFI counts toward the fee-discount tier exactly as on the approval
route.

Advances #3180.

_Committed 2026-11-10 03:10 UTC (a95ac3ef5)._
<!-- assembled-fragment: 3180-alpha05-rewards-sign.md sha256=be228e47f18c4fba32bece3f465867fc55804c9d888d46b856f07ac0e836ad46 -->

## Thread — alpha05 Rewards shows your fee-discount tier and the tier table (PR #3474)

The Rewards page now shows the fee-discount tier the protocol applies to the
wallet's fees, read from the protocol itself rather than worked out by the
app. While the fee-discount consent is off, it says no tier applies. On
VPFI's home network it also reads the tier the counted VPFI alone would
give, and says in one line when the holding rules keep the applied tier
below it. Away from the home network it shows the tier sent from there, or
says none applies.

The protocol does not report which holding rule holds a tier down, nor the
rules' settings, so the page names the three rules in its help without
claiming which one applies; issue #3459 asks for read views for both.

On the home network a table shows every tier: the counted VPFI it needs,
with the protocol's exact boundaries (the top tier starts just above its
figure), its discount after the 50% cap, and the loan initiation fee and
the fee on interest earned with that discount, computed exactly from the
network's live settings. Elsewhere the table is not shown, because tiers
are set on the home network.

Advances #3180.

_Committed 2026-11-10 03:10 UTC (a95ac3ef5)._
<!-- assembled-fragment: 3180-alpha05-rewards-tier.md sha256=b248117877cbaf487007754e7ef999b1562b0606974b2445b35c16258519be59 -->

## Thread — alpha05 has a Rewards page with your VPFI (PR #3474)

The new app now has its own Rewards page. It shows the wallet's rewards
through the same claim widget Home uses, the VPFI in the wallet's own vault,
and the fee-discount consent. Until now Rewards pointed to the current app.

On a network where no VPFI token is set, the page says so and offers no
deposit or withdrawal. Otherwise it reads, at one block, the VPFI in the
wallet, the VPFI counted in the vault (what the fee-discount tier reads), how
much of it is free to withdraw and how much is held, and any VPFI that sits in
the vault without being counted because it was sent there directly, with the
way to adopt it from the Vault page. VPFI in the vault is not collateral.

Depositing and withdrawing VPFI use the vault's own deposit and withdrawal for
this one token. They count VPFI for the tier exactly as the VPFI-only entries
do, and the withdrawal keeps the escape route open while the protocol is
paused. A deposit asks for the Terms first; a withdrawal never does. Each
receipt adds the tier's side: deposited VPFI counts toward the tier under the
holding rules and pledges nothing; a withdrawal works the tier out again from
what stays counted, and taking the counted VPFI to zero restarts the holding
time. Both say whether the fee-discount consent is on. The outcome is measured
from the chain.

Only VPFI in the vault on VPFI's home network sets the tier; other networks
apply a copy of the tier worked out there. On those networks the page says so,
and each receipt says the move changes no tier instead of describing a tier
effect.

Nothing on the page buys, sells, prices or stakes VPFI.

Advances #3180.

_Committed 2026-11-10 03:10 UTC (a95ac3ef5)._
<!-- assembled-fragment: 3180-alpha05-rewards.md sha256=256f28ddf87c956b6fccd7c4ecbe2e9e18331bb63154b58a7f792d6c62b2a4cb -->

## Thread — alpha05 manages secondary signers on the Protection page

A secondary signer is another wallet the user holds, such as a hardware wallet, that guards a protected account. It can cancel a waiting change, lock the account, cancel or co-sign a queued payout, remove a destination and, with the other signers, approve replacing the main wallet. It can never move anything out of the vault, open a position, or add a destination or signer. The new app's Protection page now lists the account's signers and the wallets asked to become one, with each one's acceptance and timing by the chain's clock.

A signer is chosen only from the saved wallets that proved control by signing, never an exchange address. Asking a wallet changes nothing at first: the page shows a link the asked wallet opens to accept from its own key. That page names the account in full and offers to accept only to the asked wallet, on the right network, while the request waits. Once the delay has passed and the wallet has accepted, the request is made active within one further delay, or it lapses and must be cancelled before asking again. Removing a signer also waits the delay and can be cancelled by another signer. The user can also require a signer's co-sign on every payout: switching it on is immediate, switching it off waits the delay, and removing the last signer switches it off too, which the review says.

Each change opens its own review, which states the signer in full, what a signer can and cannot do, and the timing, and its outcome is measured from the transaction's own events. Wallets asked to become a signer now also count as known addresses, so a look-alike of one is refused in every address box.

Name-service names, flags on unknown senders, test payouts, the incoming-payment fallback and withdrawing to a saved destination come in a later slice.

Advances #3415 and #3180.

_Committed 2026-11-10 14:57 UTC (49c4b9707)._
<!-- assembled-fragment: 3180-alpha05-signers.md sha256=d977a29d95f8fbf1b3a2ae08f25e8b5ac717c4693dbfc9a37c63eaaffc15d042 -->

## Thread — alpha05 says which holding rule holds a fee-discount tier down

The Rewards page of the new app already said when the holding rules kept a wallet's fee-discount tier below what its counted VPFI alone would give, but not which rule, because the protocol did not report it. The protocol now explains a tier rule by rule, and the card names the rule from that explanation: no holding recorded yet, a holding younger than the minimum holding period (with the moment that period ends), a weighted average in a lower tier, or a dip to a lower tier during the look-back over the current holding. The explanation is read at the same block as the tier the fees use, and only used when it resolves that same tier; otherwise the card says why could not be read and names no rule.

While the fee-discount consent is off, the card now also says which tier would apply with it on. In Advanced mode the card lists each rule's figure for the wallet (the counted VPFI and its tier, when the current holding began, the end of the minimum holding period, the weighted average and its tier, the lowest tier in the look-back) and this network's settings for the rules, with the average's window and the look-back stated as two separate lengths.

The explanation reaches the test networks with the next fresh deploy; until then the card there states the tier and says why could not be read.

Advances #3459 and #3180.

_Committed 2026-11-10 18:54 UTC (f049b2f4c)._
<!-- assembled-fragment: 3180-alpha05-tier-explanation.md sha256=8448fcea2c1d270674e77034beee4df9611f46dd09e049982427145410ec1701 -->

## Thread — alpha05 keeps a connected session's console clean (PR #3481)

With a wallet connected, the new app's console filled with refused requests to an outside Ethereum mainnet endpoint. The wallet picker's connected surfaces (its button, its account page and its avatar) each looked up a name-service name for the address on Ethereum mainnet. Because the app serves no mainnet, they read it from a public endpoint the page never names, and that endpoint refuses the app's origin. One connected walk over the main pages made 167 such requests, and every report from the page's list of allowed destinations was one of them.

The wallet picker is now used only to connect. Once a wallet is connected, the address chip opens the app's own account panel. It shows the full address with a copy action, the network, a switch to each other network the app serves, and disconnect. The app shows the address itself and reads nothing on Ethereum mainnet.

The live-update channel no longer logs a failed connection when the page stops needing it while it is still opening. It now waits for the connection to open and then closes it.

A new live driver walks the main pages with a watch-only wallet connected, on desktop and phone, and fails on any console error or warning from the app, any report against the allowed-destination list, or any failed request. The deployment review the rulebook requires is now taken connected.

Closes #3476. Advances #3180.

_Committed 2026-11-10 05:31 UTC (cd46e3ab5)._
<!-- assembled-fragment: 3180-alpha05-wallet-console.md sha256=63358027754e8cf79b1ea4ebab40251ddf5b21814e9e7ad6c9ec63a6eba03732 -->

## Thread — Price settings wait as long as vault code changes (PR #3484)

On a production chain, a change to a price setting now waits at least seven days, not one. This covers the price guard's own settings (feeds, WETH, secondary sources, tolerances) and the feed registry the guard reads its Chainlink feeds from. The default delay for both is now seven days, up from three. The ceiling stays at fourteen days, and a testnet may still use no delay.

Why: every vault holds the price guard's address in its own code, and the guard decides what collateral is worth. A vault owner who pins their vault's code is protected from a code change for as long as the vault code delay lasts. A price-setting change can move value out of a vault just as surely, so it must stay visible for at least as long. The owner chose to match the vault code delay (seven days, #3421).

The feed registry gets the same floor because the guard prices through it. Without that, a feed change could take effect after one day, behind a guard that otherwise waits seven.

The guard and the feed registry cannot be upgraded, so this reaches a chain only through a fresh deploy. The testnets keep their zero delay.

> Caveat: the protocol registry's own minimum delay (which governs replacing the guard's address for the Diamond) is still three days. It follows the vault code delay, so it moves with #3421.

Advances #3272.

_Committed 2026-11-10 08:45 UTC (ad54fb9fe)._
<!-- assembled-fragment: 3272-price-guard-seven-day-floor.md sha256=9ca16428fdf39eb3b376e27309b1c2d9d87e4342f07bba76c1fdd1ad5d13d7f2 -->

## Keeper — hourly price checkpoints now cover guarded offers (PR #3501)

The maker's price-move guard (#3358) lets an offer refuse a fill unless both of its assets have an hourly price checkpoint for each of the last two hours. The keeper's price checkpoint pass wrote checkpoints only for the assets of active loans, so a guarded offer in a pair no loan used could never be filled, however calm the market. For the guard a missing checkpoint is not the safe direction it is for the forced-sale floor: it blocks the offer outright.

The pass now also records both assets of every open offer that carries a guard. The shared indexer names the open, unexpired offers whose two legs are ERC-20 (the only offers a guard can be set on), and the Diamond decides which of them carry a guard, read at the same block the run reads its checkpoints at. An offer whose guard was cleared, or whose guard row outlived the offer, is left out.

Each source of assets is read on its own. If the indexer cannot be read for loans, guarded offers are still worked, and the other way round, with the failure named in the run line. On a Diamond from before #3358 the pass says it carries no guard and still writes the loans' assets. The run line now also states how many open offers carry a guard.

Nothing else changes: the pass still sends only assets with no checkpoint for the hour and a price that reads, in the same bounded batches, and it still ships disarmed behind `PRICE_CHECKPOINT_ENABLED`. Advances #3358.

> Caveat: the guard and the pass reach the testnets only at the next all-waves fresh deploy; until the pass is armed there, a guarded offer in a pair nothing else checkpoints cannot be filled.

_Committed 2026-11-10 14:11 UTC (6ff9e6241)._
<!-- assembled-fragment: 3358-keeper-guarded-offer-checkpoints.md sha256=ff76d34bc7300707e84b27e8cefd9b50df91c20207d88a4bd65d971bf6369c27 -->

## Offers — the maker's price-move guard (PR #3496)

An offer waits on the book while the market moves, and a taker can fill it the moment the price has moved in the taker's favour, on terms the maker set against the old price. An offer's creator can now bound that with a price-move guard: a limit on how far the collateral-to-lending asset rate may move. A guarded offer refuses a fill when the rate has moved past the creator's limit since the guard was recorded, or when the pair is not calm against the last two hourly price checkpoints (the same calm rule the forced-sale floor uses, now one shared rule rather than a copy). A price that cannot be read, or a missing checkpoint, refuses the fill too. The guard is off by default, only ever refuses a fill, and moves no funds.

The creator can arm it before posting, in the same transaction as the post, so the offer is recorded with the prices at posting and is never on the book unguarded; or set, change or clear it on an open offer later, measured from the prices at that moment. The limit lies between 0.5% and 50%, and only an offer with two priceable ERC-20 legs can carry one.

Every fill checks it at the opening of the loan, so a direct accept, every match path (both makers' guards), intent fills and refinance, offset or sale acceptances are all covered. The two steps that fill an offer without opening a loan, a direct loan sale into a buyer's offer and an obligation handover onto an incoming borrower's offer, run the same check themselves. An unguarded fill pays nothing extra for the check. The accept, match and standing-intent previews report a guard refusal by name (the intent preview now also reports the borrower offer's cadence refusal, which it used to miss), and a new read-only view says, for any offer, its limit, the prices it was measured from, how far the rate has moved since and which condition holds.

Closes #3358.

> Caveat: a gasless signed offer cannot carry a guard until its signed terms can (#3327).
> Caveat: the guard reads the hourly checkpoints, whose keeper pass ships disarmed and today covers only the pairs of active loans; a guarded offer in a pair nothing checkpoints cannot be filled until that pass covers guarded offers too (follow-up for the keeper).
> Caveat: reaches a testnet only with the next fresh deploy (a new facet, plus loan creation, the offer book and the three previews).

_Committed 2026-11-10 13:34 UTC (5f01f2917)._
<!-- assembled-fragment: 3358-maker-price-move-guard.md sha256=5cf3644eab145eadb018ced7f139e55e855b49728215967674c56f09a9c00043 -->

## Thread — Every Base loan carries the fee-linked reward cap (PR #3514)

Each token loan on the canonical reward chain now records its lifetime
reward ceiling when it opens, whatever fee mode either party chose. Before
this change only a loan where someone opted into the Full tariff recorded
it, so an ordinary loan earned with no per-loan ceiling once the
fee-linked cap was armed, and only the per-wallet daily share bounded it.
Two wallets of one person could lend to each other and earn VPFI with no
per-loan limit tied to the fees they paid. The ceiling bounds that per
loan; it does not remove every margin, as the last paragraph states. Recording the ceiling charges nothing: a party who did
not choose Full still pays only the usual fee in the lending asset.

The launch gate gains a check. On the canonical reward chain the first
unpause is refused until the cap's first armed reward day has been set,
the reward clock has started, and that day has arrived, so no loan ever
earns under the older per-ETH cap. The arming setter takes only a future
day, so an operator arms the cap at least one reward day before the
launch. The check reads as not applicable on a mirror chain.

Mirror chains keep the old rule for now: their loans record the ceiling
only on a Full opt-in, because a mirror's claims are funded by Base
against a commitment made per entry, and trimming them would change what
crosses chains. The owner chose to build the same cap on mirrors, with
the VPFI a capped mirror claim does not pay sent back to Base, as its own
change before launch. Until then a mirror loan is bounded by the
per-wallet daily share.

The threat model records the residual: at the default settings the two
sides of one loan can together earn at most about 4.9 times the list
initiation fee per year of term, while the pair pays at least half that
fee plus gas.

Advances #3360.

> Caveat: the next fresh deploy of the canonical testnet must start the reward clock and arm the cap before its launch, or the launch refuses.
> Caveat: mirror-chain loans stay without a per-loan reward ceiling until the mirror half of #3360 ships.

_Committed 2026-11-10 22:16 UTC (64dd7804f)._
<!-- assembled-fragment: 3360-base-reward-cap-every-loan.md sha256=05164feb72e0f1e77169a475cc39c9a5af64935bcbc138c699a793403f95250e -->

## Thread — Every price-exposed action now carries a required deadline (#3412)

A transaction can wait in a public queue for a long time before it lands. When it finally does, the price or rate it commits to may no longer be what its sender wants. Every action that commits its caller to a price or a rate now takes a "valid until" time chosen by the caller, and is refused if it lands after it. The deadline is required: an action sent without one is refused too.

This covers posting an offer (with or without a Permit2 signature), changing an offer's amount, rate, collateral or terms, setting a lender intent, both swap-to-repay routes, a lender listing a loan for sale or selling it directly into a standing offer to buy, a borrower's offset offer, and a borrower handing an obligation to a standing borrower offer. Accepting an offer and a signed offer already carried a deadline. All of them share the one timing rule from part A, with the same two refusals: `DeadlinePassed` and `DeadlineRequired`.

The deadline belongs to the transaction, not to the offer. An offer's own expiry still says how long a posted offer lives; the new deadline only says how late the transaction that posts or changes it may land.

A lender's sale of a loan now always carries the figures the lender reviewed, the least the lender will net and the most the lender will pay toward a shortfall. The earlier unbound forms of the listed and direct sale are gone, and the bound forms took their plain names. In the app, the direct sale into a standing offer to buy now reads the chain's quote of those two figures when its review opens, shows them, and sends exactly them, as a listing already did; the sale is refused rather than made if either is worse when it runs.

Rescue actions are unchanged and take no deadline: repaying, a partial repayment, adding collateral, closing early by paying off, withdrawing surplus collateral and funding a lender intent. A late landing does them no harm.

The apps set every deadline 30 minutes past the chain's current time, the same window acceptances already use, and show the two refusals in plain words.

The app now also sends every protocol action with a gas limit 30% above the node's estimate, the margin the keeper, the test harness and the deploy scripts already use. An estimate is the least gas that works at the latest block's time, and an action mines a moment later; some price reads cost a little more by then, and an action sent at the bare estimate could run out of gas and fail with no reason. Unused gas is not charged.

> Caveat: this changes the call shape of thirteen actions, so it reaches the testnets at the next fresh deploy. The curated facet refresh refuses a Diamond built before it.

_Committed 2026-11-10 22:49 UTC (2d513f884)._
<!-- assembled-fragment: 3412-valid-until-entries.md sha256=30d8542d7778ccd307ce8288df1bebd212ef22b9328e8eaedb333a9c4a89037d -->

## Thread — Position NFTs cool down after value leaves them (PR #3478)

A position NFT can be sold on any marketplace, and its price depends on what the position holds when the buyer agrees to it. A seller could claim, withdraw collateral or change an offer's terms just before the buyer's order fills, and the buyer would receive a position worth less than they paid for.

Now every action that takes value out of a position stamps it: a payout to its holder (a claim, a held borrower extra, a lender's share of a repayment or a partial liquidation, a swap-to-repay surplus, an in-place extension's interest), a collateral withdrawal, a change to its terms, offers included, a loan drawing on an offer (a partial match as much as a full one; an accepted offer's token becomes the new loan's token, so that loan cools down from its start), and the end of a token (a cancel that refunds an offer's deposit, a final claim, or a side sold or handed over to a new holder, which retires the seller's token). Neither side's token may then move in that block, nor for a cooldown after it. The default is 5 seconds; the admin may set it from 1 second to 10 minutes. The position NFT's transfer check enforces it, so a sale that would land against an emptied position fails on every marketplace. Moves of positions that nothing touched are unaffected, and a loan's tokens follow that loan alone, not the offer it was matched from.

The cooldown and each token's earliest move time are public reads, so an app can say when a position may move again. The transfer count that protocol routes check is unchanged.

What does not stamp: a former seller collecting their share of a sold lender position, which the current holder does not control, and a sanctions-held park, which pays nobody.

App follow-up: the owner's plan also disables claim actions on positions the app has listed for sale, with the reason. That part ships separately in the app.

Closes #3413.

_Committed 2026-11-10 07:47 UTC (dc55bb069)._
<!-- assembled-fragment: 3413-position-transfer-cooldown.md sha256=bf54591dc6fef0c80b8c2b4436f349387062a5c51c298671c1daae3a0d37d44d -->

## Thread — vaults check outcomes, not identities (#3431, Stage B1 of #3379)

A vault no longer reads any registry or platform setting to decide where value may go. The treasury, the backstop vault, Seaport, the 1inch order protocol, the listing conduit and its key, and the price guard's address are fixed in the vault code when it is built. A treasury or backstop payout reaches only those, a listing approval only that conduit, and an order-taker approval only that order protocol. Changing any of them is new vault code, which waits the vault-code delay. The launch check now compares these with the platform's own settings and names any mismatch.

A vault now signs only orders it hashed itself. The platform hands the vault a listing's or a swap-to-repay order's terms, not a hash. The vault checks it is the seller or maker (or that the seller is its own listing escrow), checks the conduit key, and asks Seaport or the 1inch order protocol for the hash. Its contract signature then answers only that protocol, and the listing escrow answers only Seaport. Every teardown still withdraws the order.

A new `swapOut` lets a vault sell at most a stated amount through a swap adapter in one call and requires the recipient to receive at least a floor. The vault measures both balances around the call and closes the adapter's allowance before it returns. The plain transfer to a swap adapter is retired.

The listing conduit has one deploy input, its Seaport conduit key; the conduit address is resolved from it through Seaport's conduit controller, and the launch check refuses vault code whose key does not resolve to its conduit.

The backstop vault is now provisioned by the deploy itself, before the vault code, because the vault code fixes its address. The deploy records it as `backstopVault`. Design: `docs/DesignsAndPlans/VaultOutflowPolicyDesign.md` (Stage B1 build notes).

> Caveat: a listing's payment legs are not yet checked by the vault. They are bound to the owner's signed terms in Stage B3; until then the platform builds them and the marketplace zone checks them at fill.
> Caveat: until #3268, `swapOut`'s floor and its adapter are the platform's choice; the vault enforces the floor it is given but cannot judge that it is fair. Nothing calls `swapOut` yet, and a faulty platform module could already move value through the in-transaction pass a forced sale uses, so it adds no new exposure. From #3268 the vault checks the floor against the price guard itself, and the forced sale moves onto `swapOut`.
> Caveat: the price guard address is zero in the vault code until the price guard (#3447) is built by the deploy.

_Committed 2026-11-10 05:35 UTC (2fb5dacda)._
<!-- assembled-fragment: 3431-stage-b1-vault-outcome-checks.md sha256=d5d37ccfc64710ef2cb459b90ce02f18477a1cbc218fbc5666e35365f4e37c31 -->

## Thread — alpha05: how long a just-changed offer must wait before a fill

The protocol now takes an offer only once its terms have stood a few seconds (#3443, default five, set by the admin up to a minute). The new app already named this refusal; its review now gives the protocol's own figures instead of only "try again shortly": how long terms must stand, and how long was left at the block the review read. Both are read at one block, from the offer's terms time, the minimum age and the block's time.

No step to sign is shown while the refusal stands. The review reads the chain each block, so the refusal lifts by itself once the time is up. When those figures cannot be read, the review keeps the plain refusal, which says it lifts within seconds.

The rule reaches the testnets with the next fresh deploy; until then no live offer carries it.

_Committed 2026-11-10 21:01 UTC (9fafe9243)._
<!-- assembled-fragment: 3443-alpha05-terms-age-wait.md sha256=7f279a19c2949c70138ceaeb9c84e16978e43ac64a148cc25d91ae0d59a96aff -->

## Thread — Offers fill only once their terms have stood a few seconds (#3443, part of #3412)

An on-chain offer can now be accepted, matched or otherwise filled only once its terms have stood for a minimum age: 5 seconds by default, which an admin can change between 1 and 60 seconds. The age counts from when the offer was posted and starts again whenever its amount, rate or collateral is edited. The same applies to a lender intent, counted from when it was last set. This stops an offer from being posted, or re-priced, and taken in the same block. Doing that let one transaction fund both sides of a loan, farm rewards, or fake activity in the market-rate signal. The rule covers a direct accept, a match, an intent fill, a lender's direct sale into a standing offer to buy, and a borrower handing an obligation to a standing borrower offer. Previews report a fill refused for this reason as its own case, so an app can say the offer becomes available within seconds.

The age is measured in seconds, not blocks, because block times differ between chains. Its one-second floor still guarantees a later block on every chain. A signed offer has no on-chain posting time, so the rule does not apply to it. It stays bound by its own signature deadline and by the taker's signed acceptance terms.

The deadlines that already existed now share one rule and one refusal: the deadline on an acceptance, a signed offer's signature deadline, and a lender's bounded direct sale. A deadline that has passed reverts `DeadlinePassed`, and a missing required deadline reverts `DeadlineRequired`. This replaces four separate error names. Deadlines on the remaining price-exposed actions follow in the next part of #3412.

The keeper's fill of a signed offer against an on-chain offer (`matchSignedOffer`) moved to a facet of its own, `SignedOfferMatchFacet`, because the new checks took the matching facet over the contract size limit. The function, its event and its errors are unchanged for callers; only the code host moved.

> Caveat: this reaches the testnets at the next fresh deploy. The new fields are appended to the offer and the lender intent, and offers posted before it carry no age.

_Committed 2026-11-10 19:12 UTC (466832da8)._
<!-- assembled-fragment: 3443-offer-terms-age.md sha256=3c0a386756b65e047e21bf15b6fd6ad0691da335c06d525d7395389846a407fc -->

## Keeper — daily market-cap rankings for asset trust tiers (PR #3495)

The keeper has a new duty, the asset rankings pass. It keeps the rankings
behind the app's asset trust tiers fresh: blue chip, top 100, and so on down
to top 500, with an own-risk warning beyond. It advances #3446; the app side,
the shared tables and the read route are separate work.

Once a UTC day, for each of two public market-data sources and each mainnet
chain (Ethereum, Base, Arbitrum, Polygon, Optimism and BNB Chain), the pass
fetches the top 500 coins by market-cap rank. It then maps each coin to its
contract address on that chain. The rank is matched by address, never by name
or symbol, so a look-alike token never inherits a listed token's tier. Keeping
the two sources side by side lets the app show a disagreement instead of a tier.

A good fetch replaces that source's list for the chain and records the run in
one database step, so a reader never sees half a list. A failed fetch keeps the
last good list and records that the day failed and why, so the app can say how
old its list is. Two cases count as failures and are never written: a ranked
list shorter than 400 coins, and a chain that maps to no address at all. The
second means a wrong platform id or a changed response, not a chain without
tokens. A failed day is retried hourly.

The pass runs on the keeper machine, not in the agent Worker. The coin list is
about 4 MB, more than the agent's CPU allowance can parse. It reads both
sources without an API key and sends no transaction. It ships switched off
behind `ASSET_RANKINGS_ENABLED`; arming it is the owner's call.

> Caveat: both sources are used on their free, keyless tiers. If either starts
> refusing keyless calls, its rows go stale and each day's run records why.
> Adding a key is a follow-up.

_Committed 2026-11-10 12:05 UTC (85f6fb640)._
<!-- assembled-fragment: 3446-asset-rankings-pass.md sha256=45a6b3c5cde29dbedae837ccc204f10dfac7c2f42f91a9d985172763cdadfb80 -->

## Thread — indexer: a store and a read route for public token rankings (PR #3492)

The indexer now has a place to keep the public market-cap rankings of tokens, and a public read route that serves them. This is the first part of the asset trust tiers in #3446: the connected app will use the ranks to sort an unfamiliar token into a tier (blue chip, top 100 to top 500, unranked) and to warn when a token copies a ranked token's symbol.

The rankings are fetched once a day by a keeper pass on the keeper machine, which ships disarmed and is built separately. The app cannot fetch them itself, because the list keys must stay off the client and one fetch serves every user. Each run stores a source's whole list at once; a failed run records only that it failed and leaves the previous list in place.

The route `GET /assets/rankings?chainId=` takes the token's own chain, which is required. It lists each ranked token once, keeping each source's rank, name and symbol apart, because two lists can name the same contract differently. For each source it states when the stored list was fetched and how the last run went, so a failed refresh is shown beside the older list rather than hidden. It carries ranks only, never a trust verdict: the tier rule is the app's. Before the tables exist it answers "unavailable", never an empty list.

The rankings describe tokens, not a Vaipakam deployment, so a fresh Diamond on a chain does not wipe them.

Part of #3446.

_Committed 2026-11-10 11:35 UTC (a0ddb0fa3)._
<!-- assembled-fragment: 3446-asset-rankings-store.md sha256=8d43e0293ec1bc5560457a9d3df3b0b436ee0117c025d8c005a00e59331204f0 -->

## Thread — VPFI tier rules are readable and explained (PR #3475)

An app could not show the VPFI discount-tier holding rules as they are set on a chain, only the documented defaults, and could not tell a user why their tier was lower than their balance suggests. Two public reads now answer both.

The first returns the settings in force: the minimum holding period, the weighted average's window, its recent-day count and recent weight, and the look-back cap, each with the bounds governance may set it within. The setters and this read share one set of bound constants, so the read cannot drift from what the setters enforce.

The second explains one user's tier. It reports the counted balance and the tier that balance alone would reach, when the current holding started and when its minimum period ends, the weighted average and its tier, the lowest tier in the look-back, the effective tier and discount, and which rule holds the tier down: no current holding, the minimum period, the average after a recent top-up, or a dip in the look-back. On a mirror chain it says the rules run on Base and reports the cached tier.

The fee path and the explanation now resolve the tier through the same internal routine, so the explanation cannot disagree with the discount actually applied. The explanation leaves out the fee-discount consent, which is a separate gate an app shows on its own; with consent on, both give the same tier and discount.

Closes #3459.

_Committed 2026-11-10 03:34 UTC (72162e2a7)._
<!-- assembled-fragment: 3459-tier-rule-views.md sha256=0449989dfa719f63924832cee220b731343c7cdc39563583d4ae25611d273108 -->

## Keeper reads its secrets through the shared reader

The keeper now reads its Secrets Store bindings through the same shared reader the agent and indexer adopted in #3491. When a secret cannot be read, the log line names that secret, and when every bound secret fails together it says once that the store is unavailable, instead of repeating an unnamed failure for each one. A secret that cannot be read is still treated as unset for that run, so one unavailable secret never stops the whole tick.

The private-send routes are the one exception, as before (#3240): because having none of them means sending publicly, a configured route list the keeper cannot read makes the private-send path refuse for that run. Its log line now names the secret too.

_Committed 2026-11-10 12:28 UTC (6d61ec591)._
<!-- assembled-fragment: 3491-keeper-shared-secret-reader.md sha256=eb5f37f636a0b57d89b41c20e8bdbfc7e2c4085c5fa0eb320354ac1eed059b16 -->

## Thread — buyback orders hold their room, and the keeper pause stops every keeper (PR #3503)

A treasury buyback order promises a minimum amount of VPFI. That VPFI can only land in the two top-up budgets (reward emissions and keeper rewards), up to their targets, and a fill that brings more than the targets can take is refused. Until now nothing checked that room when an order was placed. With both targets at zero (the default), or with one order's fill using up the room another order needed, an order could be placed that no fill could ever settle, and its source tokens stayed reserved until it expired.

Placing an order now reserves room for its minimum. An order is accepted only if its minimum fits in the room that every other open order's remaining minimum leaves free. Each fill releases the part of its own minimum it delivered, and an expired order releases what it still held. A fill may bring more than its minimum only if the extra fits in the free room, and governance may not lower either target below what open orders hold. Each order records the room it reserved and releases only that, so an order left open across an in-place upgrade, which reserved nothing, releases nothing and settles only from free room. A new view reports the room and the part held. Closes #908.

The global keeper pause now stops everything its name covers (owner decision D13). Before, it stopped delegated keepers and the backstop buyout, but the keeper could still relay liquidity tiers, submit reward commitment reports and, as the configured remittance keeper, send reward remittances. Every keeper-role entry now goes through one shared gate that checks both the role and the pause, and the remittance keeper is refused while paused too. Position owners, permissionless liquidation and the admin's own remittance are unaffected. A refused keeper call moves nothing, so the keeper sends it again once the pause lifts. Closes #1638.

> Caveat: the pause is not a revocation. On a keeper-key compromise the key's keeper role must still be revoked (and the remittance keeper replaced), or unpausing hands its powers back.

_Committed 2026-11-10 16:35 UTC (89dfa4ea9)._
<!-- assembled-fragment: 908-1638-buyback-headroom-keeper-pause.md sha256=4a63932a465c9c9a0e8c44809ca54601704134495c2b734a4a84877f69af4a82 -->

### Secret read failures name the secret (agent, indexer)

When the agent or the indexer cannot read a secret from Cloudflare's Secrets
Store, the log now names the secret, for example "could not read RPC_ARB".
It used to say only that some secret failed, and the reader had to work out
which one from the order of a list in the code. When every secret fails in
the same run, which means the store itself was unavailable, the run logs one
line saying so and listing them all, instead of one line per secret.

Behaviour is otherwise unchanged. A secret that cannot be read is still
treated as unset for that run, so only the features that need it skip, and
the next run reads it again. Both Workers now share one module for this,
`@vaipakam/lib/secretsStore`. It was prompted by a single all-secrets outage
on the agent on 5 November that was first misread as a missing key.

_Committed 2026-11-10 11:18 UTC (92fe9bd47)._
<!-- assembled-fragment: agent-secret-read-names.md sha256=a7293b7bc3a3fd2ab35261fcc6e25c4ecd8999073a9cc6615875bba6d5171ba2 -->
