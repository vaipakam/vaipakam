# A Terms acceptance now closes the prompt in every open tab (#2001)

Accepting the Terms of Service costs a transaction, and the protocol
happily accepts a second one from the same wallet — it changes nothing
but a timestamp and still charges gas. The app already made sure the
tab you accepted in could not offer that second transaction; a second
open tab, holding the same wallet, could. It still showed its own
prompt with a working Accept button until its next background refresh,
and the moments right after accepting in one tab are exactly when
someone is most likely to click in the other.

Now the tab that accepts tells every other open tab, the instant the
transaction is confirmed. In the ordinary case the others close their
prompt and allow the wallet's next action without asking again — and
they take on the same safeguards the accepting tab has, for the same
bounded time, expiring at the same moment everywhere: an acceptance
undone by a chain reorganisation is not believed anywhere for longer
than in the tab that made it. An acceptance that took unusually long
to confirm — congestion can hold a transaction pending past that
bounded window — is announced as a signal to re-check instead: the
other tabs verify against the chain at once and close their prompt on
what they read, rather than taking the late news on trust. A tab that has meanwhile learned of a newer terms
version is deliberately left prompting: an acceptance of older text
never opens the gate on newer text.
