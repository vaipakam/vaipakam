## Thread — Fallback split priced honestly; rental offers single-value (PR #<n>)

**The fallback split now decides "the oracle is unavailable" from the price
reads, never from how small a converted figure is.** When every swap route
fails, the protocol splits the collateral: the lender takes the collateral
needed to cover their fallback entitlement, the treasury its handling share,
and the borrower the rest. If a price cannot be read, the lender takes
everything instead. Before this change the code treated a lender share that
converted to zero units as "unavailable". So on a fully priced loan whose
entitlement was worth less than one unit of collateral, the lender received
the whole collateral and the oracle-unavailable event was emitted. Now one
pair of price reads decides availability for the whole split, and a priced
split stays a split however small its shares.

**The lender's share rounds up, lender first.** "The collateral needed to
cover the entitlement" now means the smallest whole amount worth at least
the entitlement at that price. The old floor could leave the lender up to
one collateral unit short. The treasury's share still rounds down, and the
borrower keeps the remainder. Two places keep the same rule:

- When an internal match consumes part of a waiting fallback, the remaining
  lender share is rescaled rounding up.
- The keeper backstop's purchase check no longer allows a one-wei shortfall.
  At an unchanged price the slice it buys is now always worth the full due.
  And when a rescale leaves a collateral share beside a due rounded down to
  zero, the backstop no longer buys that share for nothing: it spends
  nothing and the lender keeps the share in kind.

The same conversion change reaches two other paths:

- **Periodic-interest auto-liquidation.** The sale is sized to the
  collateral needed for the shortfall, rounded up, so a small shortfall is no
  longer sized to a sale of nothing. The sale also reads one price for both
  sizing and quoting, and refuses before anything moves when a price is
  missing.
- **Discounted liquidation.** It refuses on an unpriced pair, as it always
  meant to, and no longer on a figure that merely rounds to zero.

**NFT-rental offers are single-value on their daily fee.** Creating a
rental offer with a fee range is now refused, and so is editing one into a
range (`RentalAmountRangeNotAllowed`). Every rental path prices the
prepayment from the offer's single fee. With a range, the fee the loan ran
on could differ from the fee that was prepaid. The clearest case was a
replacement borrower taking over a rental whose fee sat inside that
borrower's range: the incoming prepayment came out short of the fee the
rental kept charging. The app already sent rental offers at one fee, so
nothing changes for an ordinary user.

Closes #1281: this change fixes items 021 and 027. Item 011 was fixed by
the measured-delivery change (#2622), and item 041 by the earlier
par-guard rework, whose last one-wei allowance this change removes.

Nothing here has reached the testnets yet: per the owner's 2026-10-21
decision, every testnet refresh waits until all the waves of work are done.
This changes no storage. Both rules assume records written under them. A
rental offer created earlier with a fee range would not be refused when it
is used, and a fallback split sized by the old rounding could fall one unit
short of the exact purchase check, so the backstop would refuse it and the
lender would keep the ordinary claim. Neither kind of record can exist
where this code runs: every chain that runs the current fallback custody
code is deployed fresh (owner decision of 2026-10-07), so it starts with no
earlier records.
