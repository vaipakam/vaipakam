# Rate auction: design

**Status:** owner asked for this design on 2026-11-19. Card #3758. Reviewed by the security thread on 2026-11-19: build it, with the changes recorded in section 12. Design first, no code yet. Built before the pre-audit refactor and audited in phases, as the owner decided for every feature that touches the loan paths. Reaches a chain by fresh deploy.
**Related:** `InstantMarketDesign.md` (#3656, whose single-fill step and group label this reuses), `IdleLiquidityMatchingDesign.md` and `AutoLendLendUntilDesign.md` (Auto-lend slots), `TermAverageAndLinkGuardsDesign.md` (the warning band, #3713), `VaultOutflowPolicyDesign.md`, `PayoutDestinationRuleDesign.md`, `FeeLevelsDesign.md`, `IntegratorFeeShareDesign.md`, `ReferralFeeShareDesign.md`.
**Base:** the code named below was read on the batch branch of #3743 (`claude/project-thread-ijafuu` at `a067c7bae`), where the instant market is built (`InstantMarketFacet`, `InstantFillFacet`, `LibIntentFill`, `LibOfferMatchExecute`, `LibEncumbrance`, `LibTiming`). Main does not have that code yet.

## 1. Why

A borrower who wants a large amount has two ways to borrow today.

- Post a request and wait for a lender to take it. One lender must bring the whole amount, or the request fills in parts over time at whatever each lender asks.
- Take what stands on the book now (the instant market): cheapest source first, each part at that source's own price. The borrower pays several rates, and only funds that already stand can fill it.

Neither gives lenders a stated window to bring funds for one large request, and neither gives the borrower one rate. A rate auction does both. Its result is also plain to read afterwards: what was asked, what was bid, and the one rate everyone received.

## 2. What it is

A borrower opens an auction for an amount, a term and a collateral, with the highest rate they accept and a closing time. Lenders place bids: an amount and the lowest rate they accept. At the close one rate is found from the bids. Every bid below that rate is filled in full, every bid above it is released, and every filled bid becomes its own loan at that one rate.

Four things stay as they are everywhere on the platform:

- **Every user's funds stay in their own vault.** A bid's funds are held in the bidder's vault until its loan opens or the bid is released. The borrower's collateral is held in the borrower's vault. Nothing rests in the Diamond.
- **Every loan is between one lender and one borrower**, with its own collateral, its own health factor and its own liquidation. The auction's loans share a group label and nothing else.
- **The platform sets no rate.** The rate that fills is always one of the lenders' own bid rates and is never above the borrower's stated limit. The contract applies a stated rule to stated bids and takes no input from whoever calls the close.
- **Every loan opens through the one shared loan-opening step**, so every existing check runs for it.

First version: ERC-20 pairs whose two assets are both priced and liquid, fixed-rate loans with interest by time, behind a master switch that is off by default.

## 3. The rule

1. The borrower is bound from the first bid. Before any bid stands they may cancel. After that they may only add collateral.
2. A bid is firm. It may be improved (a lower rate, a larger amount) and never withdrawn or made worse.
3. A bid's funds are held in the bidder's vault from the bid until its loan opens or it is released. The longest that can last is stated before the bid is placed.
4. One rate fills every loan: the lowest rate step at which the bids cover the amount.
5. Nothing is borrowed unless the bids reach the borrower's stated least amount at the close.
6. Every held amount has a fixed latest release time that no pause and no missing step can move.
7. Opening, bidding, improving, closing and releasing carry no fee. The loans carry the ordinary fees of any loan.

## 4. Design

### 4.1 Opening an auction

The borrower's call states:

- the lending asset and the collateral asset;
- the **amount wanted**, at least the smallest auction size (a setting in value, default 10,000 in the numeraire, bounded 1,000 to 1,000,000);
- the **collateral posted** for the whole amount;
- the **term** in days, and whether partial repayment is allowed, as a borrower's request states them;
- the **highest rate** accepted;
- the **least amount** they will take, from the smallest auction size up to the amount wanted (the amount wanted itself means all or nothing);
- the **smallest bid**, at least 1% of the amount wanted (a setting, bounded 0.5% to 10%), so the borrower knows the most loans a full fill can leave them with;
- the **closing time**, between 1 hour and 72 hours away (the ceiling is a setting, bounded 1 hour to 7 days);
- the transaction deadline, the risk and terms consent, an optional registered integrator, and `rateFarFromAverageAcknowledged` where the highest rate is outside the warning band.

What the open does:

- **Locks the collateral at once**, in the borrower's own vault under a lien for the auction, taken from free vault balance first and then from the wallet, as an instant borrow takes it. Lenders bid against collateral that is already there.
- **Asks for a cushion.** The collateral must satisfy the loan-opening rule for the whole amount at the price of that moment, read the way the loan-opening step reads it, and exceed it by the opening cushion (a setting, default 10%, bounded 0 to 25%). Without it, any small fall in the collateral's price before the loans open would leave the borrower free to choose whether to go on by adding collateral or not. The cushion keeps the borrower's commitment real through ordinary price movement.
- **Fixes the collateral for each unit borrowed**: the collateral posted divided by the amount wanted. A later addition raises it for every loan not yet opened. It never falls.
- **Fixes the rate ladder** (4.2).
- Refuses a pair the ordinary request path would refuse, a sanctioned or locked account, a wallet that has not accepted the Terms, a paused asset, and a wallet that already has two auctions open (a setting, bounded 1 to 8).
- **Records the settle window and the Terms version** in force at that moment. A later change of either setting does not reach an auction already open.

An auction is its own record. It is not an offer: it cannot be accepted or matched, it does not count toward the open-offer cap, and it is listed only as an auction. It carries no position token and cannot be transferred.

### 4.2 The rate ladder

Bids name a step on a fixed ladder, not a free rate.

- The top step is the borrower's highest rate. The steps go down from it in equal sizes of a whole number of basis points to zero or just above it. The size is the smallest that keeps the ladder to at most 256 steps: 1 basis point for a highest rate up to 2.55%, 5 basis points for 12%, 12 basis points for 30%.
- The contract keeps one total per step. The close reads those totals and never the bids, so it is one bounded call however many bids stand.
- A bid above the top step cannot be placed. That is the borrower's limit.

### 4.3 Bidding

A lender's call states the auction, an **amount** (at least the smallest bid), a **rate step** (the lowest rate they accept), the transaction deadline, their consent to the loan's terms, and `rateFarFromAverageAcknowledged` where their own rate is outside the warning band. A bid far below the average is the case the band exists for: a lender who bids near zero may be filled near zero if every other lender does the same.

- **The funds are held at once**, in the bidder's own vault under a lien for that bid, from free vault balance first and then from the wallet. A bid follows every vault rule a lender offer follows.
- **Firm.** The bidder may lower the rate step or raise the amount. They cannot withdraw the bid, raise its rate or lower its amount. The review states the latest time the funds can be held to (4.6) before the bidder confirms.
- **Public.** Every bid's amount, rate and bidder are on chain and shown.
- **Several bids** per wallet are allowed, at different steps, at most 8 standing per wallet in one auction.
- **No price-move guard on a bid.** An offer's maker may arm that guard; a bidder may not. On a firm bid it would be a way out: bid low, and when the price moves the guard fails and the loan never opens. The lender is protected by the loan-opening rule, tested when the loan opens, and by the cushion.
- **Refused:** the borrower's own address (the self-trade rule), a sanctioned or locked account, a wallet that has not accepted the Terms, a paused asset, and any bid at or after the closing time.
- A bid carries no position token and cannot be transferred.

**The closing time moves for a late bid.** A bid or an improvement in the last 10 minutes moves the closing time to 10 minutes after it, and never later than one hour after the closing time first stated. A hard close invites bids in the last seconds, which other lenders have no time to answer. The borrower only gains from the answer.

### 4.4 Closing

After the closing time anyone may call the close. It takes no input but the auction, and moves no funds.

- If the total of all bids is below the borrower's least amount, the auction **lapses**. Nothing is borrowed, and every bid and the collateral can be released.
- Otherwise the amount to fill is the lesser of the amount wanted and the total bid. The **clearing step** is the lowest step at which the bids at or below it reach that amount. Its rate is the one rate of every loan.
- Bids below the clearing step fill in full. Bids above it fill nothing.
- Bids on the clearing step share what is left after the bids below it, **in proportion to their amounts**, rounded down. A share worth less than the smallest loan the platform opens is not filled.
- When the bids do not cover the amount wanted but reach the least amount, every bid fills in full at the highest bid's rate.

The close records the rate, the amount to fill and the share at the clearing step, and states them in one event with the total bid. Bids above the clearing step can be released from that moment.

### 4.5 Settling

After the close anyone may settle bids, a few at a time, until the **settle deadline**, 6 hours after the close (a setting, bounded 1 to 48 hours). The keeper does it at once. The window exists for the cases that must wait: a price that is not fresh, a sequencer outage and its grace period, a short pause.

- **Each filled bid becomes one loan**, opened through the shared loan-opening step from a lender part made from the bid and a borrower part made from the auction, both at the one rate. This is the path an instant fill takes, with a bid as the source. Every check runs at that moment: health factor, loan-to-value, risk access, sanctions, self-trade, the level rules, the refusal of a stale or distrusted price, the timing rule.
- **The Terms test is the one exception.** Settle asks whether the borrower had accepted the Terms in force when the auction opened, and the bidder those in force when the bid was placed. A new Terms version published in between does not stop the loan. Otherwise declining the new version would be a way out of a firm bid or a bound auction.
- **Refused while the L2 sequencer is down and through its grace period**, as a forced step is, so no loan opens on a price that could not move. The bid is tried again afterwards.
- **Refused from the end time on** (4.6). Settle and release meet at that one moment and never overlap.
- **Principal** moves from the bidder's vault to the borrower's vault as free balance, less the fee, as every loan's principal does. Taking it to a wallet is the separate withdrawal, under the account's own policy.
- **Collateral** for the loan is its amount times the collateral for each unit borrowed, rounded down, moved from the auction's lien to the loan's own lien in the borrower's vault.
- **The term** runs from the moment each loan opens. The loans of one auction can therefore fall due minutes apart.
- **The group.** The loans share a group label, the one instant-market loans use, so the group helpers (repay, add collateral, withdraw surplus) and the one-position view work for them.
- **One bid that cannot open is skipped and reported** with its reason, and the rest go on. It may be tried again until the deadline.
- The remainder of a bid filled in part is released in the same step.

The fee on each loan is the ordinary one, split as for a direct accept: no matcher is named, so no match share is paid, and whoever calls the settle is paid nothing from it.

### 4.6 Ending and release

The auction has a fixed **end time**: the final closing time plus the settle window. It is known when the auction opens, as a latest value: the closing time, plus at most one hour, plus the settle window.

- From the end time every bid that has not become a loan, and all collateral not moved to a loan, can be released by anyone. This holds while the platform is paused, and whether or not the close was ever called.
- **A release only removes a lien inside the owner's own vault.** It moves nothing out of a vault, and it refuses any amount that has already moved to a loan. That is what makes it safe during a pause.
- The settle window is the one recorded at the open, so the latest end time stated to a bidder cannot be lengthened afterwards.
- A lapsed auction, and a bid above the clearing step, can be released as soon as the close has run. The keeper releases bids above the clearing step at the close, and releases a lapsed auction's slot bids first, so Auto-lend funds return to their slots soonest.
- Released funds are free balance in their owner's vault. Nothing is sent to a wallet.

**What the borrower may end with.** Less than the amount wanted, in three stated cases: the bids did not cover it (but reached the least amount), a share at the clearing step was too small to open, or a filled bid's loan could not open before the deadline. The least amount is tested at the close, on the bids standing then. A loan that fails to open afterwards is not made up from the bids above the clearing step, because that would bring in a second rate.

### 4.7 Auto-lend slots may bid (second step)

Idle Auto-lend funds are the deepest source of lenders. A slot gains one consent, **bids in rate auctions**, with two limits of its owner: the longest its funds may be held for one auction, and the largest share of the slot's capital that may be held in auctions at one time.

- A step anyone may call places a slot's bid in an auction. It runs the one slot rule every fill of a slot runs: the slot is live and its terms aged, the amount is within its smallest fill and its exposure, the term within its longest term and its lend-until time (measured from the auction's end time), it accepts interest by time and the repayment shape asked for, and the auction's collateral for each unit borrowed meets the slot's loan-to-value limit.
- **The rate** is the slot's own lowest rate, rounded up to a ladder step. A slot whose lowest rate is above the top step does not bid. A slot is never filled below its lowest rate, and under one rate for all it usually receives more.
- **The amount** is the slot's free capital within its limits, no more than the amount wanted and no less than the smallest bid.
- **Only near the end.** A slot's bid is placed only when the auction's end time is within the slot's hold limit. The funds move from the slot's capital lien to the bid's lien in the same vault, and return to the slot when the bid is released.
- One standing bid for each slot in one auction. It is firm like any bid, and a later change of the slot's settings does not change it. Turning the consent off stops new bids only.
- Fixed-rate slots only.

