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

The check now asks the second question too. At the time of writing, 492 pairs
of language and text are recorded as a known, dated backlog so the number cannot quietly grow: a
piece of text that regresses to English fails the build, and one that gets
translated has to be struck from the record or the build fails as well. The
record can only shrink, and every entry in it is a translation someone still
owes.

What counts as "still English" is deliberately loose about everything that is
not vocabulary. Capitalisation, punctuation, spacing and invisible characters
are not a language, and neither is word order — a sentence whose words are all
English reads as English however they are arranged, and rearranging them is the
easiest way to look translated without being. Nine strings were doing exactly
that: six Korean ones — five buttons putting the English word "mint" after the
amount instead of before it, and a progress line reading "terms signing…" — and
three Hindi ones that had swapped two English words around, one of them closing
with the Hindi full stop on a sentence otherwise entirely in English. They are
now recorded as the untranslated text they are.

Deleting a word does not translate the ones left behind either. Hindi showed
"loan asset" where the English said "the loan asset", and Korean
"permission signing…" for "Signing the permission…" — English with the small
grammar words dropped, which is exactly what a hurried edit removes. Eight more
strings, now recorded. The reverse — text that keeps every English word and adds
others — is deliberately left alone: that has words from somewhere, and calling
it untranslated would invent work against a translation someone had started.

Repeating a word does not translate it either, and that one arrived last: a
label reading "Settings Settings" is longer than the English, and a check
counting words rather than looking at which words they are let it through. Reordering, deleting and
repeating are all just arrangements of the same vocabulary, and each had been
found separately before the shape common to all three was.

The question the check settles on is deliberately the narrow one — is every word
here a word from the English this text is meant to translate? — and not the
broader "is this English", which sounds better and cannot be answered without
knowing the languages involved. The question is asked of the letters rather than
the words, because where one word ends and the next begins is itself something
an edit can change: "Set-tings" is two fragments to a machine and mangled
English to a reader. So the check asks whether the letters can be cut, end to
end, into English words from the source — which covers reordering, deletion,
repetition and moved punctuation together, in any combination, instead of one
at a time. Text that adds an English word the source did not have
still passes. The broader rule was tried and measured: treating every word in
the English as a dictionary would add seventeen entries to the backlog, and
almost all of them are correct translations that happen to share a word with
English — the French for "more", for "primary", for "one year". Seventeen
invented debts to catch one imagined case is a bad trade for a list whose whole
value is that every line on it is real work.

A small number of strings are correct even though they match — the product
name, and standard trading acronyms that are used untranslated everywhere.
There is also one heading where the French genuinely is the same two words as
the English in the other order, which no comparison of words can tell apart
from a rearranged English sentence; and the French words for notifications and
positions, which are spelled exactly as the English ones. Those last are worth
separating out from the backlog rather than leaving in it: the backlog is a list
of translations someone owes, and it can only be worked down by changing text.
An entry whose translation is already correct could only leave it by being
replaced with a worse synonym, which would make the list impossible to finish
honestly.

The same applies to the full stop that closes the consent sentence. Arabic,
German, Spanish, French and Korean all end a sentence with the same mark English
does, and in each of those languages the rest of that sentence is fully
translated — which is the evidence that the mark is a choice rather than
something nobody touched. Those five are recorded as correct. Hindi, Japanese,
Tamil and Chinese genuinely end the sentence differently and are still watched:
changing the Japanese ending back to the English one still fails. Those are listed separately, each with a
written reason, with the English wording it was granted against, and — where
the accepted text is not the English one — with that exact text, so that
rewording either side makes the exemption stale rather than letting it quietly
carry over to text nobody looked at again.

One more way a piece of text can read as English while comparing as
something else: swap a letter for an identical-looking one from another
alphabet, or hide a mark from one inside a word. A Cyrillic "e" in "Settings" is
a different letter to a computer and
the same shape to a reader, so the check saw a German word where the screen
showed an English one. Rather than keep a list of every lookalike character —
which is a list that is never finished — the check now records which alphabets
each language is actually written in, and rejects a letter from anywhere else.
Nine short declarations, and the whole class goes with them. It does not catch
a lookalike drawn from an alphabet the language genuinely uses, and the check
says so rather than implying otherwise. Accent marks are untouched, because the
marks that sit on ordinary letters do not belong to an alphabet of their own —
only ones that do are rejected.

The opposite shape is caught as well: text that contains no words at all where
the English is a sentence. A label replaced by a single ellipsis was accepted
before, because it plainly is not the English wording — and "not the English
wording" was the only question being asked. A reader would have seen punctuation
where a sentence should be. Three real cases turned out to be correct, and they
say something about how sentences get split for translation: an offer footer is
assembled from a lead, two links and a tail, and German, Spanish and French put
the closing noun in the lead, which leaves the tail as nothing but a full stop.
That is a written judgement now, recorded with the exact text it accepts.

Digits are not words for this purpose either. A label replaced by "123" counted
as having a word and slipped past — which is right when comparing what words two
texts share, and wrong when asking whether there is anything to read. The two
questions now use two tests. Nor do invisible letters: one Korean character is
simultaneously a letter, invisible, and part of the Korean alphabet, so adding
it to an ellipsis satisfied three separate rules at once while showing the
reader nothing. Every comparison here now drops invisible characters before
looking. Characters that are not letters, marks, numbers, punctuation or
spaces are handled the opposite way — they are rejected outright rather than
ignored, unless they are on a short list of symbols the copy actually uses:
twelve of them, counted rather than guessed.

That list exists because the alternative kept failing. Seven separate reviews
each found one more character that looks like something other than what it is —
a wide letter, a wide full stop, a zero-width space, a Cyrillic letter shaped
like a Latin one, a mark from another alphabet, an invisible letter, a control
character — and each fix closed exactly the one that had been found. The
eighth review produced two more, including a character that reverses the
direction of the text after it, so that a backwards word renders forwards and
reads as English. Listing what is allowed ends that sequence: anything else
fails without anyone having to think of it first, and adding a new symbol is a
deliberate edit somebody reviews.

There are deliberately no rules-of-thumb about what is exempt. An earlier draft
excused anything with no letters in it, on the reasoning that punctuation cannot
be translated. That is simply untrue: the sentence ending is a full stop in
English and an ideographic full stop in Chinese — a different mark, not a wider
drawing of the same one — so the rule would have allowed a real piece of Chinese
to quietly revert to the English mark. Each exemption is now written down and
justified individually.

The same reasoning applies to the record itself. It stores the English wording
each entry was written against, because if the English changes the untranslated
text no longer matches it — and a check that treated that as evidence of
translation would erase the debt precisely when someone edits the source.

The failure message also stops giving the wrong instruction. The existing
suggestion — fill in whatever is missing — walks straight past text that is
present but untranslated, so following it would report nothing to do on a
language the check had just failed.
