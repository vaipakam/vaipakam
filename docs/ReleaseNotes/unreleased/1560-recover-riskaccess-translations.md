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
of the two is authoritative is never in doubt.

That aid appears only when a translation for the reader's language genuinely
exists. Roughly three times as many languages can be selected as are currently
translated, and a translated language's text can also fail to load on a bad
connection; in both cases the page is English throughout. Presenting that English
under a label reading "in your language" would be a false statement made at the
precise moment the user affirms they understood what they read, so in that state
the aid is omitted entirely. It reappears by itself if the translation arrives.

Text that merely repeats the English word for word does not count as a
translation here either — a supplier can return the source text unchanged, and
nothing about the string itself gives that away. Nor does a translated
declaration sitting under an English label, since the label is what tells the
reader which language they are being shown. Both halves are in the reader's
language, or neither is displayed.

Review then found that the English wording of that aid was a second, independent
copy of the declaration itself, sitting in the copy catalog with nothing tying it
to the one the page actually signs. Two copies of the same sentence can drift,
and the drift would be silent: change the declaration to match a new contract and
the aid keeps explaining the old one while still being labelled as saying what
the user is signing. There is now one definition that both the page and the
catalog read, so the English can no longer diverge at all. The nine translations
cannot be derived from it, so the release gate pins the declaration's fingerprint
instead — change the declaration and the build fails until the translations are
re-authored. A stale reading aid is therefore not something that can ship.

Review also caught three strings belonging to these two surfaces that this change
had left for later: the browser-tab titles for the recovery and risk-access
pages, and the one-line description beside the Risk access entry in Settings.
They are translated now, so the two pages this release claims to finish are
finished.

Two translation-tooling scripts could also be stopped dead by a single damaged
locale file: whichever one sorted first would abort the run before any healthy
locale was reached, reporting a raw crash rather than naming the file. Both now
name the bad file and carry on with the rest.

Closes #1560. Follow-up: the remaining 160 keys (offset, tariff, early repay,
transfer obligation, sale hold, loan sale and a few strays) are tracked
separately; they are listed explicitly in the guard's allowlist and each entry
has to be removed as it is filled.
