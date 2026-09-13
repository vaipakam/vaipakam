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

Closes #2125. No product surface changes.
