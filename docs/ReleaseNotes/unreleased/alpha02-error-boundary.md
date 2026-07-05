## Thread — a page crash is never a blank screen (alpha02 ErrorBoundary)

Until now, any unexpected error thrown while a page rendered unmounted
the whole app and left the user staring at a blank white page — the
worst possible moment being right after signing a transaction. The
retail app now contains such failures: the failed page is replaced by
a plain recovery card that says the fault is display-side, that funds
and on-chain positions are unaffected, and that a just-signed
transaction may still have gone through (check My positions after
reloading), with reload and go-home actions. The navigation around the
page stays alive, and simply navigating to another page recovers
without a full reload. A second, outer safety net covers failures in
the shell itself.

Verified by deliberately crashing a page in a local build: the card
rendered with the reassurance copy and the failing component named,
the navigation remained usable, moving to another page recovered
cleanly, and healthy pages were untouched.
