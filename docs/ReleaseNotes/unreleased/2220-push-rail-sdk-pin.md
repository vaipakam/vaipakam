## Thread — the Push rail can send again, because the pin was the bug (PR #<n>)

Push notifications on this deployment had not been issuing anything. The
platform's Push client was pinned to a version that signs its verification
proof with a method belonging to an older signing library, while the workspace
supplies a newer one that names that method differently. The failure happened
before any request left the Worker, so every Push notification — health-factor
band alerts and periodic-interest pre-notices alike — failed having sent
nothing. Telegram was unaffected throughout.

The cause turned out to be narrower and more mundane than "a dependency
decision". The pin read `^0.0.1`, and for a version below `0.1.0` that caret
does not widen anything: it means exactly `0.0.1`. So the range could never
have reached the 1.x line, and a comment that once named the intended range had
been edited to agree with the install rather than the other way round. That
same pinned version declares that it needs the *older* signing library, against
a workspace that has shipped the newer one for some time — a requirement that
was unmet all along without anything failing loudly. Moving to the current
release fixes the mismatch at its source: that release declares support for
both signing libraries and adapts internally, which is the arrangement the
project actually needs.

Two details were load-bearing and would each have left the rail dark while
looking fixed. The first is the guard added when this outage was diagnosed: it
asked whether the signer exposed the one method the *old* client called, so
after the upgrade it would have gone on refusing the perfectly usable signer
the platform has, and reported that refusal in the same words it uses for an
unset key — an outage indistinguishable from "not configured". It now mirrors
what the client itself does, accepting either signing style. The second is a
log filter that exists to stop the client writing subscriber wallet addresses
into Worker logs; its own comment required re-checking the marker whenever the
pin moved, and the pin has now moved. The check was run: the current release
does not log on the sending path at all, so the filter is inert. It is kept
rather than deleted, because an inert filter costs a few lines while a
wrongly-removed one costs user privacy.

The functional specification gains the intent this outage violated: a delivery
rail is offered only while the platform can actually issue on it, a rail that
cannot send is an outage rather than a staged feature, and whether a rail can
send is decided by asking what the signer exposes rather than by interpreting a
failure message after the fact.

Verification is deliberately not a unit test. A mocked client cannot witness a
mismatch between real libraries — that is why the original break survived the
suite, and the same trap reappeared one layer up during this change, where an
incomplete test double produced a failure that looked like a provider
rejection. Closing this properly means sending one real notification to the
production channel and confirming it arrives.

Closes #2220. Follow-up, deliberately not folded in: the Push rail exists as
two near-identical copies, one per Worker, and they have already drifted — only
one of them carries the request-accounting introduced when this outage was
diagnosed. Hoisting it to a single shared implementation is filed separately.
