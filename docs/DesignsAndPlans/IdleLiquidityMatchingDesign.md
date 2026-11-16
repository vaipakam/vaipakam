# Less idle liquidity — matching design

**Status:** direction approved (owner, 2026-11-15); three work items, each with its own card (#3621 item A, #3622 item B, #3623 item C, #3624 item D).
**Goal (owner):** an offer or an intent should not sit idle while a counterparty that would accept it is on the book.
**Related:** #3615 (pro-rata term match, PR #3617), `AutoLendLendUntilDesign.md` (#3618 end date, #3619 pro-rata intents), #2727 (lifecycle terms must agree), #3443 (terms-age rule), #3242 (keeper fairness walk).

## 1. Where compatible pairs fail to meet today

Scouted in the match core (`LibOfferMatch`), the intent fill (`OfferMatchIntentFacet`), the timing rule (`LibTiming`), the keeper matcher and the app's post form.

| # | Cause | State |
| --- | --- | --- |
| 1 | Terms had to be exactly equal | Fixed for pro-rata pairs by #3615. Keeper still groups by term (handed to the keeper thread). |
| 2 | Intents fill only full-term, no-partial-repay requests | #3619, built with #3618. |
| 3 | **Option flags split the book.** A pair matches only when partial-repay, prepay-listing and interest cadence are identical on both offers (#2727). A lender who would happily take either setting cannot say so. | **Item A below.** |
| 4 | A new offer waits for the keeper's next pass even when its counterparty is already resting | **Item B below.** |
| 5 | A maker whose offer is not matching is not told why | **Item C below.** |

**Not adopted, and why (so nobody rebuilds it):** the contract searching the book for a counterparty, or refusing a match because a better one exists. The search is unbounded in gas, needs a price and risk read per candidate, and anyone can block a match by posting a slightly better offer in the same block.

**Correction to an earlier suggestion.** "Match in the same transaction that posts the offer" is **not possible and not wanted**: the terms-age rule (#3443) forbids creating an offer and filling it in the same block, on purpose (self-dealing funded inside one transaction, reward farming, faked activity in the market-rate signal). Item B reaches the same result inside that rule.

---

## 2. Item A — a lender may accept either setting of a borrower-side option

### Rule

The loan takes its lifecycle terms from the borrower offer (unchanged). A **lender** offer may mark an option as "either":

- **Partial repayment: either.** Matches a borrower offer whether or not it allows partial repayment.
- **Prepay listing: either.** Matches a borrower offer whether or not it allows a prepay listing of the collateral.

For an option not marked "either", the two offers must still name the same value. The interest mode stays exact (it is the price model; #3615 governs terms within it). The rental-fee asset stays exact. **Interest cadence stays exact in this version** (it changes what the borrower must pay and when, and has its own admission rule); see open items.

Only the lender side gets the choice. A borrower-side "either" would mean the loan takes a value the borrower offer does not carry, which breaks the one rule that keeps every later path simple: the loan is a copy of the borrower offer it was built from.

### Consent and disclosure

- A lender who marks "either" has signed both outcomes. The lender's accept-side review and the offer page state it: "A match may open a loan that allows partial repayment" (and the same for a prepay listing).
- On a full-term offer, "partial repayment: either" has a cost the form must state: a partial repay pays only accrued interest on the repaid part. On a pro-rata offer it costs the lender nothing beyond what pro-rata already allows.
- App default: pre-select "either" for both options on a **pro-rata** lender offer, leave them exact on a full-term one. The user can change both. (Default choice is copy, not protocol.)
- Direct acceptance is unchanged: an acceptor takes the stored values of the offer it accepts.

### Contract changes

| Where | Change |
| --- | --- |
| `LibVaipakam.Offer` | Append `uint8 lifecycleFlex` at the tail (bit 0 partial repay, bit 1 prepay listing; other bits must be zero). Storage-layout guard `write`. |
| `CreateOfferParams`, `OfferCreateFacet` | New field; refuse it on a borrower offer, on a sale vehicle and on an NFT rental; refuse unknown bits. `OfferCreated`/`OfferCreatedDetails` state it. |
| `OfferMutateFacet` | Changing it is a change of terms: restamp the terms age. |
| `LibOfferMatch._lifecycleTermsAgree` | Per option: equal, or the lender's bit set. One place, so match, signed-offer match and every preview agree. |
| `LibSignedOffer` / `LibAcceptTerms` | The signed offer type and the acceptor's signed terms carry the field, so a signature binds it. |
| Intent slice (`OfferMatchIntentFacet`, `LibOfferMatch` preview twin) | Unchanged in this item. Whether an intent also takes prepay-listing requests is an open item. |

No fund movement changes. **Facet room (2026-11-15):** OfferCreateFacet 23,990 (586 bytes free) is the tight one; if the field does not fit, the validation belongs behind the existing `OfferBookFacet` self-call (5,302 bytes) rather than trimmed. Reaches a chain by fresh deploy (struct, params and event change).

### Tests

Equal values match as today; lender "either" matches both borrower values and the loan carries the borrower's; without the bit a differing pair is still `LifecycleTermsMismatch`; a borrower offer, rental or sale vehicle cannot set it; unknown bits refused; an edit restamps the age; preview and match agree on every case; a signed offer binds it.

### As built (2026-11-15)

Built as the rule above, with three differences from the change table, each because the code made the step unnecessary:

- **No mutate step.** `ModifyOfferParams` cannot change any lifecycle option, so the marks are fixed at creation like the options they qualify. There is nothing to restamp.
- **The acceptor's signed terms (`LibAcceptTerms`) are unchanged.** A direct accept takes the offer's stored values whatever its marks say, so the marks change nothing the acceptor agrees to. Only the maker's signed offer (`LibSignedOffer`, now 36 fields) carries them.
- **The admission check sits in `OfferBookFacet.openOfferOnBook`**, the step every creation already ends with, rather than in `OfferCreateFacet`, which had about 400 bytes of room. It refuses unknown bits (`LifecycleFlexUnknownBits`), and marks on a borrower offer, an NFT rental or any offer the protocol creates on a user's behalf (sale vehicles, the offset offer, intent slices) with `LifecycleFlexNotAllowed`. A signed order is held to it when it opens on the book, and the signed-order accept preview reports such an order as an unsupported shape.

The match rule (`LibOfferMatch._lifecycleTermsAgree`) reads only the lender offer's marks; a borrower offer's field is ignored there. `OfferCreatedDetails` states the marks. The indexer refuses marks on a signed borrower order at listing, and the new app's "why isn't my offer matching?" skips an option the lender takes either way. Neither app posts an offer with marks yet; the form and the offer page copy in "Consent and disclosure" are app work still to do.

### Alternatives considered

1. **Automatic for pro-rata pairs** (no flag, like the term rule). Rejected for now: a partial repay leaves the lender a smaller live loan to track, and a prepay listing is a consent to a collateral sale; both deserve an explicit choice.
2. **Borrower-side "either" too.** Rejected: the loan would need derived terms instead of copying the borrower offer.
3. **Drop the options from the match check.** Rejected: that is #2727's bug again, one side's choice silently overriding the other's.
4. **Post two offers, one per setting.** Rejected: double the locked principal and the open-offer count for one intent to lend.

---

## 3. Item B — a compatible counterparty is taken at once

Two parts, no contract change.

### B1. App: "take it now" at posting

Before the user signs a new offer, the post form asks the indexer for resting offers on the other side that the new offer would match (same pair, compatible term under #3615, overlapping amount and rate, agreeing options). If one exists, the form shows it first:

- what accepting it gives (principal, rate, term, collateral, fee), from the protocol's accept preview;
- next to what posting gives (waits for a match; a match lends at the midpoint of the two rate ranges).

The user chooses: **accept now** (the existing direct accept; the resting offer is already past its terms age) or **post anyway**. Accepting never happens without that choice, because a direct accept and a match price differently (an accept takes the resting offer's own terms).

### B2. Keeper: new and changed offers are looked at first

The matcher walks the whole book each pass. Add a short "fresh" lane ahead of the fairness walk: offers created or re-priced since the last pass are previewed against their bucket first, once their terms age has passed (5 seconds by default).

The lane must not take the ordinary walk's turn. The rotating walk exists so that every creator pair is eventually looked at even when a pass covers only part of the book, and a stream of new or repeatedly re-priced offers could otherwise starve it. So:

- **Hard quota.** The fresh lane may spend at most a fixed minority share of the pass (previews, submissions and wall time alike; a plain var, starting at a quarter). The rest is reserved for the ordinary walk whether or not the lane used its share.
- **Once per offer.** An offer enters the lane once for its creation. A re-price does not re-enter it inside a cool-off window, so re-pricing cannot buy standing priority.
- **Same fairness units inside the lane** (one unit per creator pair), so one wallet's burst of new offers is one unit.
- **Test:** under sustained fresh traffic larger than the quota, a resting pair elsewhere in the book is still previewed within the same number of passes as today.

Result: a new offer with a resting counterparty is matched on the next keeper pass, and the walk's eventual-progress guarantee is unchanged.

### Alternatives considered

1. **Create and match in one transaction.** Ruled out by #3443 (see section 1).
2. **The app silently accepts instead of posting.** Rejected: different price outcome than the user asked for; the user must see and choose.
3. **An on-chain "match on create" hook.** Rejected: unbounded search, and still blocked by the age rule.
4. **Shorten the keeper tick only.** Helps a little, costs RPC and gas on every pass; the fresh lane targets the same delay for almost nothing.

---

## 4. Item C — "why isn't my offer matching?"

For each of the user's open offers (and intents), the app shows the nearest counterparty and the single gap that keeps them apart, from indexer data plus the protocol's match preview for the final answer:

- **Rate:** "Nearest request pays up to 5.5%; you ask 6%."
- **Term:** "Nearest request is for 45 days; you lend up to 30."
- **Amount / collateral:** below the other side's minimum fill, or collateral short of the requirement.
- **Options:** "Requests on this pair allow partial repayment; your offer does not" (points at Item A's "either").
- **Nothing on the other side** of this pair yet.

Where the gap is something the maker can change, one tap opens the existing edit flow with the value pre-filled; the user reviews and signs as usual (an edit restarts the terms age, which the screen says). The hint never promises a match: another taker can reach the counterparty first.

Indexer: one route with two forms.

- **By offer id:** the closest opposite-side offers on its pair, with the differing dimension named. The app confirms the top candidate with `previewMatch`, so the stated reason is the protocol's own.
- **By intent key** (owner, lending asset, collateral asset): the closest borrower requests on the pair. An intent has no resting offer id (its lender slice exists only inside a fill), so `previewMatch` cannot answer for it. The app confirms with `RiskPreviewFacet.previewIntent`, naming a candidate fill amount (sized as the keeper sizes it: within the intent's minimum fill, exposure headroom and un-lent capital, and the request's bounds) and the solver context the fill would run under. That preview reports the intent-specific refusals (exposure, capital, longest term, lend-until, interest mode, partial repayment, keeper authorization), which is what the intent card shows.

### Alternatives considered

1. **On-chain "nearest counterparty" view.** Rejected: an unbounded scan in a view still times out on a large book; the indexer already holds the book.
2. **Auto-adjust the offer for the user.** Rejected: changes a signed price without the user's review.
3. **Only a generic "no match yet" label.** Rejected: it is what exists, and it is why offers sit.

---

## 4a. Item D — one "Lend" flow; offers and intents stay two layers

**Question (owner, 2026-11-15):** should offers become intents, since the intent handles more?

**Answer: no conversion; unify what the user sees.** The two are layers, not rivals. An intent is a standing instruction that, at each fill, materializes a temporary lender offer for the slice and matches it to a borrower offer; every loan is still a copy of a concrete borrower offer. Offers cannot all become intents because a loan needs a concrete borrower offer to copy (borrower standing intents are a separate, unbuilt design, #1207), a direct accept needs a concrete offer to review and sign, and NFT rentals, loan sales and refinance requests are offers while intents cover ERC-20 lending only.

On the lender side the two overlap, and the intent is the stronger tool (re-lends repaid money, exposure cap, LTV ceiling, and after #3618/#3619 an end date and pro-rata). So:

- **One Lend form in the app.** Amount, lowest rate, longest term, options. One choice, "keep lending when repaid", decides what the app creates: on = a funded standing intent (with the optional lend-until date and the pro-rata choice); off = a one-time offer. The review screen states which was created and the differences that matter: an intent is filled by the matching service rather than accepted directly by a borrower, sizes collateral from an LTV ceiling rather than a fixed amount, and re-lends until stopped or the end date.
- **Already live (alpha05, #3319):** the borrow side shows the lenders standing ready on a pair and names why a request would not be filled from them (pro-rata, partial repayment, prepay listing, cadence). Those reasons shrink as #3619 and later intent options land; the copy keys follow.
- **Auto-extend is unaffected by the choice.** It is a loan-level feature with two-sided caps set by the two position holders, so it works the same for a loan opened from an offer or from an intent.
- **Later:** borrower standing intents (#1207) give the demand side the same always-on behaviour.

No contract change. Alternatives considered: convert every lender offer into an intent in the contract (rejected: removes direct accept of a visible lender offer and the rate-range midpoint, and does nothing for rentals, sales or the borrower side); keep two separate app flows (rejected: the user has to learn which feature they need before they can lend).

## 4b. Item E — several intents per asset pair (#3626, owner approved 2026-11-15)

**Question (owner, 2026-11-15):** can a rate ladder be done on intents, so that the intent is the default for lenders apart from the stated exceptions?

**Answer: yes, by adding a slot number to the intent key.** Scouted first: every intent structure is keyed by the owner and the two assets (the intent record, its capital lien, its live-principal counter, the priority-routing opt-in, the registry key hash, the per-loan origin record), so one wallet holds exactly one intent per pair today. Nothing else depends on there being only one.

### Rule

- The key gains a small slot number (0 to 7). Each slot is a full, independent intent with its own funded capital, exposure cap, rate floor, LTV ceiling, longest term, smallest fill, lend-until date and pro-rata choice.
- Nothing is shared between slots. A fill draws from one named slot. A roll returns the proceeds to the slot the loan was filled from, and the exposure release does the same, because the loan's origin record carries the slot.
- The caller of the intent match names the slot. The protocol does not choose between a lender's slots, as it does not rank counterparties. Keeper policy, stated in its docs: among one lender's slots that can fill a request, take the lowest floor first, so a ladder fills from its cheapest rung up.
- The backstop vault and the aggregator adapters use slot 0 only.
- Moving un-lent capital between slots is a withdraw and a fund. A one-call move is a possible follow-up.

### What a ladder means under midpoint pricing

An intent fill is priced at the midpoint of the rate overlap, not at the lender's floor: the lower end of the overlap is the higher of the lender's floor and the borrower's own lowest rate, the upper end is the borrower's ceiling, and the loan's rate is halfway between. A higher-floor slot therefore always refuses borrowers whose ceiling is below it, and lifts the loan's rate only when the floor is above the borrower's own lowest rate. Example: a borrower asking 8% to 10% is filled at 9% from a 2% slot and from a 6% slot alike; a borrower asking 3% to 10% is filled at 6.5% from a 3%-or-lower slot and at 8% from a 6% slot. The app states the formula and both effects when a lender adds a second rate, and never says a higher rung always earns more.

### Changes and reach

The four triple-keyed mappings, the registry key and the origin record gain the slot; every intent entry point, preview, view and event takes or states it; keeper, indexer, app and both ABI exports follow. It is a deliberate storage break, acknowledged in the storage-layout guard, and reaches a chain by fresh deploy only. The full change list and tests are on the card.

### As built (2026-11-15)

- The slot is a `uint8` that follows the collateral asset in every intent entry point, preview, view and event (`setLenderIntent`, `cancelLenderIntent`, `fundLenderIntent`, `withdrawLenderIntentCapital`, `setLenderIntentPriority` and their reads; `matchIntent` and `previewIntent`; `LenderIntentSet` and the other intent events, `IntentMatched`, `IntentLoanRolled`, `IntentPriorityFill`, `LenderIntentPrioritySet`). A slot of 8 or more is refused by name (`LenderIntentSlotOutOfRange`).
- The four per-pair mappings gain an innermost slot key; the registry key, its tuple and the loan's origin record carry the slot at their tails. The feeds (`getActiveLenderIntents`, `getRollableIntentLoans`, `getLenderIntentsByOwner`) state each row's slot.
- The backstop vault and the aggregator adapters pass the named constant for slot 0.
- The reference keeper groups one lender's slots on a pair into one unit of its fair walk, lowest floor first (ties to the lower slot), so a lender with several slots gets no more turns than a lender with one. The new app labels each standing offer's un-lent capital by its number in Claim everything, and counts a lender with several intents on a pair once in the "lenders ready" figure.
- Storage break acknowledged in `breaks.ack.json`; fresh deploy only.

### What stays an offer after this

Unpriced or NFT collateral, NFT rentals, loan-purchase offers, a deal a borrower accepts directly, and exact deals (a fixed collateral amount, all-or-nothing, an offer expiry). Rate ladders leave the list.

### Alternatives considered

1. A rate-by-term schedule inside one intent. Rejected: covers only the term dimension, cannot cap the amount per step because capital is shared, and adds a second pricing rule to the fill check.
2. A floor that rises with the share already lent. Rejected: covers only depth, and reads as pool-style curve pricing on a product whose rule is fixed terms the lender states.
3. Keep one intent per pair and ladder with one-time offers. Rejected: the ladder's repaid money sits idle.
4. Several wallets. Works today; rejected as the answer because each wallet needs its own vault, funding and protection setup.
5. An unbounded intent id. Rejected: makes the per-pair views and the keeper's per-lender walk unbounded.

## 5. Order of work

1. #3618 + #3619 (intent end date and pro-rata opt-in) — one contract PR.
1a. Item E (#3626) — its own contract PR straight after, since it is mechanical but touches every intent entry point.
2. Item A — contract PR (fresh deploy with the same batch).
2a. #3629 (owner direction 2026-11-15) — every lender payment on an open loan is held for the position and released by the position claim, never paid to a wallet; the intent roll may then re-commit held amounts. Its own contract PR after the Auto-lend PRs; rule, scouting list and tests on the card.
3. Item B1 and Item C — app and indexer (app thread). Item B2 — keeper thread.

All contract work joins the queue for the next fresh testnet deploy.

## 6. Open items for the builder to raise, not decide silently

- **Cadence "either".** A lender asking for no periodic interest would usually accept a borrower who offers it. Left exact here because the cadence admission rule (`LibCadenceAdmission`) and the periodic auto-settlement both key on it; add as a third bit only after scouting those.
- **Intents and prepay listing / cadence.** An intent's slice stands for "no prepay listing, no cadence", so it skips such requests. Extending the intent the same way as Item A is a follow-up decision.
- **Borrower accepting a lender offer marked "either".** Today the loan takes the lender offer's stored values. Letting the accepting borrower pick is possible later; not needed for the idle-liquidity goal.
