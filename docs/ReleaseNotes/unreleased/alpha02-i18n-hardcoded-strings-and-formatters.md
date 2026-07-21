## Thread — alpha02: hardcoded UI strings and English formatters made translatable

Several user-visible strings on the connected app rendered in English
regardless of the chosen language, because they were hardcoded directly
in the page/component markup (never routed through the copy catalog) or
were produced by display formatters that always emitted English. This
was reported from the Chinese locale but affected every language,
including fully-translated ones.

Two causes were addressed. First, twelve hardcoded strings were moved
into the copy catalog with interpolation placeholders and their render
sites rewired: the "waiting for the other side to accept" offer line on
My positions; the "N locked · N free" balance breakdown on My vault; the
loan/rental detail rows ("collateral (borrower's)", the owed
"+ up to ~N interest" line, the "yearly · duration · due date" terms
line, and the "Confirm — <action>" button); the per-day rental price on
the Offers list; the Early-Exit offer row; and the "Connected to
<chain>" network-chip tooltip. Second, the duration, date, and
relative-time formatters were made locale-aware — duration unit words
(day/month/year, singular and plural) now come from the catalog so each
language supplies its own, and dates format with the active UI language
instead of a pinned US format. English output is byte-for-byte unchanged.

The new catalog keys were translated across all nine active locales
(zh, ta, de, fr, es, ar, ja, ko, hi). The existing regex-based
hardcoded-string guardrail did not catch these because they were
interpolation-interspersed JSX and template literals inside `{...}`
expressions — a known blind spot tracked for an AST-based detector.
Scope is limited to `apps/alpha02`; no other app, package, or contract
was changed.
