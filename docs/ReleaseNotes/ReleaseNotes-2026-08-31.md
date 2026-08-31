# Release Notes — 2026-08-31

One entry, on a promise the platform makes in two places and was keeping in
neither reliably. A support report is a pre-filled public issue, and both the
report builder and the Privacy Policy state that a full wallet address never
leaves the device through one. An address arriving percent-encoded passed the
scrubber untouched, and a single decode recovered it. The fix reaches
considerably further than that first gap — nested encoding, budgets that fail
closed, bounded input, and the same rule now shared with the service that
receives support tickets rather than kept as a second, weaker copy there.

## Thread — Support reports no longer leak percent-encoded wallet addresses (PR #2026)

The Diagnostics drawer builds a support report as a pre-filled GitHub issue,
and everything in it passes through an address shortener first — the module
states the contract in its own header, and the Privacy Policy repeats it to
users: the full wallet address never leaves the device via a report. That
held for an address written plainly and did not hold for one that arrived
percent-encoded.

The page address the report carries is taken raw from the browser, and a
browser does not decode escapes in a query string. So a link carrying its
wallet parameter in encoded form presented no recognisable address to the
shortener, and the untouched escape sequence travelled to GitHub — where a
single decode recovers the full address, on a public issue tracker. The
scope is narrow, since it needs a user to arrive on such a link and then
open a report, but a redaction promise is exactly the kind that should hold
without qualification.

The shortener now finds those too. It decodes for the search only and keeps
a map back to the original text, so the shortening is applied to the span
the address occupied and everything around it keeps its exact spelling —
the rest of the link still reads as the user had it, which is part of what
makes a report useful to support. Decoding is done by hand rather than with
the browser's own decoder, which rejects malformed escapes by throwing: a
helper that runs inside the crash reporter must not become a crash source,
so a stray percent sign now passes through untouched instead of ending the
report.

A recorded error is whatever the failing code handed the browser, and a
provider can hand it several megabytes. The shortener now stops reading at
64 KB in every case — including the ordinary one where a message carries no
escapes at all, which had been quick enough per character to step around the
limit unnoticed — and marks the report truncated there, rather than scrubbing
the whole of a message the report keeps twelve hundred characters of — a few seconds
of a frozen drawer, immediately after the failure someone is trying to
report, is a poor way to ask for help. The cut is also moved back off anything that could be part of an address
before any shortening happens, so a report can never carry the front half of
an account. Getting there took six attempts at the opposite arrangement —
shorten first, then tidy up whatever the cut broke — and each one had to
decide, by appearance alone, whether a piece of text was the shortener's own
work or something the user had written. That is a question about text someone
else controls, and each answer was defeated by a slightly different way of
writing the same thing. Doing the two steps in the other order means the
question never arises. How far back that step reaches cannot be fixed in advance, which took one
more correction to see: a limit of a few dozen characters was set by how long
an address is, but an address written with escapes can be spelled at any
length, so a deeply escaped final digit simply ran past the limit and left the
rest of the account behind it. The step now goes back as far as the run of
address-like characters goes, and stops at the first character an address
cannot contain — a space, a newline, a colon — which ordinary text supplies
constantly. Two things are given up for that, both at the very end of a
message that is already being cut short: an address finishing exactly at the
cut is dropped rather than shortened, and a passage made of nothing but
address characters loses the whole run.

There are two situations the shortener cannot fully account for: a message
too large to read in full, and escapes nested too deeply to unwrap within a
sensible amount of work. In both it now discards the escaped material rather
than passing it on, and — this was the subtler half — discards any hex sitting
against it. Removing only the escapes had looked like the cautious choice and
was not: where just the leading `0x` of an address was escaped, taking the
escapes away left all forty of the remaining characters in place, and a reader
of the public issue is a fixed two-character prefix from the whole account. An
address can be broken at any point, so no leftover is safely short. The cost is
that a word spelled entirely in hexadecimal letters is discarded alongside a
neighbouring escape in those two cases, which is the right way round.

The same promise is made twice, and it was only being kept once. A support
message sent from the app's contact form goes to a service that shortens
addresses again on arrival, on the stated grounds that it cannot trust
whatever built the request — a point that covers a deliberately crafted one
and, more ordinarily, a browser still running yesterday's copy of the app.
That second check knew only how to recognise an address written plainly, so
an encoded one passed it and was stored and forwarded intact. Both sides now
share a single implementation of the rule rather than keeping their own
readings of it, which is also the only way a promise this detailed stays true
in two places as it changes.

The behaviour arrived with its first tests. Nothing had covered the
shortener before, which is how the gap survived unnoticed, and the new cases
are written against the contract rather than the code: what must never
survive a report, and what must survive it intact — a transaction hash stays
whole, and an encoded hash must not decode into a false match. Disabling the
new handling fails exactly the encoded cases and leaves the rest green, so
the tests pin the fix without freezing the parts that were already right.

Closes #2024.
<!-- assembled-fragment: 2024-redact-encoded-addresses.md sha256=1b7b8f183880280303f769efbbecb4fbbf0774a0a94dd84538cfcb56f69de901 -->
