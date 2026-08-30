## Thread — Support reports no longer leak percent-encoded wallet addresses (PR #<n>)

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

The behaviour arrived with its first tests. Nothing had covered the
shortener before, which is how the gap survived unnoticed, and the new cases
are written against the contract rather than the code: what must never
survive a report, and what must survive it intact — a transaction hash stays
whole, and an encoded hash must not decode into a false match. Disabling the
new handling fails exactly the encoded cases and leaves the rest green, so
the tests pin the fix without freezing the parts that were already right.

Closes #2024.