### 4.8 What the app shows

- **The borrower:** "Run a rate auction" beside the instant borrow, for amounts at or above the smallest auction size. The review states that they are bound from the first bid, that funds arrive in their vault, that they may receive less than they asked, that they may end with one loan for each lender, and the latest time the loans can open.
- **Lenders:** a list of open auctions with the amount, term, collateral for each unit, highest rate, total bid so far, the rate and fill "if it closed now", and the time left. The bid review states that the bid is firm and until when the funds can be held.
- **After the close:** the one rate, the amount filled and the total bid, on the auction's own page. It is described as that auction's result and never as a market rate.
- Every figure "if it closed now" comes from a preview the contract answers, with the same first refusal a bid or a close would raise.

## 5. What cannot be gamed, and what is stated

- **Showing a bid to scare others off, then pulling it:** bids are firm.
- **Bidding in the last second:** the closing time moves.
- **The borrower fishing for rates with no wish to borrow:** bound from the first bid, with the collateral and its cushion already locked.
- **The borrower bidding in their own auction:** their own address is refused. From a second wallet it gains nothing: the bid takes part of the amount at the same one rate, which is the same as asking for less, and both sides pay the usual fees on it.
- **A lender holding funds back to lift the rate:** possible in any auction with one rate. It is bounded by the borrower's highest rate and by every other bidder, and a held-back bid may simply not fill.
- **Lenders agreeing among themselves to bid high:** the platform cannot see it or stop it. The borrower's highest rate is the limit of what it can cost, and any lender outside the agreement undercuts it. Stated to the borrower.
- **Dust:** the smallest bid, and the smallest loan at the clearing step.
- **Steering the close or the settle:** the close takes no input, and the shares are fixed by it, so the order of settling changes nothing.
- **Making your own loan fail after the close.** The funds and the collateral are held, so they cannot be moved away. The cheap ways out are closed: a bid carries no price-move guard, and a new Terms version does not stop a loan (4.3, 4.5). What remains is costly or outside the party's control, and is stated, not prevented: locking a protected account (a lock that only a clawback ends), replacing or retiring a protected account, and being flagged by the sanctions list. Each stops that party's loans only; the funds are released at the end time.
- **A caller timing the settle to a dip in the price:** the most it does is make a loan fail the health test at that moment. The bid is tried again until the deadline, and the cushion absorbs ordinary movement.
- **Tying up Auto-lend funds with an auction that cannot fill:** costs the borrower more locked collateral than the funds they tie up. It is bounded by each slot owner's hold limit and share, and slot bids arrive only near the end.
- **Trading with yourself across two wallets:** as everywhere, the platform cannot see it. It pays the usual fees and moves no figure the platform relies on.
- **Stated to the lender:** the funds are held for up to the stated time and may come back unused. The loan can open at any moment before the settle deadline. Its rate may be above their bid and is never below it.
- **Stated to the borrower:** the four points of the review in 4.8.

