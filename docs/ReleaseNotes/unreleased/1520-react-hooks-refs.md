## Frontend correctness — the ref-during-render lint group, judged site by site (PR #TBD)

The alpha02 app lints against the React hooks plugin's newer rules, with
most of them left advisory while the existing code is worked through
deliberately. This clears the smallest of those groups — reading or
writing a ref while rendering — and turns it into a hard error so it
cannot come back.

The group was expected to be the one most likely to contain real
user-visible bugs. It turned out to be almost the opposite: five of the
six sites are deliberate, and converting them to ordinary state would
have introduced defects rather than removed them. Two of them gate whether
a submit button may be used at all when a security warning is showing;
they compare the live warning against the fingerprint the user actually
consented to, and they read it during render precisely because the effect
that clears stale consent does not run until after the screen has been
painted. Moving that comparison into state would delay it by one render —
briefly permitting a signature against a warning nobody agreed to, which
is the exact window the check exists to close. The others are a
notification panel's "new" dots, which are supposed to survive the read
cursor advancing underneath them, and a rate-ladder change highlight,
which by definition needs the previous snapshot. Each now carries a note
explaining why it stays as it is, so the next reader does not helpfully
"fix" it.

The sixth was a genuine problem and is fixed: a component recorded the
connected wallet address into a ref while rendering, for a background
sync channel to read later. A render that React abandons or double-invokes
could leave that ref holding an address the interface never actually
committed to, and the sync channel would then scope its work to the wrong
wallet. The value is now recorded after the render is committed instead,
which cannot be late for this consumer.

Closes #1520 in part — the three larger rule groups (impure work during
render, state set inside effects, and stale effect dependencies) remain
advisory and are the next slices. Their counts had drifted upward since
the issue was filed, so the issue's table was corrected as part of this
work.
