## Thread — the last error of the removed VPFI buy flow is deleted

One error from the removed fixed-rate VPFI buy flow was still declared in the shared error list. It rejected a malformed origin chain in that flow's caps pipeline, and nothing has raised it since the flow was removed. Because every facet that uses the shared error list inherits every error in it, the dead error appeared in 46 exported contract interfaces. Each of those had to be pinned by hand as known legacy residue, and every new facet needed one more pin. That is what failed the legacy-residue check on the transport-epoch staging PR.

The error is now deleted, so it is gone from every exported interface. The 46 interface pins and the error list's own pin are dropped because nothing is left to pin, and the check keeps its guard against the name coming back. No behaviour changes: nothing could raise the error. Refs #1728.
