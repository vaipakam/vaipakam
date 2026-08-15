## The worked example's arithmetic now moves with the rates it is computed from

The Overview walks a reader through a specific loan — a thousand dollars, eight
percent, thirty days — and prints what each party ends up with. The two fee
rates in that passage were already read from the published protocol
configuration. The amounts computed from them were not: they were written into
the page as fixed numbers.

They agree today. They stop agreeing the first time either fee is retuned, and
the way they stop is the problem. The rate moves, the arithmetic beneath it
does not, and the rate carries a marker saying it came from the live published
configuration — so a reader comparing the two has every reason to trust the
half that is now wrong. This is the same contradiction a previous sweep had to
clear by hand ("the rate says one thing and the sum below says another"), set
up to happen again on a schedule nobody controls.

Those amounts are now computed from the same configuration the rates come
from, at the moment the page is read. There is no longer a version of the page
where the rate and the sum disagree, because the sum is derived from the rate
rather than remembered alongside it.

### What a reader sees differently

Almost nothing today, which is the intended outcome. Three small changes:

- The money amounts now always show cents. One figure previously read as a
  whole number and now shows two decimal places, so that a future change of a
  fraction of a cent cannot hide behind a rounded display.
- One figure was very slightly wrong and is now right. The passage quoting the
  fee to six decimal places had been rounded down where it should have been
  rounded up — a difference of one unit in the last place, previously invisible
  because it was typed rather than calculated.
- On non-English pages the amounts now follow that language's own number
  conventions automatically, rather than depending on each translation having
  been written with the right separators.

### On the marker that says where a figure came from

A computed figure only claims to come from the published configuration when
**every** input it was computed from was read live. If any input falls back to
the value bundled with the site, the result is marked as bundled too.

This matters because a computed figure could otherwise inherit a confidence
none of its parts had — one live rate and one fallback could produce a number
presented as fully published. The marker exists to be precise about provenance,
so it defers to the least certain input rather than the most.

### Scope

This covers the worked example, which is the passage where a retune would be
most visibly self-contradictory. The other threads on this topic — the search
index, the machine-readable exports, naming which network the figures describe,
and passages that describe a fee fixed at a loan's creation rather than the
current one — are unchanged and remain tracked.
