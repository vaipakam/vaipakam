## Thread — The auto-extend switch stops only the keeper (PR #TBD)

The protocol's automatic-extension switch used to stop every extension and
every reserve deposit. It now stops only the automated route: a keeper
acting under a granted extension permission is refused while the switch is
off, and is charged service capacity only when it acts. The borrower-position
holder (or the manager of that position) can still extend the loan in place
directly, within both sides' limits, and can still add to or withdraw an
extension reserve. A stranger is still refused, and a lender has no direct
extension route at all.

The reason is that the switch exists to stop the automation, not to take a
borrower's own agreed option away from them. Turning it off no longer
strands a reserve the borrower meant to use for their own extension.

The functional spec, the admin knob reference (operator copy and the
published www page) and the connected app's extension card now say this.
The card states that no keeper will extend the loan while the switch is
off, that the borrower can still extend directly on the contract (the app
does not offer that step yet), and keeps the reserve panel open.

Closes #3175

> Caveat: the app has no button for a borrower's direct extension; with the switch off, that step is reachable only on the contract.
