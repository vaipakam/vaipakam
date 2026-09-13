## Thread — Forced-close amount scanner learns each language's duration words (PR #TBD)

The check that watches the lender's forced close-out card on the deployed
build refuses any figure the card cannot substantiate, and exempts the few
kinds of number the card is allowed to show: a duration such as the grace
window, a proportion, an identifier. Those exemptions knew only English
words. A grace-window sentence written with a figure in Japanese, Hindi,
Tamil, Korean or Chinese, five of the shipped languages, would therefore
have been reported as an invented amount on copy the specification
explicitly permits. Nothing was failing, because no shipped translation
currently writes the window with a figure, but that was luck rather than a
guard, and the first translator to add one would have turned the live
check red on correct copy.

The scanner now has to be told which language the text is rendered in,
and takes that language's duration words from the same standard locale
data the browser itself formats with, in every grammatical number and in
long, short and abbreviated forms, so the list cannot drift from what a
reader is shown and a language added later needs no edit. The live drive
passes the language it pins its browser to; the test that puts every
shipped translation through the scanner passes each bundle's own. Two
edges are stated rather than guessed at. In languages that write no space
between a number's counter and the word after it, the unit is recognised
only where the text continues in a different script, so a counter
followed by a particle is a duration while the word for yen is still an
amount. And a one-letter unit in an alphabetic script is treated as an
abbreviation that might mean a magnitude, in every language, so it is
reported unless something around it establishes a wait; a single Chinese,
Japanese or Korean character is a whole word and is not. A caller that
does not name the language gets the English words alone, and a
non-Latin duration is then reported, which is the loud direction rather
than the silent one. Asset glyphs and tickers are unaffected: the sourced
words are duration words, never a licence for any non-Latin token.

Review tightened the derivation in five places: a language that writes
the unit before the number is read from the word in front; abbreviations
the locale data writes with punctuation are stored in the same shape the
scanner reads; the sample numbers used to collect every grammatical form
are taken from each language's own plural rules rather than a fixed list;
a counter followed directly by a ticker or asset glyph is not a duration;
and a one-letter symbol classifies the same whether its accent is stored
composed or decomposed. A second round kept a multi-word unit as one
phrase, so a linking word inside it is never a unit on its own; judged the
first word after a counter even when a particle follows it, so a
denomination there is still an amount; matched units regardless of
sentence capitalisation, in the language's own casing rules; and made the
per-language cache immune to a malformed language tag masquerading as a
list of tags. A third round taught the scanner the forms a unit takes in
a sentence rather than standing alone, such as the German dative after
"in", by reading the same locale data's relative-time phrases; narrowed
the unspaced-script rule so that only Japanese grammatical script after a
counter reads as a particle, since the script used for loanwords is also
where asset names are written; and let a duration written before the
number stand when an asset is merely mentioned later in the sentence, as
one written after the number already did. A fourth round read which side
of the number a unit sits on from each phrase rather than assuming it,
treated a money sign glued to a counter as the amount it is, applied the
existing quantity guards to a unit written before the number, let a
language's own words for "in" and "ago" establish that a one-letter unit
means time, and counted a letter written with a combining mark as the
single letter it is. A fifth round moved the language vocabulary and its
matching rules into their own module, leaving the scanner as their
consumer; read the words on either side of a whole number, so a decimal
could not misfile a context word as a unit; preferred a language's own
longest phrase to an English abbreviation; learned both "in" and "ago"
forms for languages with a single grammatical number; kept a malformed
language tag in a fallback list from raising an error at match time; and
matched phrases whose words carry abbreviation marks.

Closes #2125. No product surface changes.
