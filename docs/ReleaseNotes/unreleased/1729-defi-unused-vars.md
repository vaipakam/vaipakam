# apps/defi: the lint rule now honours the "deliberately unused" naming convention

The lending app's lint run reported twelve unused declarations. Half of them
were not oversights at all — they were already named with a leading underscore,
which is the conventional way to write "this is bound on purpose and not meant
to be read": a destructured field the surrounding code does not need, a
placeholder parameter that exists to reach the one after it, a discarded slot in
a tuple.

The rule has no such convention switched on by default, so it flagged all six
and the intent written into the names counted for nothing. The usual way that
gets resolved is by editing the six sites; the better fix is to tell the rule
about the convention the codebase is already using, which is what this does.
Nothing about those declarations changed.

That leaves six that really were dead: three test helpers imported but never
called, and three address constants left behind by earlier edits. One of the
constants looked live at a glance — a `WETH` address, in a file that mentions
WETH twice more — but both of those are the plain text "WETH" being checked as a
token symbol, not the address. It was confirmed unused before removal, not
assumed.

The app's lint total drops from 270 problems to 258, all twelve from this group,
with no change to behaviour: the six that stay are named exactly as they were,
and the six that go were referenced by nothing.

One deliberate scope note. The sibling app carries the same rule and the same
underscore convention, but has no declarations of this kind today, so the option
is not added there — it would be configuring for a situation that does not
exist. If that changes, the same one-line answer applies. This also is not a
change to any shared lint configuration: the two apps keep separate configs, and
the only shared one is a narrow guard covering a single unrelated rule.

A second rule in the same app was reporting the same kind of thing, and is
included here for the same reason. A timeline component maps a dozen activity
kinds onto a single icon by listing their labels together — a normal, permitted
way to write it. What the rule objected to was that two of those labels carry a
short note explaining why they joined the group: a comment sitting between two
labels stops the group counting as empty, and the check then reads it as a
missing `break`. The two reports were precisely those two notes.

The choice was to delete useful explanations to satisfy a rule that is not about
explanations, or to tell the rule that bodyless label groups are fine. The
latter, with one caveat worth stating: the dangerous case — a branch that does
real work and then silently continues into the next one — is still reported.
That was confirmed against a throwaway example rather than assumed, since
relaxing a correctness rule on the strength of a plausible-sounding option would
be the wrong way round.
