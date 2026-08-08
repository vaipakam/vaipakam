## The docs were showing their own placeholder syntax instead of the numbers

Anyone reading the public docs saw raw template text where a fee should
have been. The overview page's "what does it cost" section said
`Yield Fee — {liveValue:treasuryFeeBps}% of the interest and late fees`
rather than `Yield Fee — 2%`. The same held across the whitepaper, the
user guide and the parameter reference, in every language — 363 embedded
values in the source content, none of them resolving.

The mechanism exists so that these figures live in one place instead of
being retyped into 363 sentences across four documents and every
language. It had silently stopped working. The markdown renderer distinguishes an inline value from a
fenced code sample, and the code doing that asked the markdown library a
question the library stopped answering two major versions ago. The
answer came back empty, which read as "this is a code sample", so every
value was left as literal text. The pages had been quietly printing
their own internals.

Three things that should have caught it could not. The type checker
could not: the discarded question was declared as an optional input, and
an optional input that is never supplied is indistinguishable from one
that is legitimately absent. Linting could not: nothing about the code
is malformed. The page-snapshotting step would have, since it renders
every page for real — but it only runs during a deploy, so it would have
noticed after the broken pages were already public.

The first attempt at a fix rebuilt that distinction from the shape of the
document. It worked, but it was solving a problem that did not exist: the
recogniser only ever matched a value standing completely alone, and code
samples always arrive with a trailing line break that disqualifies them
automatically. The distinction had been holding on its own the whole
time. So the fix is smaller than the first attempt — the discarded
question is simply removed, and nothing replaces it. That also removed
the new page-element wrapper the first attempt introduced, which had been
adding stray attributes of its own. Alongside it, a new check
renders the real doc pipeline and asserts on the outcome: an inline
value resolves to a number, a fenced sample stays literal so the docs
can still explain the mechanism, and an unrecognised name renders
visibly rather than vanishing. That check runs with the rest of the
per-change verification, so the failure now surfaces on the change that
causes it rather than after publication.

Verified against a real render of all 111 pages: 570 pieces of leaked
placeholder text before, none after; 5,728 stray attributes before, none
after; and 40 pages now showing figures. The reader-visible result is
that the overview page states the yield fee as a percentage again.

**What this does not do.** Review caught an overclaim in an earlier draft
of this note, and it is worth stating plainly rather than quietly
deleting. On the public site these figures come from values bundled into
the page at build time — the marketing pages deliberately do not talk to
the chain, and the component's data source there is a stub that always
reports "no chain reading available". So a governance change to a fee does
**not** propagate to the public pages on its own; they still need a
rebuild, and if a bundled default has drifted from the deployed value it
needs correcting in one place. The benefit delivered here is the single
place, not automatic freshness. Reading the real value from the chain on
the public site would be a separate piece of work, tracked separately.

Review then found a second, older defect one line away from the first.
The renderer forwards the markdown library's leftover properties onto the
underlying page element, and one of those is an internal handle the
library passes to every custom renderer. It was being written into the
page as a literal, meaningless attribute — on 5,728 inline code elements
across the published pages, and it had been doing so for as long as that
renderer had existed. The new fenced-block renderer would have added ten
more of the same. Both are now stripped, and the new check asserts the
attribute never comes back, so this cannot quietly resume either.

Review then found the fix incomplete in two ways that mattered more than
the mechanism. The published machine-readable copies of the same
documents — the ones the site advertises to AI crawlers — were still being
copied out verbatim, so 420 placeholders survived there after the rendered
pages were clean; they are now substituted from the same single registry,
so the two cannot disagree about what a value means. And the numbers were
being formatted in English regardless of which translation a reader was
on, which was harmless while nothing rendered and misleading the moment it
worked: on a German page, English grouping turns a twenty-thousand-token
threshold into something that reads as twenty. Both the pages and the
published copies now format for the language of the document.

Substituting the published copies needed care that the first attempt did
not have. Deciding which values to replace means knowing what is prose and
what is a code sample, and the first version worked that out by scanning
lines for fence markers. Testing it against the awkward shapes found two
faults: a document could close a code block early if it contained the other
kind of fence marker inside it, which would have substituted values inside
a sample; and an indented paragraph inside a list was mistaken for a code
sample, which left a placeholder in the published file — the very fault
this change exists to remove. Both came from re-deriving document
structure. The pages never had to: they receive an already-parsed document
and only ever see an inline value as an inline value. The published copies
now do the same, so every block form is excluded because of what it is
rather than because a rule remembered to exclude it.

Making the figures follow the reader's language then turned out to be
half a rule. Some documents are published in English whatever address the
reader arrives at — the whitepaper and the parameter reference have no
translations — so following the URL's language put German digit grouping,
and on one route a different numeral script, inside English sentences.
Others fall back to English when a translation is missing. The figures now
follow the language of the document actually shown rather than the address
it was reached through, and the pages that always show English say so
explicitly. The documentation search index was a third place doing its own
substitution with its own English-only copy of the values: a reader on a
German page could not find that page by searching for a figure visible on
it. It now reads the same shared values and formats them the same way.

One thing this surfaced that is not fixed here: the worked examples in the
documents still calculate the older fee rates from before the rates were
raised, so a reader can now see the correct rate in one sentence and an
example computing the old one in the next. That is a content correction
across ten translations, including derived totals that cannot be
reconstructed from the text, so it is tracked separately rather than
guessed at — publishing confidently wrong arithmetic in ten languages
would be worse than a visible inconsistency. One unambiguous case, a
constant contradicting the value beside it in the same sentence, is
corrected here.

Because the surviving mechanism now rests on that trailing-line-break
property, the new check enumerates every way a document can produce a
code element — inline in prose, in a list, in a quote, in a heading, in a
table cell, in bold, inside a link, and as all three kinds of code block
— so the property is tested rather than merely believed.

Closes #1606
