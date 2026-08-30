## Thread — The cron-slot gate constrains its authority instead of parsing Markdown (PR #<n>)

The gate that keeps the Cloudflare cron-slot count stated in exactly one
place had been slowly acquiring a Markdown implementation. Across roughly
thirty review rounds on #1978, two thirds of everything raised landed on
that one file, and the later rounds were almost entirely markup edge
cases — the indentation rule alone went through four iterations, each
correct about the example in front of it. Four more findings were deferred
together rather than fixed, because they were one question rather than four
bugs: how much of CommonMark should a gate whose job is to stop ten notes
disagreeing about a count of five actually implement?

The answer taken here is the one that already worked in this file once
before. An earlier round replaced about eighty lines of HTML-comment
tracking with a rule forbidding HTML comments in the authority outright,
and that closed three rounds of findings permanently. The same move applies
to three of the four deferred findings, so the authority may now no longer
use indented code blocks, block quotes, or a backslash before a table pipe.
Each rule is decidable by looking at a single line, and each was measured
against the document before being written — the file already satisfied all
three, so the constraint costs an editor nothing today.

The fourth finding is deliberately not closed this way and is left as a
documented approximation. It concerns brace depth when a JSON object opens
on the same line as its first key, in the Worker configuration files the
gate reads but does not own. There is no constraint to impose on an author
the project does not control, and the honest position is to say the config
scanner approximates rather than to pretend otherwise.

Two details worth recording. The rules are wired into both the offline and
the live entry points in the same commit, because the file already carries a
note observing that checks get written into one and forgotten in the other.
And the constraint caught its own documentation on the first run: the
section explaining the pipe rule originally spelled the escape sequences
out, and the gate rejected the file. The fix was the one its own diagnostic
recommends — reword so no escape is needed — which is reasonable evidence
the constraint is liveable rather than merely enforceable.

Closes #1990.
