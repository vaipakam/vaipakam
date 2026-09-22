## Thread — Assembly now refuses a fragment heading that cannot survive publication (PR #2290)

Release notes are built by folding one file per change into a dated
document. Each fragment becomes a section under that day's title, and its
heading is the only part of it that has to fit a shape. Two ways of getting
that shape wrong had been reaching published files unnoticed: a heading
written at the document's own level, which renders as a second title rather
than as a section of the release, and a heading still carrying the
template's `(PR #<n>)` placeholder, which leaves a published section with
nothing pointing back at the change it describes. Nothing between writing a
fragment and publishing it had ever looked at the line, and assembly is the
last step that reads it — so what got past went out. About a sixth of all
published section headings carry a placeholder today, and 32 published
sections render as peer titles (#2291).

Assembly now stops on either, before anything is written or any fragment is
consumed, and names the file and the problem. **What it refuses is
deliberately narrow, and the narrowness is the point.** A heading at `###`
or deeper is allowed, with a warning: about one fragment in ten opens that
way, some of it work in flight, and refusing them would stop legitimate
work over a heading level. The warning matters because such a heading is
not merely untidy — folded after a shallower one it becomes a *subsection of
that other change*, so an outline can present it as something an unrelated
change does or does not do. Two published sections are in that state today;
a third, with only the generated release title above it, instead skips a
level. A heading carrying no reference at all is likewise
allowed, because most fragments carry none: the template's convention is
not a rule the corpus follows. What is refused is the failure the template
actually produces — shipping the placeholder and leaving it unsubstituted.
Every one of those decisions was settled by counting the fragments and
published headings that exist, not by reasoning about what a fragment ought
to look like; twice during review the obvious stricter rule turned out to
refuse the majority of real work.

The check reads one line — the fragment's first line of content — and
recognises a heading there only in `#` form. A title underlined instead of
prefixed, a heading further down the file, and raw HTML are not examined. A
fragment that opens with `---` is refused outright rather than interpreted,
because in its own file that is front matter and once folded it is a
thematic break — the assembler publishes what the author wrote rather than a
cleaned-up copy of it. That is a deliberate
trade rather than an oversight:
an earlier version scanned for the first heading anywhere in the file and
produced six separate ways to be fooled, each one causing a real heading
below to be skipped entirely. Reading a single line cannot mask anything.
The residuals are written down where the rule lives and each is pinned by a
test, so narrowing them later is a deliberate act.

Contributors have one new obligation, and it is documented beside the
instruction that creates it: once GitHub assigns a PR number, put it in the
fragment heading before the day's notes are assembled. Closes #2288.
