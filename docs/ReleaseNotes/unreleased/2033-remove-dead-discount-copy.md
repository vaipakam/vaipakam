## Thread — Removed nine unused marketing strings that described the fee discount wrongly (PR #<n>)

The marketing site carried nine translated strings, in ten languages, describing
how the VPFI fee discount is calculated. The description was out of date, and
one of them was not merely stale but backwards: it told a reader that at
settlement the treasury cut is reduced by a *time-weighted average* of their
discount "not the current rate", and that a late top-up would earn a share
*proportional* to how long the tokens were held.

Settlement uses the current effective tier. And the real rule cannot produce a
proportional outcome at all — the tier is a *minimum* over recent history, and a
minimum is not a proportion. Someone at the lowest tier for most of a month who
raises their balance at the end resolves at the lowest tier, not somewhere in
between.

The strings are gone rather than rewritten. **None of them was displayed
anywhere** — they belong to two cards that were never built on this site, so no
visitor has read any of this. The one string a visitor *could* reach was
corrected separately, in the change that first found this.

Deleting is the safer of the two options here, and the reason is about the next
person rather than the current reader. Copy that already exists in ten languages
is copy the next developer will trust: someone building that card would
reasonably wire these up and ship a screen telling lenders their settlement rate
is not their current rate. A missing string is a visible gap that gets written;
a wrong one gets shipped.

The conclusion the worst of them drew — that topping up just before repayment
does not capture the full current-tier discount — remains true. It is true for a
different reason: a discount tier needs a minimum holding period, and it is
clamped to the lowest level held recently. Only the stated mechanism was wrong,
which is the same shape as the error that prompted the sweep.
