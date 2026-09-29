## Thread — the last error of the excised #687-A surface is deleted

One error from the surface excised in #687-A was still declared in the shared error list. It rejected a malformed origin chain in that surface's per-wallet caps pipeline, and nothing has raised it since the surface was removed. Because every facet that uses the shared error list inherits every error in it, the dead error appeared in 46 exported contract interfaces. Each of those had to be pinned by hand as known legacy residue, and every new facet needed one more pin. That is what failed the legacy-residue check on the transport-epoch staging PR.

The error is now deleted, so it is gone from every exported interface. The 46 interface pins and the error list's own pin are dropped because nothing is left to pin, and the check keeps its guard against the name coming back. No behaviour changes: nothing could raise the error. Refs #1728.
