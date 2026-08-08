### The app could report a language as fully translated while it still read in English

A check already existed to catch a language falling behind — it compares which
pieces of text each language has against the English original, and fails the
build when any are missing. It was doing its job: the count went from a hundred
and sixty missing pieces down to none.

But "has the text" and "has it in that language" are not the same question, and
only the first was being asked. A piece of text that exists but still holds the
English wording is, to the check, indistinguishable from a translated one. So
the moment the last missing piece was filled, every language read as complete —
while Hindi alone still showed nearly three hundred English strings to anyone
using the app in Hindi.

The check now asks the second question too. 491 of these
are recorded as a known, dated backlog so the number cannot quietly grow: a
piece of text that regresses to English fails the build, and one that gets
translated has to be struck from the record or the build fails as well. The
record can only shrink, and every entry in it is a translation someone still
owes.

A small number of strings genuinely read the same in every language — the
product name, and standard trading acronyms that are used untranslated
everywhere. Those are listed separately, each with a written reason and with the
English wording it was granted against, so that rewording the English makes the
exemption stale rather than letting it quietly carry over to text nobody looked
at again.

There are deliberately no rules-of-thumb about what is exempt. An earlier draft
excused anything with no letters in it, on the reasoning that punctuation cannot
be translated. That is simply untrue: the sentence ending is a full stop in
English and a full-width one in Chinese, so the rule would have allowed a real
piece of Chinese to quietly revert to the English mark. Each exemption is now
written down and justified individually.

The same reasoning applies to the record itself. It stores the English wording
each entry was written against, because if the English changes the untranslated
text no longer matches it — and a check that treated that as evidence of
translation would erase the debt precisely when someone edits the source.

The failure message also stops giving the wrong instruction. The existing
suggestion — fill in whatever is missing — walks straight past text that is
present but untranslated, so following it would report nothing to do on a
language the check had just failed.
