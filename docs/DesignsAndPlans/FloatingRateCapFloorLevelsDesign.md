# Rate cap and floor levels on floating-rate loans — design

**Status:** owner approved, 2026-11-15 ("standard cap and floor levels"). Amends one line of the floating-rate decision on #3337 ("no per-loan floor or ceiling"); everything else there stands. Built with #3337 part 2 (floating loans).
**Related:** `MarketLinkedRateLimitsDesign.md` (#3635: the averaged reference, market-linked limits, Auto-lend that fills fixed or floating), #3637 (rate-rise illustration, "fix my rate", rate-change alerts).

## 1. Why

On a floating-rate loan the borrower carries the risk that the market rate rises. In long-established lending practice that risk comes with a stated worst case: a cap the rate cannot pass, agreed at signing. The lender's mirror is a floor. As decided on #3337 a floating loan had neither; its only ceiling was the protocol maximum interest rate, so a borrower could not know their worst case and a lender could not know their least.

#3337 ruled per-loan caps out for a sound reason: every floating loan reads one shared cumulative index per asset, which is what makes interest exact on any touch with no per-loan upkeep. An arbitrary cap per loan cannot be read from one shared index.

## 2. Rule

**A cap or floor is chosen from a short standard list per lending asset, and the hourly index update tracks each listed level.** A loan with a cap and a floor is then as exact, and as free of per-loan upkeep, as a loan without.

- A floating offer may state a **cap level**, a **floor level**, both or neither. They are terms of the loan, signed by both parties with the margin, and never change during the loan.
- Levels bound the **reference**, not the margin. While the reference is above the loan's cap level, the loan accrues as if the reference were at the cap; while below its floor level, as if at the floor. The margin is added afterwards and is not affected.
- So the loan's rate at any moment is `clamp(reference, floor, cap) + margin`, and the borrower's worst case is `cap + margin`, the lender's least is `floor + margin`. The app states both as plain all-in rates.
- A loan with no cap keeps the protocol maximum as its only ceiling, and the review says so in those words. A loan with no floor may fall to its margin alone.
- Floor must be below cap. `cap + margin` must not exceed the protocol maximum interest rate; an offer that would is refused at creation.

## 3. How the index tracks a level

#3337's update already computes, about hourly, the accepted reference `r` (after its per-update clamp) and the time `dt` it applies to, and adds `r × dt` to the asset's cumulative index.

The same update also keeps, per listed level `L`:

- for a cap level: **excess above L** += `max(r − L, 0) × dt`
- for a floor level: **shortfall below L** += `max(L − r, 0) × dt`

A loan stores the level ids it signed and the value of each of its two cumulatives at its last interest settlement, beside the index value #3337 already stores. Interest owed since then is:

`principal × ( index growth − excess growth at its cap + shortfall growth at its floor + margin × elapsed time )`

That is exactly `clamp(r, floor, cap) + margin` accrued over time, because floor is below cap. A cap and a floor combine by addition, so the update tracks each level once and never each pair.

Cost: a level's cumulative changes only while the reference is beyond that level, so in ordinary conditions the update writes nothing extra. The worst case is one extra write per level on one side (caps and floors cannot both be exceeded in the same update).

While the quorum is in its "previous reference holds" state, levels accrue against the held value, as the index does.

## 4. The level list

- Per lending asset and chain: at most **4 cap levels and 4 floor levels** open for new loans. Each is a rate in basis points with a permanent id.
- Set through the same delayed configuration as the reference sources. A level's value is **immutable** once added: open loans signed it.
- A level may be **retired**: no new offer may name it and **no new loan may open on it**; it keeps accruing while any open loan references it (a per-level count of open loans), and stops being tracked when that count reaches zero.
- Retirement binds at loan creation, not only at offer creation. Every path that opens a floating loan (a match, a direct accept, a signed offer's fill, an Auto-lend fill, a refinance, an obligation handover) checks in the one shared origination step that the loan's cap and floor levels are open, and refuses by name otherwise. An offer posted before its level was retired therefore waits unfillable; its preview says the level was retired, the app tells its maker, and the maker changes the level or cancels. So only open levels can gain loans, and the tracked set stays within its bound whatever offers are outstanding. The total of open and retired-but-referenced levels per side is bounded (8); adding a level beyond that is refused until one is free.
- A level added later starts its cumulative at zero at that moment; loans opened on it snapshot from there.
- Proposed starting lists, for the owner to confirm at configuration time, not fixed here: caps at the reference's recent average plus roughly 3, 6 and 10 percentage points rounded to whole points; floors at 0.5, 1 and 2 percent. Levels are absolute rates, not offsets, so the lists are reviewed when the market moves a long way.

## 5. Matching

- **Two offers:** the cap level and the floor level are part of the lifecycle terms the match core compares, and must be equal, as cadence is. A borrower who wants a cap asks for one; the lender who fills it has signed the same cap.
- **Direct accept:** the acceptor signs the offer's terms, cap and floor included.
- **Auto-lend that fills floating** (#3635 part B): the slot states the least it accepts, since it does not author the terms: `lowestCapAccepted` (requests with a cap below it are refused; zero means only uncapped requests are accepted, the default) and whether it requires a floor of at least a stated level. The materialized lender slice copies the request's levels, so both signed sets of terms describe the loan opened.
- **Previews** report a level mismatch with its own reason, appended at the tail of the error enums.
- A cap is worth something to the borrower and costs the lender expected interest; a floor is the reverse. The protocol does not price that. Each side prices it in the margin it asks or offers, and the app shows a floating offer's margin next to its cap and floor so offers are compared like for like.

## 6. Everything else that reads the rate

- **Health factor and liquidation** read the loan's current effective rate, `clamp(reference, floor, cap) + margin`, and accrued interest by the formula in section 3. A capped loan's liquidation distance has a computable worst case, which the review shows (#3637).
- **Lender sale, seller claims, roll, claim:** unchanged in shape. They settle interest through the one ledger (`LibInterestLedger`), which gains the two cumulatives in its floating accrual. No second writer of accrued interest.
- **The averaged reference** of #3635 reads the base index only. Levels do not affect market-linked limits or the guidance figure.
- **The own-rate quorum member** of #3337 uses fixed-rate loans; floating loans are copies of the reference and stay out of it, capped or not.

## 7. Contract changes (with #3337 part 2)

| Where | Change |
| --- | --- |
| Per-asset reference state (new in #3337) | Level table: id, rate, open/retired, open-loan count, cumulative. Appended at the tail of storage. |
| The index update | Accrue each tracked level (section 3); the update event states each level's new cumulative when it changed. |
| `Offer` and the signed-offer type | Append `capLevelId`, `floorLevelId` (zero = none), used only by floating offers. |
| Loan record | The two level ids and their two cumulative snapshots, beside the index snapshot. |
| `LibInterestLedger` floating accrual | The formula in section 3. |
| Match core and previews | Level equality in the lifecycle-terms check; intent acceptance bounds; new error members appended. |
| Level configuration | Add and retire, behind the Timelock delay. Each rate is range-checked against the protocol maximum; the floor-below-cap rule is checked per offer, not across the lists. |
| Views | The level list per asset with each level's state; a loan's effective rate now, its cap and floor as all-in rates. |

Reaches a chain by fresh deploy, with the rest of #3337. Run the storage-layout guard's `write` and commit the golden file. Check facet sizes with the deploy-sanity suite; split along a seam, do not trim.

## 8. App and disclosure

- The floating offer form offers the cap and floor levels as choices, each shown as the all-in rate it produces with the typed margin ("your rate can never pass 11.5%").
- The review states: the formula; today's rate; the worst case and the least, or that there is none below the protocol maximum; that the cap and floor are fixed for the loan's life; and the rate-rise illustration of #3637 evaluated up to the cap.
- A loan currently held at its cap or floor says so on the loan page, for both parties.
- A retired level on an open loan is shown as still in force for that loan.
- Copy follows the rewards and positioning rules: no promised return, no comparison to named third parties.

## 9. Tests

1. A loan with no levels accrues exactly as #3337 specifies.
2. Reference below the cap throughout: capped loan equals uncapped loan. Reference above the cap throughout: accrues at cap plus margin. Reference crossing the cap mid-interval across several updates: exact to the update boundaries.
3. Floor: the mirror cases.
4. Cap and floor together across a path that visits below floor, between, and above cap.
5. Two loans on the same level opened at different times each accrue only from their own snapshot.
6. Settlement on any touch (repay, partial repay, liquidation, sale, claim, roll) leaves the same total interest as one settlement at the end.
7. Level retired with a loan open keeps accruing for that loan; a new offer naming it is refused; tracking stops when the last loan closes; the level limit is enforced.
7a. An offer created before its level was retired cannot open a loan by any path (match, direct accept, signed-offer fill, Auto-lend fill, refinance, handover), and every preview reports the retired level. Repeating add, post offers, retire never leaves a loan on an untracked level and never exceeds the tracked bound.
8. A level added later starts from zero and does not change any existing loan.
9. Offer creation refuses floor not below cap, cap plus margin above the protocol maximum, an unknown or retired level, and levels on a fixed-rate offer.
10. Match refuses unequal levels; the previews report the same reason; an intent's acceptance bounds are enforced and the materialized slice copies the request's levels.
11. Health factor and liquidation read the clamped effective rate.
12. The "previous reference holds" state accrues levels against the held value.
13. An index update writes no level cumulative while the reference is inside every level.

## 10. Alternatives considered

1. **No cap or floor** (the #3337 decision as it stood). Rejected by the owner 2026-11-15: a borrower cannot know their worst case.
2. **An arbitrary cap per loan.** Rejected: it cannot be read from a shared index, so each loan would need its own periodic update, which is the per-loan gas #3337 was designed to avoid.
3. **Cap the loan's average rate between settlements** (charge the lesser of the index growth and cap × time). Exact with one index, but the outcome depends on when settlements happen: a borrower who settles just before a spike pays less than one who does not. Rejected as not transparent.
4. **Scheduled resets** (the rate is fixed for a period, then re-read, with a limit per reset). Familiar, but needs a transaction per loan per reset. Rejected for the same reason as 2; the per-update clamp of #3337 already limits how fast the reference itself moves.
5. **Cap levels only.** Offered to the owner; the floor is the fair mirror for lenders and uses the same mechanism at no extra design cost.
6. **Levels as offsets from the reference at signing.** Rejected: each loan would again have its own absolute level.
7. **Cap the all-in rate rather than the reference.** Rejected: the all-in cap is level plus margin, and margins differ per loan, so it cannot be a shared level. The app presents the all-in figure, which is what the user reads.

## 11. Open items for the builder to raise, not decide silently

- How #3337 enforces the protocol maximum on an uncapped floating loan without breaking index exactness; a capped loan satisfies it by construction (section 2).
- Whether the level table fits the reference host facet or needs its own.
- The starting level lists per asset (section 4) are an owner configuration decision at deploy time.
