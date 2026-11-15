# Secondary debt market — design

**Status:** owner approved the shape, 2026-11-15. Card #3667. Design first, no code yet. Builds on the lender sale routes (#1209, #1780, #1841, #1922), the borrower hand-over and offset, the standalone position record (#3205), the transfer cooldown (#3413), the position lock (#3318, #3339), the claim route for payouts (#3629), the instant market's takeover (#3656) and the narrow mandates (#3353). Reaches a chain by fresh deploy.
**Related:** `InstantMarketDesign.md`, `LenderPayoutsThroughClaimDesign.md`, `VaultOutflowPolicyDesign.md`, `MarketLinkedRateLimitsDesign.md`.

## 1. What already exists

A position, lender side or borrower side, is a token in a standalone record. It moves freely, wallet to wallet or on any marketplace, and every payout, claim and right follows whoever holds the token when the action happens.

| Need | Route today |
| --- | --- |
| Lender leaves, inside the platform | Sell into a standing lender offer in one transaction; or list the loan with a mandatory expiry. The seller's earned interest becomes a seller claim, the seller pays the rate shortfall when the buyer's rate is higher, and the sale is bound to the figures the seller reviewed. |
| Lender leaves at face value | The instant market's takeover (#3656). |
| Borrower leaves | Hand the obligation to a replacement borrower; offset with a new offer; refinance; repay early. |
| Either side trades outside | A plain transfer of the token. |
| A stuck lender position | The backstop buys at par under its own rules. |

Guards that already hold for every transfer, inside or outside:

