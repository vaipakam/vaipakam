## Connected app — two stale-value hazards in the notification bell and the recovery form (PR #TBD)

The connected app's lint configuration keeps React's hook rules visible as
advisories and promotes each one to a hard error only once the existing code
is clean against it, so the standard is raised deliberately rather than
declared and then ignored. This is the second such group: the rule that
checks an effect or memo actually declares the values it reads.

Four reports, two underlying causes, both the same shape — a value that
could not be declared as the dependency it already was.

The notification bell derived its row list with a fallback to an empty list
on every render. The list the server sends is stable between renders, but
the fallback produced a brand-new empty list each pass, so the unread count
was recomputed and the mark-all-read action rebuilt every time the component
rendered, whether or not anything had changed. The derivation is now
memoised, so both settle when the feed does.

The asset-recovery page resets itself to a blank form in two places: when the
connected wallet or network changes, and when another browser tab writes a
recovery record for the same account. That reset helper was redefined on
every render, which meant the two effects could not name it as a dependency
without re-running the reset on every render — so it went undeclared, and the
effects were, on paper, reading a value they did not admit to. The helper is
now stable (it only clears form fields, so it never needs to change), and
both effects declare it. Behaviour is unchanged: the resets still happen
exactly when identity changes or another tab writes.

Also removed four suppression comments that no longer suppress anything —
their rules are switched off in this configuration, so the comments were
telling future readers a check was being waived when none was running. The
one explaining why a regex deliberately matches control characters keeps its
explanation, as a plain comment.

With the group at zero, the dependency rule is now enforced as an error, so a
future effect that quietly reads an undeclared value fails the build instead
of joining a backlog. Refs were promoted the same way in the previous slice;
purity and set-state-in-effect remain advisory and are tracked in #1520.

No user-visible behaviour changes.
