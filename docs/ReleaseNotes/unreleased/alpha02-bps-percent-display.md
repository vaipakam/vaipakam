## alpha02 — rates always display as percent, never raw basis points (PR #<n>)

The Offer Book's advanced detail line was the last surface that showed
interest rates in the protocol's internal unit — "900 bps" and
"rate band 0–900 bps". Those now read "rate 9%" and
"rate band 0%–9%", matching the summary line above them and every
other screen. Nothing is lost in the conversion: a whole-number
basis-point rate always divides into a percentage with at most two
decimal places, so the percent form is exact.

Raw basis points still exist in exactly two deliberate places, both
trader-oriented: the Rate Desk's hover tooltips (hovering a percent
shows the exact stored value) and its "rates are stored in basis
points" explanatory note. They never appear as a row's visible text.

Under the hood, three copies of the same bps→percent formatter (the
shared library one, one in the fee data module, one local to the
rental page) were consolidated into the single shared formatter, so a
future change to rate display precision happens in one place. The
translated copy catalog moved with it: every language's "rate band"
entry dropped its baked-in "bps" suffix (the interpolated values are
now pre-formatted percents), and the single-rate detail got its own
translated catalog entry.