- A token may not move in the block value left its position, nor for the cooldown after it. So a seller cannot empty a position and sell it in the same moment.
- A route started by a former holder (a listing, an offset, a refinance request, a collateral listing, a swap-to-repay order) cannot complete once the token has moved. Anyone may cancel it.
- No token moves into or out of a sanctions-flagged wallet.
- A holder may lock a token; a locked holder may still sell with the proceeds landing in their own vault under the payout delay.
- A plain transfer of a lender token records the lower of the fee-discount standings (#3562), so a transfer cannot be used to gain a discount.

## 2. What each token is worth

- **Lender token:** the right to be repaid. Worth about what is owed (principal outstanding, interest earned and unpaid, anything held for the position), limited by what the collateral covers.
- **Borrower token:** the right to repay the debt and take the collateral back, and to any surplus after a forced sale. Worth about the collateral's value less everything owed. The borrowed amount stays with whoever borrowed it; the token carries the collateral and the debt.

A borrower token's worth can fall to nothing and never below: the loan is secured by the collateral alone, with no claim on any person, so a holder may walk away. That is also why the lender does not care who holds it. When a sold borrower position defaults or is liquidated, the lender is paid from the collateral first as always, any surplus goes to the holder at that time, and the buyer has lost at most the price paid. Both tokens therefore stay freely transferable.

## 3. What is missing

1. **No rule about a position token used as collateral.** Nothing refuses it and no flow was designed for it.
2. **A lender can sell only into a posted lender offer or a listing.** Idle Auto-lend funds, the deepest source of buyers, cannot buy a loan at a price.
3. **No common price language.** Each route states its own figures.
4. **An outside buyer has no authoritative figures.** Marketplaces show metadata; nothing tells a buyer what the position is worth now or what could make a purchase go wrong.
5. **Standing permissions can outlive a transfer** (part tracked in #3353).

## 4. Part A: position tokens are refused as collateral and as deposits

Until pledging is designed on purpose (section 8), the platform refuses its own position tokens:

- as the collateral asset or the lending asset of any offer, intent or loan;
- as a rental asset;
- as a plain vault deposit.

One check, in the one place assets are admitted, with a named error. The position record's address comes from the protocol registry, never from a setting. A token already in a vault by a direct transfer the platform could not refuse is not counted as backing for anything and may be withdrawn by the vault's owner under the outflow policy.

## 5. Part B: selling a lender position at a price to Auto-lend

An Auto-lend slot gains one consent, **buys existing loans**, separate from the instant market's takeover consent (which stays face value only).

- **What may be bought:** the lender side of an active loan with interest by time, not past due, not in a fallback, with no other sale route open, nothing held for the position, outside the transfer cooldown.
- **The as-new test** of `InstantMarketDesign.md` section 7 applies to everything except the rate: the loan must be one the slot would open today in kind of loan, cap and floor, lifecycle settings, current loan-to-value, health factor, due date inside the slot's longest term and lend-until, and room in the slot's exposure. A weakening loan cannot be passed on. The rate is judged through the price, below: what the slot must earn is its minimum **at the price it pays**, not the loan's stated rate.
- **Price:** one figure, the **price in basis points of the outstanding principal**, never above par. The highest price a slot pays is set by rule and not by hand:
  - a loan whose rate (fixed) or margin (floating) is at or above the slot's minimum: par;
  - a loan below the slot's minimum: par less the interest the slot would miss over the remaining term, so that the slot's return to the due date at that price is at least its minimum. This is today's rate shortfall, stated as a price.
- **No premium, by design.** A slot never pays above par. Interest is owed by time and the borrower may repay at any moment, so a price above par would be paid for interest that an early repayment removes: a seller and a cooperating borrower could sell a high-rate loan at a premium and repay it at once, and the buyer would lose the premium. At or below par an early repayment can only leave the buyer better off, since the full principal comes back sooner. A lender who wants more than par for a high-rate loan uses a listing, where a buyer chooses that risk by hand and the review states it.
- **The seller** states the lowest price they accept and a mandatory deadline, and the sale is bound to the reviewed figures exactly as the direct sale is today (seller's least net, most held balance, deadline).
- **What moves:** the buyer's vault pays the price into the seller's vault, measured on arrival. The position moves on the same loan record through the existing lender-position migration. Interest earned to that moment follows the existing seller-claim rule. The borrower signs nothing, pays nothing, and none of their terms change. No initiation fee: no loan is opened. Any fee on the sale is the existing sale fee rule, unchanged.
- **Who starts it:** the holder, or a keeper under the holder's mandate for this one action. A keeper never sets the price: it may only execute at or above the holder's stated floor (#3353).
- **One sale host.** This is the direct sale with a slot as the buyer, not a new settlement path. The opening checks stay in the one sale-exit verdict, so the app's chooser and the entry cannot drift.

A borrower-side equivalent is not added: a borrower who wants out already has the hand-over, which installs the new borrower's terms and makes the lender whole.

## 6. Part C: one price language

Every surface that offers, lists or previews a position for sale states the same figures, from one read:

| Figure | Lender position | Borrower position |
| --- | --- | --- |
| Basis | Outstanding principal | Collateral value now, and everything owed now (principal, interest, late fees) |
| Price | In basis points of principal, and as an amount | An amount, and as a share of collateral value less owed |
| Return | The buyer's return to the due date at that price, for a fixed loan; for a floating loan, the margin over the reference | Not stated |
| Time | Days to the due date; renewal state | Days to the due date; grace period |
| Safety | Loan-to-value, health factor, liquidity tier of both assets | The same, plus the price at which liquidation begins |
| In the position | Claimable now, held for the position, seller claims ahead of the holder | Surplus held, collateral under lien |
| Blocks | Cooldown end, lock state, open routes, past due, fallback | The same |

A "reference worth" may be shown for a fixed lender position once the market reference rate exists (#3337): the price at which the loan's remaining interest equals today's reference for that term. It is labelled as an illustration, never as a quote, and it sets no price.

## 7. Part D: outside trades

The platform cannot stop or see a sale made elsewhere, and does not try. It makes such a sale safe to price.

1. **One public read, `positionWorth(tokenId)`,** returning the figures of section 6 and every reason the token could not move or be claimed now. It is a view on its own facet, built from the reads the settlement paths already use, so a marketplace, an aggregator or an outside lending platform quotes the same numbers the platform acts on. Where a figure cannot be known (a missing price, an undeterminable age), the read says so; it never returns a guess.
2. **Metadata** carries the same figures and a link to the check page. Metadata is a picture; the read is the authority, and the page says so.
3. **A "check before you buy" page** in the app for any token id, without connecting a wallet: the figures, the blocks, and plain warnings. For a borrower token: "This position can become worthless if the collateral's price falls or the loan is not repaid in time. Watching it is the holder's duty." For a lender token: "If the borrower does not repay, you are paid from the collateral, which may not cover what is owed."
4. **What a plain transfer does and does not do,** stated on that page: it splits no interest (the new holder receives everything that later arrives, so the price should include interest already earned); it runs no solvency check on the loan; seller claims recorded by earlier platform sales are paid before the holder; the fee-discount standing is the lower of the two.
5. **Standing permissions lapse on transfer.** Anything the former holder set that lets someone else act, or lets the loan change by itself, stops when the token moves: keeper mandates, renewal and refinance limits, auto-list settings, alert subscriptions. The test is a **holder epoch** kept per loan side, which only rises: it advances on every transfer of that side's token (through the record's transfer check) and on every platform step that hands the side to a new token (a lender sale's migration, a takeover, a borrower hand-over), since a new token's own transfer count starts again at zero and so cannot be the test alone. A permission notes the epoch when it is given and is honoured only while the epoch is unchanged. A side that goes away and comes back, by any route, has a higher epoch, so nothing revives. The new holder starts with nothing switched on. (Keeper mandates: #3353. This design makes it the rule for every such setting and adds the tests.)
6. **The backing follows the token.** The borrower's collateral, or the lender's parked proceeds, consolidate to the new holder's own vault, still under the loan's lien, as the spec already requires.
7. **A token held by a contract that cannot act** (an outside marketplace's or lending platform's custody) loses nothing: payouts wait in the position as claims and collateral stays under its lien until a holder who can act claims. The page says that nobody watches a borrower position's health while it sits there.
8. **A token wrapped by an outside service that issues its own shares.** The platform knows one holder per position: the address the position record names. It pays that holder the whole claim and never splits a claim by anyone's shares, because it cannot see them and does not recognise them. Dividing what arrives among share holders is the wrapping service's own work. In practice there are two shapes. A service built to act can call the claim itself and share out what it receives. A service that only holds the token cannot claim, so item 7 applies: the claim waits, whole, until the shares are redeemed and a holder who can act takes the token out and claims. The check page states both, and that the platform has no duty to, and no way to, pay a share holder directly. Nothing is built for this; splitting a claim inside the platform is the separate, parked "selling part of a position" (section 12).

Pledging a position on an outside platform therefore needs nothing from this platform beyond the read in item 1.

## 8. Later stage: pledging a position inside the platform

Not built now. It stacks one loan's risk on another, and it should follow a working sale market. Recorded here so that the flows are known when it is taken up, and so Part A's refusal is lifted deliberately.

- **Only a lender position, only on a loan whose two assets are top tier.** A borrower position is never pledged: its worth is the first thing a price fall removes.
- **No chains.** A position whose own loan is secured by a pledged position cannot be pledged.
- **Value** is the platform's own figure with a discount: the lower of the outstanding principal and the underlying collateral's value, less a haircut. Never a market price.
- **While pledged,** nothing may leave the position: repayments and interest arriving for it stay under the pledge's lien, claimable by nobody, and count toward the pledge's health. A full repayment of the underlying loan turns the pledge's collateral into the repaid asset, still under lien.
- **Routes on the pledged position** (sale, takeover, extension, renewal consent) are refused, or need the pledgee's consent recorded on-chain.
- **Default on the pledge** hands the position itself to the pledgee, with everything held under it. It cannot be swapped, so there is no sale route; the pledgee then holds a loan and its rules.
- **Default of the underlying loan** settles as usual into the position, under lien.
- **Out of scope for the shortfall reserve**, and no fee discount is earned through a pledged position.
- Both sides consent to it as they do for any asset without a market price.

## 9. What cannot be gamed

- **Emptying before selling:** the cooldown, on every marketplace.
- **Selling a weakening loan to Auto-lend:** the as-new test.
- **A keeper selling cheaply:** it cannot set or lower the price.
- **Trading with yourself to move a price or a figure:** the price is between two parties' own stated limits, the platform publishes no last-sale price as a reference, and fees are paid on both sides.
- **A buyer inheriting a former holder's switches:** they lapse on transfer.
- **A stale picture:** the read is live; metadata is not the authority.

## 10. Contract and off-chain changes

| Where | Change |
| --- | --- |
| Asset admission | Refuse the position record's tokens (Part A). |
| Lender intent | The "buys existing loans" consent. |
| Direct sale | Accept a slot as the buyer; price rule in one library shared with the preview; par or below. |
| Sale-exit verdict | Covers the slot route. |
| New view facet | `positionWorth` and its refusal list. |
| Permissions | A holder epoch per loan side, advanced on transfer and on migration; every standing setting notes it and lapses when it changes. |
| Metadata | Figures of section 6. |
| Keeper | A sale pass under mandate, shipped disarmed; cancels of moved routes already exist. |
| Indexer and app | For-sale book, the price language on every sale surface, the check page, lapse notices to the new and the former holder. |
| Permissionless-steps ledger | Rows for any new open step. |

Design for a fresh deploy. Check facet sizes with the deploy-sanity suite; `positionWorth` is a new facet, not added to one near its limit.

## 11. Tests

1. A position token is refused as collateral, lending asset, rental asset and deposit, with the named error; one sent directly backs nothing and can be withdrawn.
2. Sale to a slot: the as-new test each way; the price rule at par and below, with the slot's return at the price never under its minimum; a price above par refused; an early repayment straight after a sale never leaves the buyer with less than was paid; the seller's floor, held ceiling and deadline; price measured on arrival; the seller claim paid first from the next interest; exposure taken; the borrower's terms unchanged; every refusal (past due, fallback, cooldown, something held, another route open, the borrower's own slot, full-term interest).
3. The preview and the settlement use one computation: a quote and its fill agree to the unit.
4. `positionWorth` equals what a claim, a repayment and a forced-sale preview would pay at that block, for both sides and every status; an unknown figure is reported as unknown.
5. Every standing permission stops at a plain transfer, at a platform sale, takeover or hand-over that mints a new token, and stays stopped when the same holder buys the position back by any route.
6. A transfer to a contract that cannot act loses nothing; a later holder claims everything.
7. A keeper under mandate cannot sell below the holder's floor.

## 12. Alternatives considered

1. **Restrict transfers of the borrower token.** Rejected: the lender is indifferent to who holds it, a wallet can be sold or wrapped anyway, and the hand-over would lose its purpose.
2. **An on-platform order book with free prices for every position.** More than is needed: Auto-lend limits already express what a buyer will pay, and a second book splits liquidity.
3. **A published price for positions, used by the platform.** Rejected: thin markets are easy to move, and nothing in the platform should act on one.
4. **Pledging first.** Rejected for now: section 8.
5. **Leave outside trades to marketplaces' own metadata.** Rejected: the buyer's main risk is a wrong price, and only the platform can state the true figures.
6. **Selling part of a position.** Useful for large loans, but it touches every settlement path. After the refactor and audit.

## 13. Recommendation and order of work

1. Part A, the refusal. Small, and it closes an undefined case.
2. Part D items 1 and 5: `positionWorth` and the lapse of standing permissions. They make every transfer that already happens safer.
3. Part C in the app, and the check page.
4. Part B, the sale to Auto-lend, after the instant market's takeover exists, as the same host with a price.
5. Section 8 only by a later owner decision.

## 14. Open items for the builder to raise, not decide silently

- Which existing per-loan settings are keyed by loan and not by holder today, and so need the holder-epoch note; and whether routes (listings, offsets) should move from the transfer count to the same epoch.
- For a listing sold above par by hand, the review must state that an early repayment loses the premium.
- How a floating loan's price is stated: this design gives the margin over the reference and prices only the margin difference.
