## Contracts — the price-guard pointer waits at least the guard's own seven days (PR #<n>)

The price guard refuses any delay under seven days for changes to its own
sources and settings. The protocol registry, which tells the Diamond which
guard to use, only required three days for any pointer change. So pointing
the registry at a brand-new guard was a faster way to change every price
than changing a setting on the guard itself, which undercut the guard's
seven-day review window.

The registry now holds a fixed minimum wait per entry. The price-guard
pointer's minimum is seven days, equal to the guard's own floor, and a
proposal for it waits the longer of that and the registry's current delay.
Every other entry keeps the registry's delay (three to thirty days), so the
treasury, backstop and adapter changes are not slowed. The minimum is a
constant in the registry's code rather than a figure read from the guard
being replaced, so the outgoing contract never decides how long its
replacement waits. A test keeps the two seven-day figures equal.

The registry is not upgradeable, so this reaches a chain only with a new
registry, at the next fresh deploy. Unlike the guard's own delay, which a
testnet may set to zero, the registry has no testnet exception: a testnet
guard swap through the registry waits seven days too. Testnets change
guards by fresh deploy, so nothing in current operation waits on it.

Closes #3540.
