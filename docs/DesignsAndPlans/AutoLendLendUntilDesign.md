# Auto-lend "lend until" date — design

**Status:** approved direction (owner, 2026-11-15); ready to build. Cards #3618 and #3619.
**Scope:** the standing lender intent (Auto-lend). Offers are not changed.
**Related:** #3615 (pro-rata offers match a shorter borrower term), `LenderIntentVaultV1Design.md`, `AutoLendIntentUnificationDesign.md`.
**Reviewed 2026-11-17.** Since this was written: an intent is one of up to eight slots per pair (#3626), each with its own date; a partial repayment is held for the position and may be re-committed (#3629); a slot's room follows the principal outstanding on its loans (#3714); and setting or changing a slot's fixed rate outside the warning band needs the acknowledgement of `TermAverageAndLinkGuardsDesign.md` 6.4 (#3713). The partial-repayment paragraph of section 9 and its tests are rewritten for the second and third.

## 1. What the lender wants

A lender has money free for a fixed window, say 30 days. They want it lent for as much of that window as borrowers ask for, and back by the end of it. If a 20-day loan is repaid, the money should go out again, but only to a loan that still ends inside the window: a 7-day or 10-day request on day 20, never another 30-day one.

## 2. Why this belongs on the intent, not on an offer

Scouted before designing:

- An **offer** is a one-time order. It tracks the *amount* still unlent and nothing else. Money repaid on a loan goes to the lender's vault as a claim; it never returns to the offer. Making offers re-lend repayments would turn them into a second Auto-lend with its own rules, and every repay, claim, sale and roll path would have to learn about it.
- The **standing lender intent** already does the re-lending. A lender funds capital behind limits (max exposure, minimum rate, max initial LTV, longest loan term, smallest fill). Solvers and the keeper fill borrower requests from it (`matchIntent`), each loan runs the borrower offer's own term, and a fully repaid loan's principal and interest are re-committed behind the intent (`rollIntentLoan`, by the owner or a keeper holding the auto-roll permission).

What the intent lacks is a deadline. `maxDurationDays` caps each loan's length; nothing caps when the last loan ends. This design adds that one bound.

## 3. The rule

An intent may carry an optional **lend-until time** (`lendUntil`, unix seconds; `0` = none, today's behaviour).

1. **Fill.** A fill is admitted only if the loan's agreed maturity is at or before the lend-until time:
   `now + borrowerOffer.durationDays × 1 day ≤ lendUntil`.
   This sits beside the existing `maxDurationDays` check and both must pass. As the window runs down, the longest term that fits shrinks by itself; no state changes.
2. **Roll.** A repaid loan is rolled back behind the intent only while a further loan could still fit, i.e. while `now + 1 day ≤ lendUntil`. After that the roll is refused and the loan settles through the normal lender claim, so the money returns to the lender's vault instead of sitting behind an intent that can no longer lend it.
3. **Set.** `lendUntil` must be `0` or at least one day ahead when the intent is set or re-set. Changing it is a re-set of the intent's terms, so the existing terms-age wait (#3443) applies before the next fill.
4. **After the time passes.** Nothing moves by itself. The intent stays stored and its un-lent capital stays liened behind it until the owner withdraws it (`withdrawLenderIntentCapital`, already open at any time) or sets a new date. Open loans are untouched.

### What the date does and does not promise (must be stated to the user)

- It bounds each loan's **agreed maturity**. It is not a promise that the money is back by then.
- A borrower may repay late inside the grace window, a default or liquidation settles when it settles, and a protocol pause extends every loan's deadlines by the paused time (`LibLoanClock`). Any of these can end a loan after the lend-until time.
- The app copy is therefore "no new loan will be agreed to run past this date", never "your funds return by this date".

## 4. Contract changes

| Where | Change |
| --- | --- |
| `LibVaipakam.LenderIntent` | Append `uint64 lendUntil` at the tail (mapping value struct, may grow; packs beside `termsSetAt`). Run the storage-layout guard `write` and commit the golden file. |
| `LenderIntentFacet.setLenderIntent` | New `uint64 lendUntil` argument; validate rule 3 (`LenderIntentInvalidBounds`); store it; `LenderIntentSet` gains the field. |
| `OfferMatchIntentFacet.matchIntent` | Rule 1, right after the `maxDurationDays` check: revert `LenderIntentPastLendUntil(maturity, lendUntil)`. |
| `LibOfferMatch.previewIntent` | The same check in the same position; new `IntentError.PastLendUntil` **appended at the tail** of the enum so existing ordinals stay stable. The `previewIntent` Ok ⟺ `matchIntent` succeeds agreement test covers it. |
| `LenderIntentFacet.rollIntentLoan` | Rule 2: revert `LenderIntentEnded()` when no further loan fits. |
| Roll-discovery view | Skip loans whose intent can no longer take a roll, so the keeper does not page loans it cannot roll. |
| `LibMetricsTypes.LenderIntentSummary` / `getLenderIntent` | Carry `lendUntil` so the keeper and the app read it without a second call. |
| `BackstopVaultImplementation`, `AggregatorAdapterImplementation`, `BackstopFacet` | Pass `0` (no end date) at their `setLenderIntent` call sites. Both are UUPS contracts: the interface they call changes, so they ship with the same fresh deploy. |

No fund-moving path changes. The date only refuses a fill or a roll; where a roll is refused, the proceeds take the existing claim route, which already emits its own events and measures what arrives.

**Facet room (measured 2026-11-15, quick profile):** LenderIntentFacet 16,347; OfferMatchIntentFacet 22,768; RiskPreviewFacet 21,252; BackstopFacet 23,847; **MetricsFacet 24,262** (314 bytes under EIP-170). The summary struct is built in MetricsFacet, so one more field may not fit. If it does not, move the intent discovery feeds (active intents, roll candidates) to their own facet along that seam rather than trimming (standing rule: split, do not shave). Check with the deploy-sanity size test, not a clean compile.

**As built (2026-11-15):** MetricsFacet came out at 24,508 bytes with the new summary fields, so the two intent discovery feeds (`getActiveLenderIntents`, `getRollableIntentLoans`) moved to `LenderIntentFacet`, which already hosts the per-owner intent list and had about 7.6 KB free, instead of a new facet. Every intent read now lives with the intent. Selectors are unchanged. The fill, the preview, the roll and the roll feed read one library (`LibIntentTerms`), so the four cannot disagree, and the roll feed skips a loan whose intent is cancelled as well as one that has ended, since the roll refuses both. Two refinements came from the security review, both tightening the rules above. First, the minimum window when `lendUntil` is set is counted from when the newly set terms may first be filled (now plus the minimum terms age), not from now, so a minimal window always leaves room for a one-day loan once fills open. Second, the keeper fill feed (`getActiveLenderIntents`) leaves out an intent whose window can no longer take a one-day loan; one rule, `LibIntentTerms.windowOpen`, gates that feed, the roll and the roll feed, and the feed's `total` still counts the whole registry so paging is unchanged.

**Reaches a chain by fresh deploy** (function signature, struct ABI and event all change). Join the desktop thread's contract build queue for the next fresh testnet deploy.

## 5. Off-chain changes

- **Keeper** (`apps/keeper/src/matcher.ts`, intent-fill pass): add the fit check to the pre-filter next to `maxDurationDays`, so no preview is spent on a request that cannot fit; read `acceptsProRata` into the intent summary the pass builds (`liftIntent`) and condition the pre-filter's two refusals (`borrowerFitsIntent`: pro-rata request, partial repayment allowed) on the rules in section 9, since today it refuses both unconditionally before any preview and an ABI sync alone would leave every pro-rata request unattempted; a keeper test covers flag off, flag on with a pro-rata request, and partial repayment with a full-term request; the auto-roll pass treats `LenderIntentEnded` as a skip, like the existing not-delegated skip. Sync the public reference bot's ABIs.
- **App** (Auto-lend setup): an optional "Lend until" date with the copy from section 3; the intent card shows the date and, once it has passed, says the intent has ended and offers withdraw or set a new date.
- **Indexer:** `LenderIntentSet` is decoded from the compiled ABI, so the new field arrives with the ABI export; store it if the intent table keeps the bounds.
- **ABI exports:** frontend and keeper-bot exports in the same PR as the contract change.

## 6. Tests

1. `lendUntil = 0` behaves exactly as today.
2. A request whose term fits is filled; one a day too long is refused, by `matchIntent` and by `previewIntent` with the same reason.
3. As time passes, a term that fitted earlier is refused later (the shrinking window).
4. The owner's example: 30-day window, 20-day loan repaid on day 20, rolled, then a 7-day and a 10-day request fill and an 11-day one is refused.
5. A roll after the window can no longer fit a loan is refused, and the normal claim pays the lender's vault in full.
6. Setting a date less than a day ahead is refused; re-setting the date restarts the terms-age wait.
7. Backstop and aggregator intents still register and fill (no end date).
8. A pause during a loan moves its maturity past the date without reverting anything (documents the limit in section 3).

## 7. Alternatives considered

1. **Re-lend from the offer** (repayments return to the offer for its "remaining days"). Rejected: duplicates Auto-lend on the offer and threads offer state through every settlement path.
2. **Shrink `maxDurationDays` over time off-chain** (keeper or owner keeps re-setting the intent). Rejected: needs a transaction per change, each re-set restarts the terms-age wait, and it fails silently when nobody sends it.
3. **Cancel the intent at the date by a keeper.** Rejected: does not stop a 30-day loan being agreed on day 29; the bound has to be on each fill.
4. **Per-loan end date stored on the loan.** Rejected: the loan already has its own term; the date is a property of the lender's standing instruction.
5. **Auto-return capital at the date.** Not adopted: it would be a fund movement nobody signed at that moment and would need its own keeper pass. The owner can withdraw un-lent capital at any time, and the app prompts for it.

## 8. Recommendation

Build the rule in section 3 as one contract PR (with its ABI exports and spec text in `ProjectDetailsREADME.md`, Auto-lend section), then the keeper pre-filter and the app field as follow-ups in their threads.

## 9. Pro-rata opt-in (#3619, owner approved 2026-11-15; built in the same PR)

An intent fills only full-term, no-partial-repay borrower requests today, deliberately: the lender's committed interest is the term's interest. The intent gains one more appended field, `bool acceptsProRata` (default false), set through the same `setLenderIntent` call and stated in `LenderIntentSet`, the intent view and the summary.

- **Off (default):** today's behaviour. A pro-rata request is refused (`LenderIntentFullTermRequired` / `IntentError.FullTermRequired`).
- **On:** the intent fills full-term and pro-rata requests alike. The materialized lender slice takes the borrower offer's interest mode, so the shared match core's lifecycle-terms check passes and the loan carries the mode the borrower chose. On a pro-rata loan the lender earns interest only for the time the money is held; the setup screen states it.
- **Partial repayment (owner direction 2026-11-15):** a full-term intent still refuses a request that allows partial repayment (`LenderIntentPartialRepayNotAllowed`), because a partial repay pays only accrued interest on the repaid slice. An intent with the flag on may fill a pro-rata request that allows it. As it stands after #3629 and #3714:
  - A partial repayment is held for the lender position and claimed by its holder; nothing is paid to a wallet (`LenderPayoutsThroughClaimDesign.md`).
  - The intent's owner, or a keeper holding the owner's auto-roll permission, may put a held amount back behind the slot before the loan ends (`recommitHeldToIntent`). The roll re-commits whatever is still held at full repayment, measured, never the original fill amount.
  - The slot's room follows the principal still outstanding on its loans. A partial repayment frees that much exposure in the same step, a full repayment or a default frees the rest, and nothing waits for a claim (`TermAverageAndLinkGuardsDesign.md` section 7).
  - The earlier text of this bullet (the payment going to the holder's wallet, the repaid slice leaving Auto-lend, and the slice staying counted against the exposure limit until the loan closed) described the routes before those two changes and no longer holds.
- The backstop vault and the aggregator adapters pass `false`.
- There is no "pro-rata only" mode: full-term is never worse for the lender, so excluding it has no use.

Built with the end date because both append to the same record and change the same function: one signature change, one fresh deploy.

Extra tests:

- Flag off refuses a pro-rata request (match and preview agree); flag on fills it and the loan is pro-rata; flag on still fills a full-term request as full-term.
- An early repay of a pro-rata intent loan pays accrued interest only, and the roll re-commits exactly what the vault received.
- Partial repayment, refused cases: a request that allows it is refused when the flag is off, and when the request is full-term (flag on or off).
- Partial repayment, admitted case: flag on and a pro-rata request that allows it is filled; a partial repay is held for the position (nothing reaches a wallet) and frees exactly that much of the slot's exposure in the same step; a re-commit returns it to the slot's capital; after the final repayment the roll re-commits only what is still held (never the original fill amount), and the slot's outstanding figure for the loan reaches zero exactly once.

Alternatives considered: pro-rata for every intent (rejected: changes the deal for lenders who chose full-term); one intent per interest mode (rejected: a second key on the registry, the capital lien and every view).
