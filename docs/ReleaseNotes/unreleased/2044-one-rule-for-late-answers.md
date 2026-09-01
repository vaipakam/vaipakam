## Thread — A late answer can no longer speak for a newer question (PR #<n>)

Several buttons in the app do something that takes a moment and then report
how it went — copying to the clipboard, asking a wallet to add a token. If you
press one twice, or press it and then move on, two answers can be outstanding
at once, and until now whichever arrived last was the one displayed, regardless
of which question it belonged to.

That produced small untruths of the worst kind: a button saying it had copied
something when the copy was refused, or saying a copy failed when it had
worked. The same shape appeared on the testnet faucet, where a request to add a
token to your wallet could sit waiting for your approval while you minted a
second token — and approving it then marked the *new* token as added, when what
you agreed to was the previous one.

**Every one of these now ignores an answer to a question that has been
superseded.** Press twice and only the second result is shown. Move on to
something else and the earlier answer is discarded rather than applied to what
is now on screen.

**And a confirmation now says what it is about.** Ignoring a superseded answer
turns out to cover only half of it: if you leave a wallet prompt open and then
switch account or network, or a list of addresses redraws with different rows,
nothing has superseded the answer you are waiting on — the question underneath
it has simply changed. A button that only remembered "yes, that worked" could
not tell. So each of these confirmations now records *which* address, token,
wallet and network it was earned by, and shows itself only beside that one. An
answer that arrives about something you have moved on from is no longer
applied to what replaced it, and "Added to your wallet" no longer stands over a
wallet that was never asked.

**Where a control stays quiet, that is deliberate**, and it is about not
crying wolf. When a wallet declines to add a token, that is usually because you
declined it — and the app cannot tell your decision apart from a genuine error,
so reporting one would be guessing at your intent. The small address chips that
copy an account are quiet for a different reason: they simply do not flip to
"Copied", which is the whole of what they claim. The two controls that do make
a claim in words — the diagnostics report and the testnet faucet's token ID —
say plainly when they could not do what they were asked.

The rule is now written down in one place rather than repeated at each button.
It had been fixed four separate times in the preceding change, each time
correctly and each time only where it had been noticed; four is the point at
which a habit should become a thing that exists.