## 6. Wording rules

The feature is a **rate auction**, its outcome an **auction result** or **the rate of this auction**. Its loans are **loans**. The app, the site and the docs never call them bonds, bills, notes or an issue, never say a lender subscribes, and never present a result as a market rate, a benchmark or a yield. A bid is a **bid**, and what a lender receives is **interest**.

## 7. Contract and off-chain changes

| Where | Change |
| --- | --- |
| New facet for the borrower's and the bidder's entries | Open, cancel, add collateral, bid, improve, the settings, the views and previews. A new facet, not added to one near its size limit. |
| New facet for close, settle and release | The match core is most of its size, as with the instant fill. Refreshed together with the first. |
| Shared loan-opening step | Accepts a bid as the source of a lender part and an auction as the source of a borrower part, at a stated rate; stamps the group label. |
| Liens | Two new kinds in the one encumbrance ledger: the auction's collateral and a bid's funds. A slot bid moves capital between the slot's lien and the bid's lien. |
| Lender intent | The auction consent with its two limits; funds held in auctions count toward the slot's exposure. |
| Views | An auction with its ladder totals; a page of bids as lean rows; what a close would do now; whether a bid would be accepted, where it would stand, and why not. |
| Events | Opened, cancelled, collateral added, bid placed, bid improved, closing time moved, closed (rate, amount to fill, total bid) or lapsed, loan opened (with the group), bid released (with the reason), ended. |
| Keeper | Passes for close, settle, release and slot bids, and alerts to the borrower (first bid, covered, result, collateral near the rule) and to bidders (no longer inside the fill, result, loan opened or funds released). New passes ship disarmed. |
| Permissionless-steps ledger, indexer, app | Rows for the open steps; auction and bid indexing; the screens of 4.8; wording per section 6. |

