## Thread — Recovery and Risk access are readable in every offered language (PR #1563)

The nine languages alpha02 presents as translated — Spanish, French, German,
Japanese, Chinese, Hindi, Tamil, Korean, Arabic — were each missing 291 of the
English catalog's keys, including every string on the two most recently shipped
pages. Nothing looked broken, because the app falls back to English key by key;
what a user actually got was a page that switched to English partway down. On the
stuck-token recovery page that is the worst possible place for it, since the page
asks the user to sign a declaration attesting they understood what they are
signing. This fills Recovery and Risk access across all nine, and leaves the
remaining older sections tracked as follow-up.

One of the translated strings was load-bearing in a way translation would have
broken: the recovery page makes the user type `CONFIRM` as a deliberate speed
bump, and the app compares that input against the literal English word. A locale
that translated it would have rendered a gate no user of that language could
pass — they type the word the page asks for, it never matches, and the sign
button stays disabled. `CONFIRM` is now in the shared do-not-translate glossary
alongside the protocol terms, so the machine-translation path can't reintroduce
the problem.

The gap existed because nothing was watching for it. The template drift check
guards the English catalog against the app's copy, but nothing guarded the
translated bundles against the template, and the shared translate script had no
mode that could top a locale up — it either skipped anything that wasn't an empty
placeholder, or overwrote the whole file. So every locale silently froze at the
key set it had on the day it was first generated. There is now a gap-fill mode
that translates only the missing keys and merges them back, a matching merge path
for translations that arrive by hand rather than from the API, and a build-time
guard that fails when a language offered as translated falls behind the template
— with the remaining backlog recorded as named sections rather than absorbed into
a tolerance, so a new untranslated section fails even though the total is
unchanged.

The same guard now also checks that interpolated values survive translation
(previously tracked as a to-do): a translation may reorder the values or, where
the grammar already carries one, leave it out — Arabic's dual form means "two
days" in the noun itself, so restating the count there would read "2 two-days" —
but it can never introduce a value slot the English lacks, which renders to the
user as literal braces. That class of bug is invisible in review, because a
reviewer reading fluent Tamil does not see the `{{amount}}` that isn't there, and
it surfaces at render time in one language only, often on the sentence quoting a
number the user is about to sign for.

Review then found the one place the page still switched languages at the worst
possible moment. The declaration a user signs to recover tokens is fixed English
by necessity — its hash has to match a value stored in the contract, so
translating the signed bytes is impossible — and it was rendered in English
only. A reader of another language was therefore attesting, in a language they
might not read, that they had understood what they were attesting to. The signed
text is unchanged; a translation of it now appears alongside, labelled so which
of the two is authoritative is never in doubt. It shows only for readers who
have chosen another language.

Closes #1560. Follow-up: the remaining 163 keys (offset, tariff, early repay,
transfer obligation, sale hold, loan sale and a few strays) are tracked
separately; they are listed explicitly in the guard's allowlist and each entry
has to be removed as it is filled.
