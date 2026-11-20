## Thread — Cap and floor levels on the rate reference (PR #<n>)

The rate reference now carries the cap and floor levels a floating-rate loan
will be bounded by (#3337 part 2, the levels step; design:
FloatingRateCapFloorLevelsDesign). Each level belongs to one asset, has a
permanent id and a fixed rate that never changes after it is added. The owner
adds or retires a level only through the reference's existing delayed-change
path, so every change is visible before it takes effect.

For each series the reference keeps two running totals per level: how far the
index has run above each cap, and how far below each floor. They are accrued
in every update before the new reading is stored, so a loan's clamped sum is
the index's sum less the excess over its cap plus the shortfall under its
floor, read once at any time with no per-loan work. The two Diamond-only
entries that open and close a floating loan also count the loans on each
level, so a level with open loans cannot be retired.

The derived reads (the unusual-market flag, the series status, the term
average, a linked rate and the warning band) moved to a stateless companion
contract, RateReferenceReads, which the reference creates in its constructor.
That keeps the reference under the EIP-170 size limit with room for the
levels; the deploy-sanity suite now measures both contracts.

Nothing opens a floating loan yet: the loan side is the next part of #3337.
Advances #3337 (part 2).
