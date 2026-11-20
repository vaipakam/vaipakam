# One loan from several lenders

**Status:** design for the owner's decision. Nothing is built from it and no builder changes course on it. The owner ruled a shared loan out on 2026-11-19 and reopened the question on 2026-11-20. Until the owner decides, the line in `BorrowingDesign.md` ("one shared loan and one shared collateral holding stay rejected") still describes what is built. Card #3867.

**Related:** `InstantMarketDesign.md` (#3656), `BorrowingDesign.md` (#3808), `LendingBalanceDesign.md` (#3811), `RateAuctionDesign.md` (#3758), `LenderCashOutDesign.md`, `DueDatePlanDesign.md` (#3785), `StandingInstructionsDesign.md` (#3681), `NetworkWindDownDesign.md`, #3851 (a loan made from terms in the same call), #3865 (a dated end for a loan left in the fallback state).

**Words.** A **part** is one lender's side of a loan that has several lenders: a stated amount of the principal, that lender's own rate, and a stated amount of the collateral. **Separating** a part turns it into an ordinary loan of its own. The document never uses "share" for a part, because no lender's money and no lender's result is shared in this design.

## 1. Why this is back

**Gas.** An instant borrow opens one loan per lender it fills from. Measured on the CI toolchain, the first fill costs 5.41 million gas and each further one about 4.8 million, so a borrow from 8 lenders costs 39.2 million. Ethereum, Base and OP Mainnet limit one transaction to 16,777,216 gas, and Arbitrum One and Polygon PoS to 32,000,000. Staying inside 80% of the limit, one borrow fills from 2 lenders on the first three networks and 5 on the other two. After the planned change that makes a loan from terms in the same call (#3851), the estimate is about 4 and about 8.

Most of that cost is written once per loan and is the same for every loan of the borrow: the borrower, the two assets, the start, the term, the due date, the fee terms, the borrower's position token, the platform totals and the per-wallet lists. Only the lender, the amount and the rate differ.

**The borrower.** A borrower who fills from 8 lenders holds 8 loans. `BorrowingDesign.md` exists to make those read as one: one reserve drawn by several loans in a fixed order, one set of settings, a fence on renewal, one close-out for loans that fall together. That is a real amount of machinery whose only cause is that one borrow makes several loans.

**Why it was ruled out, and what has changed.** Custody was never the reason. In this design no money sits in a common place at any time (rule 1). The reason recorded on 2026-11-19 was shared outcome: with one loan and one collateral lot, the lenders would share that loan's loss, and one lender's liquidation would reach another's security.

That reason holds against a loan where the lenders hold an undivided interest in one lot. It does not hold against the shape below, where each lender's part is a stated amount of debt and a stated amount of collateral, every forced sale is booked part by part, and any part can be separated into its own loan. In that shape no lender's result depends on another lender's part. The parts are stored together because they are identical in everything but three figures, and they act together until someone needs one of them alone.

## 2. What each side gets

**The borrower** holds one loan: one health figure, one repayment, one top-up, one reserve, one set of settings, one due date and, if it comes to that, usually one liquidation (section 12). It carries one rate, which is the average of the lenders' rates weighted by amount, and the review shows each lender's rate beside it.

**A lender** holds its own part, with its own position token, at its own rate. Its money goes from its own vault to the borrower's vault when the loan opens. Every payment the loan makes reaches the lender's own vault in the same transaction. It may sell its position token to anyone at any time. If it wants anything that concerns it alone (to leave by a takeover, to give notice, to take an advance on the position), its part is separated and the existing route runs on a loan of its own.

**Neither side** gains or loses money by the parts being stored together, compared with the same loans stored apart and acted on at the same moments. Section 3, rule 7 states this, and section 12 states the places where the moment itself differs.

## 3. The rules

1. **No common place.** Each lender's money moves from that lender's vault to the borrower's vault at opening. The collateral stays in the borrower's vault under the loan's hold. Every amount the loan pays a lender lands in that lender's own vault in the transaction that pays it. Nothing waits in the platform's contracts or in any holding that belongs to more than one user.
2. **A part is a stated amount.** A part stores its own principal, its own rate, its own interest record and its own collateral amount. At opening its collateral is the loan's collateral times its principal over the loan's principal, by the rounding rule of section 4. After that every change is made to the part's own stored figures by rule 3, never derived again from a weight, and the parts' figures always sum to the loan's. So the question "which collateral secures this lender" always has one answer in units.
3. **Every step reaches every part, by that part's own figures.** A payment by the borrower pays interest first and then principal, as on a loan today: the interest goes to each part by its own interest owed, and the principal by each part's principal outstanding. Collateral the borrower adds is divided by the collateral each part holds. Surplus collateral the borrower withdraws is divided the same way, and the withdrawal is refused if it would leave any part, on its own figures, below the level a loan must keep. A forced sale is the sum of the parts' own sales (rule 4). The parts' figures may therefore move apart over time, because each part is charged and paid as a loan of its own would be. No step may pay, reduce, extend, close or forgive one part and not the others. The only way to treat one part differently is to separate it first (rule 5).
4. **A forced sale is the sum of the parts' own sales, and each part is booked as its own loan.** A forced sale of the loan follows the conditions `BorrowingDesign.md` section 9 sets for loans that are sold together, with parts in place of loans and with one condition replaced. Section 9 requires every loan named to be liquidatable by itself. For the parts of one loan, the loan's one test takes that condition's place: a health-factor liquidation is open when the loan's totals fail the test, and a default or a periodic sale is open when the loan's one date has passed. No part is tested by itself in that sale, so when the loan's figure is below the level a part whose own figure is above it is sold with the rest, by its own plan. Section 12 states that limit. Every other condition of section 9 is kept. Each part has its own plan, sized from its own figures exactly as a loan of its own would be: its own debt for a liquidation or a default, its own interest shortfall for a periodic sale, and for a partial liquidation the amount that brings it to the target, which is nothing for a part already there. Only the plan's size is taken from the part; whether the sale is open is the loan's test. Each part has its own quoted amount, checked against that plan, and its own floor. The amounts are sold as one sale. The proceeds divide by the collateral sold from each part, each part's portion is checked against that part's own floor, and each part is then booked exactly as a loan of its own: its own interest and principal, its lender whole first, then the rest for the borrower. One part's surplus never pays another part's shortfall, and one part's shortfall never reduces another part's payment. If the one sale finds no working route, or any part's check fails, the whole step reverts and nothing moves or is recorded: **a loan with more than one part never enters the fallback state.** A part may always be sold alone. That step separates it (rule 5) and runs today's route on its own loan, by that loan's own test, as section 9 requires of a loan, and under its own fallback gate, so only a loan with one lender can reach the fallback state. A forced route not named in section 7 acts on a loan with one lender, after separation.
5. **Any part can be separated.** One step turns a part into an ordinary loan with one lender: it takes its stored principal, its interest record, its collateral amount and the same start, term, due date and fee terms. The two loans' debt and collateral sum to the original's. Each loan then has its own health figure, from its own figures. The original's figure lies between the two, and section 12 states how they can differ. A loan in the fallback state has one part already (rule 4), so separation never meets that state. It may be called by the holder of that part's position token, by the holder of the borrower position, and by the platform's own steps that need it (rule 6). Separation moves no money and changes no one's entitlement. It is not an opening step: it commits no one's money or consent, so it asks neither the Terms rule nor a closing network's rule (`NetworkWindDownDesign.md`).
6. **An action for one lender acts on a loan of one lender.** A takeover at face value, a notice to leave, an advance on the lender position, a forced sale or default of one part alone, an internal match, and a part that will not continue at the due date each separate the part in the same transaction and then run the existing route unchanged. If that route reverts, the separation is undone with it. Selling the position token needs no separation.
7. **Equal to the separate loans.** For any sequence of steps, each lender and the borrower end with what separate loans would have given them, when those loans are opened with collateral in proportion and each step is applied to each of them at the same moment in the amount rule 3 gives its part. This is a tested property, not an intention (section 13).
8. **One lender cannot hold up anyone else.** A part whose payment cannot be delivered (the token refuses that lender's vault) is parked for that part alone, as a refused payment is parked today. A lender the sanctions list flags is paid into its own vault, where the amount stays locked, as today. In both cases the borrower's step completes and every other part is paid in full.
9. **A bounded number of parts.** The most parts a loan may have is set per network from the measured cost of the costliest step that walks the parts, so that step stays inside 80% of the network's limit on one transaction. Governance may set it lower, never higher. A loan with N parts counts as N toward the bound on a borrowing's list (`BorrowingDesign.md`, section 4) from the moment it opens, because a step that walks a borrowing walks every part, and so that separating a part always has room on that list.
10. **Same terms or not the same loan.** Parts have the same lending asset, collateral asset, start, term, due date, interest basis and fee terms. A source whose terms differ in any of these opens its own loan, as today. A loan with more than one part has token collateral that can be stated as an amount per part; a loan secured by a single item, such as an NFT, has one part.

## 4. The record

- **One loan record**, as today, with the loan's totals: principal, collateral, the clock. The loan's rate is a shown figure, worked out from the parts.
- **A list of parts**, each with: the lender position token, its principal outstanding, its collateral amount, its rate, and where it came from (an Auto-lend slot, a lender offer, an auction bid).
- **Per part, what is per lender today:** the interest record (what the holder has earned and been paid, and a seller's claim after a sale), what is held for the lender, the lender's claim after the loan ends, the fee discount recorded when the holder entered, the sanctions marker, the slot's live principal in the market ledger, and the reward record.
- **A loan with one lender is a loan with one part.** There is one code path, not two. An NFT rental, and any loan a direct accept or a match opens, has one part.
- **Rounding.** A division among parts rounds each part down. The remainder, which is less than one unit per part, is handed out one unit at a time in the stored order, passing over a part that has already reached the most that kind of amount allows it: what it is owed for a payment, what it holds for collateral taken. The amount divided never exceeds the sum of those limits, so the remainder always finds room. An amount with no such limit (collateral added, a sale's proceeds) is handed out in the stored order without passing over any part. No part is ever paid more than it is owed or debited more than it holds, and the parts always sum to the total. The same rule is used for collateral and for every payment.

**The seam.** Today about 60 contract files read a loan's lender or its position token, 10 places write what is held for the lender and 16 places write the lender's final claim (counted on `main`, 2026-11-20). This design does not teach each of them about parts. It puts one library between the loan and its lender side. A payer hands that library a kind of payment (principal, interest, a late fee, sale proceeds, collateral in kind) and an amount, and the library divides it, applies each part's own fee discount, delivers to each part's vault and keeps each part's records. A reader asks it who holds a part. Nothing outside it knows whether a loan has one part or eight.

That makes the build two steps, and the first is worth having on its own:

1. **The seam, with one part.** Every payer and reader goes through the library. No behaviour changes, and the existing tests must pass unchanged.
2. **Parts behind the seam.** The list, the division, separation, and the opening paths that make more than one part.

## 5. Opening

- **An instant borrow** opens one loan with one part per source it fills from, in place of one loan per source. Each source is still checked by its own rules (a slot's rate, term, loan-to-value, health and exposure limits, its lending balance), a refusing source is still skipped and reported, and the borrow still reverts below the borrower's stated least. Collateral is one amount for the loan.
- **A rate auction's settle** keeps the auction's own rules (`RateAuctionDesign.md`, 4.5): anyone settles bids a few at a time until the end time, and a bid that cannot open is skipped, reported and may be tried again. Each settling transaction opens one loan, with one part per bid it settles, every part at the auction's one clearing rate (`RateAuctionDesign.md`, 4.4), and never more parts than rule 9 allows. A bid below the clearing step is paid the clearing rate, as today; a part never carries the rate a bidder offered. Bids settled by a later transaction start at a different time, so they open another loan (rule 10). An auction therefore ends with one loan per settling transaction, not one per winning bid and not one for the whole auction. Its admission limits, its retry and its end time do not change.
- **A borrow request filled from several sources in one transaction** opens one loan with a part per source.
- **Adding a part later** to an open loan is not offered. A later fill or a later borrow starts at a different time, so it is a new loan (rule 10), and it may join the same borrowing.

**The estimate.** Per further lender, what remains is the source's own check and record, one movement of money, one position token and the part's records: about 0.7 to 0.8 million gas, against about 4.8 million today and about 2.8 million after #3851. For 8 lenders that is about 9 million in total. This is an estimate from the measured split of one fill, not a measurement. Step 0 of the order of work (section 16) measures it before anything else is committed.

## 6. The rate

Each part carries the rate its loan would carry today: a slot's or an offer's own rate in an instant borrow, and the one clearing rate in an auction, where every part's rate is therefore the same. The borrower pays the sum, and the loan shows the weighted average.

- **Fixed rates.** Each part accrues its own interest, on its own principal outstanding, at its own rate, in its own interest record, exactly as a loan does today. Nothing is divided by a weight: the interest the loan owes is the sum of what the parts owe, and a payment of interest goes to each part by what that part is owed (rule 3).
- **Floating rates.** A part's rate is the reference plus that part's margin, accrued the same way on its own principal.
- **One rate for every lender** (the highest minimum among them) was considered and is not proposed: the borrower would pay more than today and the cheaper lenders would be paid above what they asked.

## 7. Steps on the loan

Each of these runs once on the loan and reaches the parts through the seam.

| Step | With parts |
| --- | --- |
| Full repayment | Each part receives its principal and its own interest in its own vault. The loan ends. |
| Partial repayment | Interest first, to each part by its own interest owed; then principal, to each part by its principal outstanding. The borrower who wants to repay one lender first separates that part (rule 5) and repays that loan. |
| Interest payment, periodic settlement | Divided by interest owed. |
| Adding collateral, withdrawing surplus collateral | Divided by the collateral each part holds, so each part's fraction of the collateral stays what it was. |
| Health-factor liquidation, partial liquidation, the time-based default, the periodic forced sale | One sale for the loan, made of the parts' own sales (rule 4). A health-factor liquidation is tested on the loan's totals and on nothing else: no part is refused, and none is spared, for its own figure (rule 4). A default and a periodic sale fall due for every part at the same moment. Each part's amount comes from its own plan: a partial liquidation brings each part to the same target on its own figures, and a periodic sale covers each part's own interest shortfall, so a part owed more gives up more collateral and its lender is paid what that part is owed. Each part is booked as its own loan, with its own handling fee, its own part of the bonus and its own extra held for the borrower. If the sale finds no working route the step reverts, and the parts are sold one at a time. |
| A failed sale (the fallback state) | Never reached by a loan with more than one part (rule 4). A part sold alone is separated first, and its own loan enters the fallback state under today's gate: a failed sale opens it only when an earlier failed sale of that loan is old enough. From there everything is as today for a one-lender loan: the lender's claim, the borrower's cure, the backstop's purchase. Another part's failed sale changes nothing for a part that can still be sold. |
| Internal match | Acts on a loan with one lender. A part is separated first (rule 6). |
| Early close by the borrower, refinance | The amount due divides as a repayment does. |
| Sell and repay before liquidation, repay from collateral at the due date | The borrower's own repayment from a sale: one sale, then as a full or partial repayment. |
| Extension in place, renewal, "continue with another lender" | Each part continues by its own consent. A part that will not continue is separated in the same step and comes due on its own loan, where the borrower's due-date plan acts on it. The rest extend as one loan. |

## 8. What a lender does alone

| The lender wants to | How |
| --- | --- |
| Collect what is held for it | A claim for its part. Nothing else moves. |
| Sell its position | Transfer or sale of its own position token. The part's interest record handles the seller's earned interest as today. No separation. |
| Leave by a takeover at face value, give notice to leave, take an advance on the position | The part is separated in the same transaction, then the existing route runs on the new loan. |
| Claim after the loan ends | Its own claim, its own position token burned. The loan is settled when the last part and the borrower have claimed. |

Separation is why none of these routes has to be rebuilt per part. The cost is the gas of making one loan record, paid by whoever asks, and only when asked.

## 9. A flagged lender, and a token that refuses a vault

- **Payments.** A lender the sanctions list flags is paid into its own vault and the amount stays locked there until the list clears it, by the existing lock. A token that refuses one lender's vault parks that part's payment for that part, by the existing parked-payment path. Each part's delivery is its own unit of failure (rule 8), so the borrower's repayment and every other part complete.
- **The position.** A flagged holder cannot claim, withdraw or transfer, as today.
- **Separation on a flag.** Once a part's holder is flagged, anyone may separate that part, and a keeper pass does it. After that the loan the other lenders hold has no part belonging to the flagged holder, and the flagged holder's loan is an ordinary one-lender loan under the existing rules for a flagged lender. Whether separation must happen at the moment of the flag or only be available is a question outside engineering; the design supports both, and the pass ships disarmed.

## 10. What this changes in work that is designed or in flight

| Work | Effect |
| --- | --- |
| The borrowing (#3808) | Still wanted: it is the home for settings and reserves, and for loans a borrower gathers that were opened at different times or that were separated. An instant borrow would open one loan in it instead of several. Its bound on the stored list counts parts, not loans (rule 9), so a separated part's loan joins the same borrowing without passing the bound. The conditions of its section 9, already reviewed, are the ones a loan's parts are sold under, except that the loan's one test decides when the sale is open (rule 4). The joint close-out itself is then needed only for loans opened at different times. |
| A loan made from terms in the same call (#3851) | Still needed. It is the opening path this design builds on. |
| Loans that store once what is identical (the lighter alternative) | Replaced by this design, which stores it once by having one loan. |
| The lending balance (#3811) | Unchanged. A part draws from its lender's lending balance as a loan does. |
| The instant market's fill bound | Becomes the bound on parts (rule 9), measured again. |
| The rate auction (#3758) | The bids one settling transaction settles become parts of one loan. The auction's limits, its settling a few at a time and its retry are unchanged (section 5). Its loans still have to fit the borrowing's bound, which counts parts, so that open item of `BorrowingDesign.md` stands as it is. |
| Takeover, notice to leave, the advance on a lender position, the backstop's purchase | Unchanged routes, reached through separation. |
| The due-date plan (#3785) and standing instructions (#3681) | Unchanged for the borrower. The renewal step handles a part that will not continue by separating it. |
| The shortfall reserve | Reads a part's shortfall as it reads a loan's. |
| A dated end for a fallback (#3865) | Applies per loan, unchanged: a loan in the fallback state has one part. |
| Indexer, apps, keeper | A loan lists its parts. Lender views are per part. The keeper gains the separation pass. |

## 11. What it costs

- **A change to the loan core before the audit.** The seam touches every path that pays or reads the lender side. It is done once, behind tests that must not change, but it is the largest single change to the core since the loan record was written.
- **Work in flight.** The Auto-lend, lending-balance, borrowing and cash-out builds assume one lender per loan. The seam step is designed so they do not have to stop: a loan with one part behaves exactly as today. Step 2 then changes only the opening paths and the part-aware steps.
- **More code in every close-out.** Each walks the parts. The bound on parts (rule 9) is what keeps the costliest of them inside one transaction.
- **Downstream.** The indexer's loan rows, the apps' loan and position views, statements and the public data feed all gain parts.
- **Audit surface.** Division and rounding among parts, and separation, are new and need their own review.

## 12. Limits, stated

- **One health figure for the test, and each part's own figure beside it.** A health-factor liquidation is tested on the loan's totals. Each part also has its own figure, from its own debt and collateral, and the loan's figure always lies between the lowest and the highest of them. So a part may be sold in the loan's liquidation before a loan of its own would have been, or after: with parts at 1.1 and 0.8 and the loan at 0.95, the part at 1.1 is sold with the other, and with parts at 1.3 and 0.9 and the loan at 1.05, the part at 0.9 is not sold by the loan's liquidation. That part can still be liquidated alone, on its own figure, by the step that separates it (rule 4). The parts' figures move apart in two ways. Interest accrues at different rates until it is paid: for a difference of 1% a year, after 30 days, that is 0.08% of the debt. And a forced sale takes from each part by that part's own plan, which can leave a lasting difference in principal and collateral that a later interest payment does not remove: a periodic sale takes more collateral from the part owed more interest. A partial liquidation works the other way, since it brings every part to the same target. No fixed bound on the difference is promised. The lender's view, and the review before a separation, show the part's own figure.
- **A separated part has its own health figure.** It is the figure a loan of its own would have had at that moment, worked out from that part's actual debt and collateral, so it may be below the loan's for one part and above it for the rest. A part separated when the loan was just above its liquidation level may itself be below it, and can then be liquidated on its own. Separation does not create that position: it is where the separate loan would already have stood (rule 7).
- **One sale, usually.** A larger sale moves the price more than a small one. A part may recover slightly less than its loan would have recovered sold alone and first. The same limit is stated for loans sold together in `BorrowingDesign.md` section 9, and the same answer applies: each part is checked against its own floor, and a part can be sold alone. For that reason the borrower may also see parts sold one at a time, as a borrower with several loans can today. One liquidation is what a caller will usually choose, because it costs less gas. It is not promised.
- **A lender does not choose the other lenders.** Nothing passes between them, no one's result depends on another's part (rule 4), and any holder can separate at any time.
- **A lender cannot wait while others are liquidated,** unless it separated beforehand. On a loan of its own it could not wait either: liquidation is open to anyone.
- **Separation costs gas** to whoever asks for it.

## 13. Tests

1. **Equality.** For generated sequences of steps (repay in part and in full, pay interest, add and withdraw collateral, liquidate in part and in full, settle a period by a sale, default, extend), with parts at different rates, a loan with N parts and N separate loans opened with collateral in proportion, each given every step at the same moment and the same sale price in the amount rules 3 and 4 give its part, end with the same amount for every lender, the borrower and the treasury, to the rounding rule of section 4.
2. **Separation moves nothing.** Separating any part at any point of such a sequence moves no money; the two loans' principal, interest owed and collateral sum to the original's; and the original's health figure lies between the two loans' figures. Applying the rest of the sequence to both loans changes no one's final amount. A step that separates and then reverts leaves the loan as it was.
3. **Isolation.** With one part's vault refusing the token, and with one part's holder flagged, every step completes for the borrower and for every other part; the refused or locked amount is exactly that part's.
4. **Booking by part.** In a sale that leaves one part short and another with a surplus, the surplus goes to the borrower and the short part stays short.
5. **Sums and limits.** After every step the parts' principal, collateral and interest owed sum to the loan's. No division pays a part more than it is owed or takes more collateral than it holds, including for parts of very unequal size (principals of 100, 100 and 1 with a repayment of 200).
6. **The seam, step 1.** Every existing test passes unchanged with one part.
7. **Bound.** At the bound on parts, the costliest step is inside 80% of each network's limit, measured on the CI toolchain.
8. **A sale of one position token** moves that part's records and no other's.
9. **Forced sales with parts at different rates.** A partial liquidation sizes each part from its own plan and leaves every part at the same target. A periodic sale with shortfalls of 1 and 9 on two parts of equal collateral pays each lender its own shortfall, takes the collateral from each part by its own plan, and returns no surplus to the borrower while a lender is short. A withdrawal of surplus collateral is refused when it would leave any one part below the level a loan must keep. The next repayment, top-up and sale still satisfy tests 1 and 5.
10. **A sale that finds no route.** A forced sale of a loan with several parts that finds no working route reverts, moves nothing and records nothing toward the fallback. A part is then sold alone: it is separated, and only its own loan can enter the fallback state, under its own gate. A part whose own sale works is paid in cash while another part's loan is in the fallback state, and that loan's borrower can still cure it.
11. **At the borrowing's bound**, a loan with N parts counts as N; separating a part is never refused by the bound, and an add or a gather that would pass it is refused as today.
12. **An auction settled over several transactions** opens one loan per transaction, each inside the bound on parts and every part at the clearing rate, whatever rate its bid offered; a bid skipped in one transaction and settled in a later one is a part of the later loan.
13. **The loan's test, not the part's.** With parts at health figures of 1.1 and 0.8 and the loan at 0.95, the loan's liquidation is open, no part is refused for its own figure, each part is sold by its own plan, and a partial liquidation takes nothing from a part already at the target. With parts at 1.3 and 0.9 and the loan at 1.05, the loan's liquidation is refused, and the part at 0.9 can be liquidated alone: it is separated, and its own loan passes its own test.

## 14. Open items for the builder to raise, not decide silently

1. Whether the position token of a separated part keeps its id (bound to the new loan) or is replaced.
2. The borrower position on separation: a second token for the new loan, held by the same holder, in the same borrowing. The bound on the borrowing's list already counts the part (rule 9), so the new loan takes the place its part held. A holder with no borrowing gets a loan with none, as any loan today.
3. Where the seam library's one runtime copy lives, given the facets near their size limit.
4. The reward record and the fee discount at entry, per part.
5. The guard that only named steps may write a loan's start and term: separation copies them and must be named there.

## 15. Alternatives considered

- **Keep one loan per lender, with the borrowing over them and #3851** (as planned today). No core change. About 4 and about 8 lenders per borrow by the estimate, 8 loans for the borrower, and the borrowing's machinery to make them read as one.
- **Loans that store once what is identical.** Lighter than this design, estimated at 1.3 to 1.5 million gas per further lender. The borrower still holds 8 loans, 8 liens and 8 liquidations.
- **A shared loan without separation.** Every lender route (sale, takeover, notice, advance, the backstop's purchase) would be rebuilt per part, and a flagged lender could not be removed from the loan.
- **An undivided interest in one lot,** the shape ruled out on 2026-11-19. Lenders would share a result. Rule 4 is the difference.
- **One position token for all lenders,** split by amount. A lender could not sell or be locked alone without a second token kind for the units.
- **Hold the lenders' money first, open the loans afterwards.** A third state for a lender's money, and a borrower locking other people's money.
- **One rate for every lender.** Section 6.

## 16. Recommendation and order of work

Build it, in this order, and decide the last step on a measurement.

0. **A measured trial of the opening path** (one loan, 8 parts, from slots) on the CI toolchain, on a branch that is not merged. It replaces the 9 million estimate with a number. If it does not reach 8 lenders inside 80% of the smaller limit, the design is not worth its cost and the planned route stands.
1. **The seam with one part.** A refactor with no behaviour change, worth having whatever is decided next: it puts the lender side's rules in one place before the audit.
2. **Parts, separation and the part-aware steps,** with the property tests of section 13 and an adversarial review of its own.
3. **The opening paths** (instant borrow, then the auction's settle, one loan per settling transaction, and a request filled in one transaction), the keeper's separation pass, the indexer and the apps.

Step 0 can start beside the builds in flight. Steps 1 to 3 need the owner's decision.
