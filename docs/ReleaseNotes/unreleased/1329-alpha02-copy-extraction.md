## alpha02 — full UI-string extraction into the translatable catalog (#1329)

Switching the alpha02 display language used to leave large patches of
the interface in English even for a fully-translated locale. The cause
was not a translation gap but an extraction gap: 313 user-visible
strings across 34 components were hardcoded in JSX instead of routed
through the `copy.*` catalog, so they had no key in the English
template and no locale could ever translate them. A live walk only
surfaces the states you happen to click through; a static sweep of
`apps/alpha02/src` found all of them at once, including error
boundaries, empty states, and failure paths.

Every genuine UI literal — page titles and ledes, form labels and
hints, confirmation-receipt rows, the Help FAQ, filter controls,
flow step labels, empty/loading/error copy — now reads from
`content/copy.ts`, growing the catalog from 774 to 1,155 string
leaves. Strings that are deliberately English are left alone:
on-chain event names compared in logic, keyboard codes, the brand
name, console diagnostics, and parameterised templates that embed a
live value mid-sentence (those are recorded as follow-up work for the
catalog's interpolation support). Legal surfaces (terms, privacy,
whitepaper) stay English by design — that is the www surface and the
#1314 posture decision.

Because the same regression re-opens with every new component, a
guardrail — `scripts/check-hardcoded-strings.mjs`, wired into the
alpha02 `typecheck` lane — now fails CI when a user-visible string
bypasses the catalog, with a tight allowlist for the deliberate
English literals. The newly-extracted keys ship English-only for now
and fall back to English in every locale until translated (tracked in
#1323 alongside the remaining locale bundles).

Closes #1329.