Append storage at the tail and run the storage-layout guard's `write`. Check facet sizes with the deploy-sanity suite.

## 8. Tests

1. Open: collateral locked from vault then wallet; refused below the smallest size, without the cushion, with a least amount above the amount wanted, a smallest bid below its floor, a closing time outside the bounds, a third open auction, and for each ordinary refusal.
2. The ladder for several highest rates: step size, at most 256 steps, the top step equal to the highest rate.
3. Bid: funds held; refused below the smallest bid, above the top step, at or after the closing time, from the borrower's address, past 8 standing bids, and for each ordinary refusal.
4. Improve: a lower step and a larger amount accepted and the step totals follow; a higher step, a smaller amount and a withdrawal refused.
5. The closing time moves for a bid or an improvement in the last 10 minutes, and never past one hour after the first closing time.
6. Cancel: accepted with no bid, refused after the first.
7. Close, fully covered: the clearing step is the lowest that covers; bids below fill in full; bids on it share in proportion, rounded down; bids above fill nothing; the totals add up to at most the amount to fill.
8. Close, part covered at or above the least amount: every bid fills at the highest bid's rate.
9. Close below the least amount: lapsed, and everything can be released.
10. The close takes no input, cannot run before the closing time, and gives the same result whoever calls it.
11. Settle: each loan carries the one rate, its share of collateral and the group label; principal arrives in the borrower's vault less the fee; the term runs from the loan's own opening; any order of settling gives the same loans.
12. Every loan-opening refusal applies to each loan; a refused bid is skipped and reported, the rest open, and it can be tried again.
13. A fall in the collateral's price inside the cushion does not stop the loans; a fall beyond it stops them until collateral is added; an addition raises the collateral of loans not yet opened only.
14. A share at the clearing step below the smallest loan is not filled and is released.
15. From the end time every bid and all unused collateral can be released by anyone, while paused, and when the close was never called; nothing can be released earlier except a bid above the clearing step and a lapsed auction. A release refuses an amount already moved to a loan, and settle is refused from the end time on. A change of the settle-window setting does not move the end time of an open auction.
16. After any sequence of open, bid, improve, close, settle and release, each vault's held amounts equal the sum of its standing liens, and nothing rests in the Diamond.
17. The warning band: the acknowledgement is asked for the borrower's highest rate and for a bid's rate outside the band, and never inside it.
18. Slot bids: the consent and both limits; every slot refusal; the rate rounded up to a step and never below the slot's lowest; placed only within the hold limit; capital returns to the slot on release; funds held count toward exposure.
19. With the master switch off, every new entry refuses, and an auction already open can still close, settle and release.
20. The fee on each loan equals the fee of a direct accept of the same loan, with no match share.
21. A bid cannot arm a price-move guard. A new Terms version published after the open, or after a bid, does not stop that party's loan; a party who had not accepted the version in force at that moment could not have opened or bid.
22. Settle is refused while the sequencer is down and through its grace period, and succeeds afterwards within the deadline.

