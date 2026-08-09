## Removing a duplicate that had already misdirected one fix

The older connected app carried its own copy of the documentation-rendering
components the marketing site uses — the piece that renders reference
figures inline in help text, the one that builds a page's contents list,
and the contents list itself. Nothing in that app rendered any of them. The
live versions live in the marketing site and are reached from four real
pages.

The duplicate was not merely unused, it was actively misleading. A recent
fix to a rendering fault landed in the dead copy first, because that is the
one a search for the component turns up first; the fault stayed live on the
pages readers actually see until review caught it. Both were eventually
fixed, but the trap remained: two files that look interchangeable, one of
which nobody renders, and no way to tell them apart except by knowing.

All three are gone, along with three markdown libraries that were listed as
dependencies of that app and imported by nothing in it — they had already
fallen to zero users, since the dead files only mentioned the library in
comments rather than importing it.

Nothing else changes. The marketing site's copies are untouched, and the
app's type checking, lint, full test suite and production bundle are all
unaffected.
