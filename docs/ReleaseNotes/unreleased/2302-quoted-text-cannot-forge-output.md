## Text quoted back from a fragment can no longer rewrite the assembler's messages (PR #2323)

When the release-note assembler refuses a fragment, it quotes the offending
line and names the file, so the author can find what to fix. Nothing filtered
what it quoted. A terminal acts on control sequences rather than printing
them, so a fragment whose opening line carried the right few bytes could
erase the refusal on screen and print a success message over it. The run
itself still refused — nothing was published and nothing was deleted — but
the operator's view of what happened could be forged, which is the one thing
a tool built to refuse clearly must not allow.

Every message now passes through one point that shows each control character
as a visible escape such as `\x1b`, instead of letting the terminal act on
it. That covers file names as well as quoted lines, and any message added
later. The characters are shown rather than removed, because a stray control
character in a file name is something the operator needs to see in order to
find the file. The invisible characters that reverse the direction of text
are treated the same way, since they can reorder a line on screen without
any control sequence. Ordinary text, including the em dash every heading
here uses, is printed as before.

Anything quoted from a fragment — a line, or a list of the references it
refused — is also cut off after 160 characters as a whole, with a note of how
much was left out, so a long line or reference list cannot bury the message
around it. Closes #2302.
