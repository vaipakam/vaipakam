## The standing rules now point at the canonical specification

With the first canonical section merged, the documents that state how
intended behaviour is recorded now say what the canonical specification
design asks of them (its section 15).

Intended behaviour is stated in the canonical folder, one numbered
statement at a time, wherever a section there is canonical, and in the
functional specs for everything else. No pull request edits either. A design
that changes a canonical statement brings the change to the owner with the
design, and the thread that keeps the folder writes it once approved.

A pull request that changes behaviour now names the statements it implements
in a new "Statements" section of its description. It may instead say it
changes no behaviour, or that no canonical section covers what it changes.
The merge check on main reads the merged description and warns when none of
the three is there, or when an id names no statement in the folder. It used
to look for an edit under the functional specs.

The functional specs' README now lists the sections the canonical folder has
replaced. The agent instructions, the procedures document and the pull
request template say the same.
