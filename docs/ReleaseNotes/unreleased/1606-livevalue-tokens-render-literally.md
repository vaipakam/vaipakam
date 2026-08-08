## The referenced figures reached the pages, but not the other three surfaces

A separate change (#1615) fixed the reason the documentation's referenced
figures were reaching readers as raw token text, and recomputed the worked
examples that had drifted. This finishes the same job on the surfaces that
fix did not touch, all found while verifying it.

**The machine-readable copies.** The site publishes plain-markdown copies of
the same documents and advertises them for automated consumers. Those copies
were written out verbatim, so every one of the 420 placeholders in them
survived after the pages themselves were correct — an automated reader was
still being handed the internal syntax. They are now substituted from the
same shared values the pages use, so the two cannot disagree about what a
figure means.

**The language of the figures.** They were formatted in English on every
page regardless of the reader's language. On a German page, English digit
grouping turns a twenty-thousand-token threshold into something that reads
as twenty — a two-orders-of-magnitude misstatement rather than a cosmetic
one. Figures now follow the language of the document.

That turned out to be half a rule, which review caught. Some documents are
published in English whatever address the reader arrives at — the whitepaper
and the parameter reference have no translations — so following the URL's
language put German grouping, and on one route a different numeral script,
inside English sentences. Others fall back to English when a translation is
missing. Figures now follow the language of the document actually shown, and
pages that always show English declare it.

**The documentation search.** A third place substituted these figures, with
its own English-only copy of the values. A reader on a German page could not
find that page by searching for a figure visible on it, and result snippets
contradicted the page they led to. It now reads the same shared values,
formatted for the document being indexed.

**What keeps it from lapsing again.** The original fault was invisible to
type checking, to linting, and to any check that runs before publication. A
new check renders the real pipeline and asserts the outcome across every way
a document can produce a code span — thirty-seven assertions covering both
substitution paths, the deliberate escape hatch that lets the docs describe
this mechanism, unrecognised names staying visible rather than vanishing, and
the two paths agreeing with each other. Each was confirmed by reintroducing
the fault it guards against.
