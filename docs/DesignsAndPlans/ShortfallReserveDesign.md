# Shortfall reserve — design

**Status:** direction approved by the owner, 2026-11-15. Card #3641. Build after the external audit and the mainnet deploy; the fee split that fills the reserve ships with the mainnet deploy so it collects from the first day. Section 11 lists the decisions still open.
**Related:** the treasury-seeded backstop (roles A and B, functional spec), `ForcedSaleSizingDesign.md` (sell to need, lender first), #3640 (missing-price fallback wait), #3629 (every loan payout goes through the position claim).

## 1. What this is, and what it is not

A reserve, filled from a fixed share of the fees the platform already collects, that pays **part of a lender's measured loss** on a small, defined set of close-outs, by published rules, automatically, while funds last.

It is **not insurance**. Nobody pays a premium for it, nothing is promised, no claim can be made or argued, and no person decides who is paid. The words insurance, insured, cover, guarantee and protected are never used for it, in the app, the docs, the site or the contracts (section 9). Whether a rule-based reserve of this kind raises a licensing question anywhere is on the private legal-review list and is answered before it is switched on.

## 2. Why a reserve fits this platform

Every loan here is between one lender's vault and one borrower's vault. There is no pool, so a loss is never shared: when a forced close recovers less than the principal, one lender carries all of it. Pooled lenders spread that loss across every depositor, or absorb it from pool reserves. A reserve is the only way a single-lender design can soften the same event without pooling anyone's funds.

## 3. How this is commonly handled elsewhere

Stated generically; no platform is named in the repository.

| Approach | Who pays for a loss | Decided how |
| --- | --- | --- |
| A share of interest accrues to protocol reserves | The reserves, if governance votes to use them | Discretionary vote |
| A surplus buffer from fees, then new governance tokens are sold | The buffer, then token holders | Automatic auction |
| Users stake assets as first-loss capital and are paid for the risk | The stakers, cut automatically when a measured deficit passes a threshold | Automatic, on-chain |
| Isolated markets with no reserve | That market's lenders, at once and in proportion | Automatic |
| A pool that buys liquidated collateral at a discount | Pool depositors, who receive the collateral | Automatic |
| An exchange fund fed by liquidation fees, then forced position reduction | The fund, then profitable traders | Automatic |
| A separate mutual that sells cover | Its members, after a member vote on each claim | Discretionary, legally wrapped |

What carries over: nobody sound promises payment; the automatic designs pay only what the chain itself can measure; reserves are fed from fees; and a payout rule that can be front-run or drained in one event is the usual failure. What does not carry over: paying users to stake first-loss capital (a return for taking risk, which the tokenomics rules exclude) and member-voted claims (discretion, and a legal wrapper).

## 4. What the reserve pays, and what it does not

### 4.1 Paid automatically (measured by the protocol itself)

1. **A forced sale that recovered less than the principal.** A health-factor liquidation, a time-based default or a periodic-interest sale that sold everything and still left principal unpaid.
2. **A priced in-kind fallback where the lender took all the collateral and it was worth less than the principal**, measured as the principal left unpaid at the lender's terminal claim.

In both, the measured loss is **principal only**: unpaid interest, late fees and the fallback charge are not counted.

### 4.2 Already handled another way

- **A liquidation that cannot sell** (no route, abnormal market) while the collateral is still worth the debt: the backstop's cash exit (role B) pays the lender in cash and warehouses the collateral. That is a liquidity service, not a loss, and it stays as it is.
- **A borrow request nobody fills:** the backstop's role A.

### 4.3 Not paid by rule, and why

