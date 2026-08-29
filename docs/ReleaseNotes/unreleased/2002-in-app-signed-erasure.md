## The promised in-app erasure of support's error reports now exists (PR TBD)

The Privacy Policy tells users, as a statement of legal right, that the
error-diagnostics records associated with their wallet can be erased
"by signing an erasure request with that wallet in the app". The
service behind that promise has existed for months; the app control had
not. A user who went looking for it found only the Data Rights page's
honest admission that error reports held by support were out of its
reach.

The control now exists, on that same page. Connect the wallet, sign a
free message — not a transaction, no gas — and the request goes to the
service, which erases the records keyed to that wallet. A companion
check asks whether anything was retained.

The interface is deliberately as reticent as the service it talks to.
The service's confirmation is uniform by design: it never says whether
any records existed, because records can be under a legal retention
order the service is forbidden to mention, and one wallet's answer must
not read differently from another's. The page says exactly that, in the
same words to everyone, rather than dressing the confirmation up as
"deleted N records". The retention check reports something only where
the law permits saying so, and its quiet answer is phrased as "none are
reported" — never "none exist", which the page cannot know.

The signed message itself now lives in one shared module imported by
both the app and the service — the two must produce byte-identical
text, or every request would be rejected, and a second hand-written
copy was the likeliest way this feature could have shipped broken.
The two operations sign different messages, each saying what it
authorises: the words a user signs to look at their records can never
be replayed as authority to delete them.

One honest limit, stated where it applies: a smart-contract wallet's
signatures cannot be verified by the support service yet, so a
deployed one is shown the working email route instead of a prompt
that could only fail. Verifying those signatures properly, across
every signed request the service accepts, is tracked as its own
follow-up (#2009).

Closes #2002.