## 9. Alternatives considered

1. **Each lender is paid their own bid rate.** The borrower pays several rates, and a lender is pushed to guess the highest rate that still fills. Rejected: one rate is the point, and it lets a lender bid the lowest rate they truly accept.
2. **Hidden bids, shown after the close.** Needs two steps from every bidder, and a bidder who never shows their bid stalls the auction or must be penalised. The amount held shows most of the bid anyway. Rejected.
3. **Bids that can be withdrawn.** Rejected: see section 5.
4. **Earliest bid first at the clearing step.** It rewards bidding early and leaves at most one bid filled in part. The owner refused price-and-time priority on chain for matching (#3615), and a share in proportion is how such auctions are commonly settled. Rejected unless the owner reopens that ruling.
5. **Run the auction off chain with signed bids and settle the result on chain.** Bids would not be backed by held funds, and whoever runs it could leave a bid out. Rejected.
6. **Open every loan inside the close, in one transaction.** It would cap the number of lenders at what one transaction can open, as the instant market's fill limit does. Rejected for a feature meant for large amounts.
7. **One loan shared by all the filled lenders.** Rejected in the instant market design: those lenders would share one loan's loss.
8. **Bring in the next bids when a filled bid's loan cannot open.** It would add a second rate, or reopen the close. Rejected: the borrower receives less, and it is stated.
9. **A hard closing time.** Rejected: see 4.3.
10. **Let the borrower close early once covered.** It cuts short the window lenders were told. Left out.
11. **Do nothing.** The large borrower stays without one rate and without a window for lenders to arrive.

## 10. What this does not do

- No floating-rate auction. The margin of a floating loan can be auctioned by the same rule once floating loans exist.
- No collateral without a price, and no NFT collateral.
- No auction that repays an existing loan in the same step. The borrower repays from their vault after the loans open.
- No renewal or takeover consents on the loans. They are ordinary loans: each can be sold, refinanced and repaid under the ordinary rules.
- No rate is published as a reference. A result is one auction's outcome.

## 11. Recommendation and order of work

Build it as designed, behind the master switch:

1. The auction with direct bids: open, bid, close, settle, release, the views and events.
2. The keeper passes and alerts, the indexer, and the screens.
3. Auto-lend slots bid on the consent (4.7).
4. Later, with floating loans: the same rule for a margin.

## 12. Settled with the security review (2026-11-19)

The security thread reviewed this design before it merged. Its verdict: build it, with these changes, all folded in above.

- Firm public bids at one rate are accepted. That lenders may agree among themselves is stated (section 5).
- No price-move guard on a bid, and settle tests the Terms acceptance in force at the open or at the bid (4.3, 4.5). Both were ways out of a firm commitment.
- The other ways a party can stop their own loan are named in section 5.
- Slot bids are bounded enough by the owner's two limits and the borrower's locked collateral. A lapsed auction's slot bids are released first.
- Release during a pause is safe on four conditions, all in 4.5 and 4.6: it refuses anything already moved to a loan, settle stops at the same moment release begins, the settle window is recorded at the open, and a release frees funds only inside the vault.
- The close has no input and nothing to front-run. Settle is refused while the sequencer is down and through its grace period. The cushion test at the open reads the price the way the loan-opening step does.

## 13. Open items for the builder to raise, not decide silently

1. Whether a bidder may name a registered integrator, and which one a loan carries when both sides name one.
2. The exact construction of the ladder for a highest rate that is not a multiple of the step size.
3. Whether the group label's storage and helpers, named for the instant market, are renamed for both uses or kept.
4. Which of the origination checks a party can trip by their own later act, beyond those named in section 5. Each one found is either taken when the auction opens or the bid is placed, or reported to the design thread.