| Event | Why not automatic |
| --- | --- |
| Missing-price fallback (lender takes all, #3640) | No price, so no measured loss. |
| NFT and unpriced collateral | Never priced; both parties consented to in-kind transfer. |
| The lending asset loses its peg | The loan was repaid in the asset agreed; there is no shortfall under its terms. |
| A token issuer freezes or blocks an address | Not a market loss; the held-in-vault route (#3396) already keeps the due intact. |
| A borrower liquidated at a poor price within the slippage floor | Bounded by the sale floor; no measured wrong. |
| A wrong price, a faulty facet, a platform-wide attack | Cannot be measured by a rule. See 4.4. |

### 4.4 Extraordinary distribution

For an event outside 4.1 (a platform fault or attack), governance may propose a distribution from the reserve. It waits the Timelock delay like any other treasury action, must name an on-chain-computable set of recipients and a proportional formula, and is published before it executes. It is never promised in advance, and the app never refers to it as something a user can rely on.

## 5. Eligibility for an automatic payout

All must hold; each is read from stored loan data, never supplied by a caller.

- The lending asset and the collateral asset were both in the top liquidity tier, by the same tier rule the platform already applies (depth, keeper and peer tiers), when the loan opened.
- The loan had been open at least 7 days when the close-out began.
- The loan opened at or above the minimum health factor (true of every loan today; stated so a later change cannot widen eligibility silently).
- The lender is not the backstop, and lender and borrower are not the same address.
- The loss is final: the forced sale has settled, or the fallback's lender has made the terminal claim within the round's finalisation window.

## 6. How a payout is computed and paid

Per lending asset, in weekly rounds.

1. **The round is fixed by the close-out event.** A loss belongs to the week in which its close-out happened: the forced sale's settlement, or the entry into the priced fallback. That time is already stored on the loan, cannot be chosen afterwards, and is the only thing that decides the round.
2. **Only a final loss is recorded.** A record is written once, when the loss can no longer change, and counts in its round's running total from that moment:
   - *Forced sale:* at the sale's settlement. The loan is closed and the unpaid principal is final.
   - *Priced fallback:* at the lender's terminal claim, which every recovery route ends in (a cure, a retry sale, a full or partial internal match, proceeds held for the lender). The record is the principal actually left unpaid then, with collateral the lender received valued at the **higher** of its price in the fallback's stored entry snapshot and its price at the claim, so waiting for a dip in the price before claiming cannot enlarge the record. A fallback that was cured or rescued in full never produces a record, and nothing has to be undone because nothing was recorded.
   The record states the loan, the asset, the round and the eligible amount: `unpaid principal × share`, where the share is 50% (governance-bounded 25 to 75%), capped per loan and, through a running total, per lender-position holder per round, by per-asset caps. No caller can add a record.
3. **A bounded window to finalise.** A round stays open for records for 14 days after its week ends (bounded 7 to 30). A fallback whose lender has not made the terminal claim by then gets no record: the lender chose to keep waiting, and a closed round is never reopened. So a lender can neither pick a round nor join a later one; the only choice is to finalise in time or not.
4. **Close the round.** A round is closed by a transaction anyone may send once its finalisation window has ended (keeper-backed), and rounds close strictly in order. Closing is one fixed-cost step: it computes the budget as 10% (bounded 5 to 20%) of the asset's **uncommitted** balance, which is the reserve balance minus everything earmarked for earlier rounds not yet paid, earmarks the lesser of that budget and the round's eligible total, and stores the round's **payout ratio** (earmark divided by eligible total, at most one). Being first gains nothing, and one bad week cannot empty the reserve.
5. **Delay.** A round's payouts open 7 days after it closes. Until a record is paid the guardian may **cancel** it (its share of the earmark returns to the uncommitted balance, an event states the reason; other records' ratio is unchanged). The guardian can never add a record, raise an amount or name a payee.
6. **Pay, one record at a time.** After the delay anyone may pay any single record (keeper-backed, ships disarmed): `eligible amount × the round's ratio`, marked paid so it cannot be paid twice. No step ever loops over a round's records, so a round with any number of records stays payable. The payment goes to the address that made the loan's terminal lender claim, into its own vault through the vault outflow policy, in the lending asset, from that asset's reserve balance only. For a forced sale whose lender has not yet claimed, the amount waits, earmarked, and is paid when they do. A flagged payee's amount is held for them under the existing close-out freeze rule, not redirected.

Because every closed round holds its own earmark, a late close or a late settlement changes nothing: no later round is sized against funds an earlier one was allotted, and rounds may be settled in any order. A cancelled record releases its part of the earmark back to the uncommitted balance. Conversions (section 8) and an extraordinary distribution (4.4) may spend the uncommitted balance only.

A shortfall is paid once, from one round. Nothing carries forward to a later round: an underpaid round stays underpaid, which is what makes the reserve impossible to drain by repetition.

## 7. Why this cannot be gamed

- **Lender and borrower acting together.** Two wallets can open a loan and let it fail, but the loss they share is real and the reserve returns at most half of it (the share), so the pair always ends worse off. They also cannot cause the loss: both assets are top tier, priced by the multi-source guard and sold to need on the open market.
- **Inflating a thin token.** Excluded by the tier rule on both assets, at origination.
- **Opening loans into a crash.** The 7-day age rule; and partial payment keeps the lender's own money at risk.
- **Racing or draining.** Proportional rounds, a fixed slice per round, no carry-forward.
- **Fabricated claims.** There are no claims. Records are written only by the settlement, from the figures it has just booked.
- **Buying a failing position to collect.** The buyer pays for the position and takes the loss; the reserve pays at most half of a loss the buyer really bears.
- **Insider discretion.** The guardian can only cancel; governance can only change bounded settings behind the delay, and a change never applies to a round already closed.
- **Careless lending because a reserve exists.** Partial payment, top-tier assets only, principal only, per-loan caps.

## 8. Funding and custody

- **Source.** A fixed share of every fee the treasury fee host collects (the loan initiation fee, the treasury share of interest and the other fees it measures) is routed to the reserve at the moment of collection, in the asset it was paid in. Proposed share: half (bounded; changes wait the Timelock delay and never touch fees already collected). See open decision 11.1 for how fee discounts interact.
- **One place.** The split happens once, inside the fee host, so every fee path inherits it and none can skip it. Events state the amount to treasury and the amount to reserve.
- **Custody.** The reserve is its own contract with its own vault, holding treasury-origin funds only, never user deposits and never inside the Diamond. Per-asset balances; a shortfall in an asset is paid only from that asset's balance, so no price is needed to pay.
- **Conversions.** Moving reserve funds between assets uses the existing treasury conversion route behind the Timelock delay.
- **Target and activation.** Records start to be written for an asset once governance activates it, which requires the asset's reserve to be at least 2% of that asset's open principal (bounded 1 to 10%). The owner's first figure, half of active loans, is far above what over-collateralised lending needs and would delay activation for years; see 11.2.
- **No return is paid on reserve funds to anyone,** and the reserve is not tied to the platform token.
- **Transparency.** Views report, per asset: balance, open principal, the current round's recorded shortfalls and budget, and every past round's totals. The app shows them on a public page.

## 9. Wording rules (part of the release gate)

- Name: "shortfall reserve" (app label may be "Reserve"). Never insurance, insured, cover, coverage, guarantee, protected, safe or risk-free.
- Describe it as: a reserve funded from platform fees that pays part of some measured lender losses on top-tier assets, by published rules, while funds last; no payment is promised.
- Never shown as a benefit when a user decides to lend: not on the lend form, not on an offer, not beside a rate. It appears on its own page, in the risk disclosure (as a statement that nothing is promised) and on a closed loan that has a record.
- A loan's page shows a record's state with what is known and what is not: recorded, the round, the eligible amount, the amount paid or the fact that the round is not yet settled. Never an expected payout before the round closes.

## 10. Contract and off-chain changes

| Where | Change |
| --- | --- |
| Treasury fee host | Route the reserve share at collection; events. Ships with the mainnet deploy. |
| Reserve contract (new, outside the Diamond) | Per-asset balances, rounds, records, settle, guardian cancel, bounded settings behind the delay, views. |
| Forced-sale settlement | Write the final shortfall record through the one shared step, when eligible. |
| Terminal lender claim | For a priced fallback, write the final record through the same shared step if the entry round is still open; for any record, name the payee. |
| Loan record | Tier of both assets at origination, if not already stored. |
| Protocol registry | The reserve's address as a delayed entry. |
| Keeper | Round settlement pass, disarmed; ops alert on a cancelled record and on a round paid in proportion. |
| Indexer and app | Reserve page, record state on closed loans, wording per section 9. |
| Permissionless-steps ledger | Row for round settlement. |

Tests: eligibility each way; principal-only measurement; share, caps and proportional rounds; no carry-forward; a lender who delays their claim stays in the round of the close-out and gains nothing; a round with thousands of records closes in one fixed-cost step and every record is payable singly, once; a fallback cured or fully rescued before its round closes leaves no record and does not dilute the round; a retry sale or a partial internal match is reflected in the amount recorded at the terminal claim; a fallback claimed at a price below its entry snapshot is recorded at the entry price; a fallback claimed after its round's window gets no record and cannot enter a later round; many rounds closed late and settled out of order each pay exactly their earmark and the earmarks never exceed the balance; a conversion or extraordinary distribution cannot touch earmarked funds; delay and guardian cancel (the record's earmark share is released, other records' ratio unchanged); a flagged payee is held; the fee split on every fee path; no record can be written by a caller; settings changes do not reach a closed round; a pair acting together always nets a loss; reserve never pays an asset from another asset's balance.

## 11. Open decisions for the owner

1. **How discounts meet the split.** The owner's first description was "the part of each fee above half of the undiscounted fee" goes to the reserve, which makes fee discounts come out of the reserve's share first; at the maximum discount the reserve would receive nothing from that fee. The simpler alternative is half of each fee as received. Recommendation: half of each fee as received, so the reserve fills at a steady rate whatever the mix of discounts.
2. **Activation level.** 2% of open principal per asset is proposed, against the owner's first figure of half of active loans.
3. **Share and round slice.** 50% of the shortfall and 10% of the reserve per round are proposed starting values.
4. **Legal review** of the reserve and its wording before activation (private list).

## 12. Alternatives considered

1. **Sell insurance or promise cover.** Rejected: a regulated activity in most places, against the near-zero legal posture.
2. **Users stake first-loss capital and earn for it.** Rejected: a return for taking risk, which the token and rewards rules exclude.
3. **Governance decides each payout.** Rejected for ordinary losses: discretion invites lobbying, insiders and delay. Kept only as the extraordinary route in 4.4.
4. **Pay shortfalls in full.** Rejected: removes the lender's own risk and makes two-wallet schemes break even.
5. **First come, first served.** Rejected: a race, and one event drains the reserve.
6. **One reserve in one asset, paid by price.** Rejected: adds a price dependency and a conversion at the worst moment.
7. **Grow the backstop instead.** The backstop buys positions at fair value and is refused below it by design; paying a real loss is a different rule and gets its own contract, so the backstop's "never below par" guard stays simple.
8. **Leave it to outside cover providers.** Users may always buy that themselves; it needs nothing from the platform and does not replace a reserve for the single-lender loss in section 2.
