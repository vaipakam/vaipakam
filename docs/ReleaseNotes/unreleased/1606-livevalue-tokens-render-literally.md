## The docs were showing their own placeholder syntax instead of the numbers

Anyone reading the public docs saw raw template text where a fee should
have been. The overview page's "what does it cost" section said
`Yield Fee — {liveValue:treasuryFeeBps}% of the interest and late fees`
rather than `Yield Fee — 2%`. The same held across the whitepaper, the
user guide and the parameter reference, in every language — 363 embedded
values in the source content, none of them resolving.

The mechanism exists so that when governance retunes a fee, the pages
say the new number without anyone editing them. It had silently stopped
working. The markdown renderer distinguishes an inline value from a
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

The fix reconstructs the inline-versus-fenced distinction from the shape
of the document rather than from a question the library may or may not
answer, so it cannot lapse the same way again. Alongside it, a new check
renders the real doc pipeline and asserts on the outcome: an inline
value resolves to a number, a fenced sample stays literal so the docs
can still explain the mechanism, and an unrecognised name renders
visibly rather than vanishing. That check runs with the rest of the
per-change verification, so the failure now surfaces on the change that
causes it rather than after publication.

Verified against a real render of all 111 pages: 570 pieces of leaked
placeholder text before, none after, and 40 pages now showing live
figures. The reader-visible result is that the overview page states the
yield fee as a percentage again.

One incidental note on the fix's own shape: the change needed a
component to consult shared state, and the repository's newly-added
hook-order guard rejected the first attempt because the renderer
functions were named in a way that made them look like plain helpers
rather than components. The guard was right — it cannot know the
markdown library renders them as components — so they were promoted to
properly named components rather than the warning being suppressed.

Closes #1606
