## Thread — Rate Desk i18n wording pass (post-#1403 live review)

Following the post-deploy live review of the #1403 Rate-Desk string
extraction (recorded in
`docs/DesignsAndPlans/RateDeskI18nLiveReview-2026-07-22.md`), this change
refines the desk translations in five locales so they read as the intended
market meaning rather than a literal word-swap — and, critically, so each
desk term agrees with how that same concept is already rendered elsewhere in
the same bundle.

Applied: French/German/Spanish now use the standard market term for the
quoted mid rate (`cours moyen` / `Mittelkurs` / `punto medio`) consistently
across the whole desk (market header, chart overlay, and the ladder mid row)
instead of the literal "middle" renderings; German's opaque `T` day chip
becomes `Tg.`; Arabic's ladder mid label is aligned to the same word its own
market header uses; and two Tamil desk strings are corrected — an "on-chain"
label that literally said "in the physical chain" now uses the on-chain term
the rest of the Tamil bundle already uses, and an "offer" label is aligned to
its immediate sibling in the same block.

Several initially-flagged items were deliberately left unchanged because the
"suboptimal" term turned out to be the bundle's own established, consistent
choice (e.g. Spanish `en default`, Japanese `超過` for overdue) — changing
only the desk would introduce a second word for the same thing. Those, plus a
pre-existing app-wide split in Tamil's word for "offer", are documented in the
review as follow-up items rather than silently half-fixed here. Korean and
Hindi keep their intentional English-jargon posture, which is consistent
app-wide. Locale JSON values only — no source, `copy.ts`, `en.json`, or key
changes; placeholder parity re-verified across all nine locales and the i18n
test suite is green.
