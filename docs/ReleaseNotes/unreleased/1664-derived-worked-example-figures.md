## The worked example's arithmetic, and the site search, now move with the rates they are computed from

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
- Nothing else. In particular the six-decimal figure is unchanged, and an
  earlier draft of this change altered it in error — see below.
- On non-English pages the amounts now follow that language's own number
  conventions automatically, rather than depending on each translation having
  been written with the right separators.

### Why the arithmetic is done in whole units of the smallest denomination

The computation deliberately mirrors how the protocol itself calculates,
working in the currency's smallest unit and discarding fractions at each step,
rather than in ordinary decimals.

This is not fussiness. An earlier draft of this change used ordinary decimal
arithmetic and produced a figure one unit different in the last place from what
the protocol actually pays — and then presented it on a page that calls the
figure exact and says settlement uses it. The number written on the page
originally was right; the more "precise" computed one was wrong. A page that
disagrees with the contract about what a settlement pays is worse than a page
whose figure is merely old, so the arithmetic follows the chain's rules rather
than approximating them.

### On the marker that says where a figure came from

A computed figure only claims to come from the published configuration when
**every** input it was computed from was read live. If any input falls back to
the value bundled with the site, the result is marked as bundled too.

This matters because a computed figure could otherwise inherit a confidence
none of its parts had — one live rate and one fallback could produce a number
presented as fully published. The marker exists to be precise about provenance,
so it defers to the least certain input rather than the most.

### The site search was reading the same figures from the wrong place

The help search builds its index by substituting these figures into the text
it searches, so the index carries whatever the numbers were when it was built.
It was built once, from the values shipped with the site, before the published
configuration had been fetched — and never rebuilt.

After a retune that produces a specific failure: searching for a figure
**printed on a page** could miss that page's own section, and a result summary
could contradict the page it links to. That is the exact problem substituting
figures into the index was introduced to prevent, reintroduced by building the
index too early.

The index is now tied to the configuration snapshot it was built from, so a
newer snapshot naturally produces a fresh index rather than relying on anyone
remembering to discard the old one.

Alongside this, the description of which configuration field backs which figure
now lives in one place instead of two. The page renderer and the search index
each had their own copy, which is the same kind of duplication that caused the
problem being fixed here.

### Scope

This covers the worked example, which is the passage where a retune would be
most visibly self-contradictory. The other threads on this topic — the search
index, the machine-readable exports, naming which network the figures describe,
and passages that describe a fee fixed at a loan's creation rather than the
current one — are unchanged and remain tracked.
