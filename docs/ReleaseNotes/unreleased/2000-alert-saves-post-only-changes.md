## Alert saves carry only what the user changed (PR TBD)

Saving an alert preference used to post the whole preferences record —
the three health-factor bands always travelled, whatever the save was
about. Those bands are how the "risky loan" lane's state is expressed
(real bands mean on, floor bands mean off), so a device that had never
seen the wallet's preferences would, on its very first save of anything
— a due-date opt-out, say — also write its own default lane state over
an opt-out the user had made on another device. The client could not
tell "the user wants risky alerts on" from "this device was never told
otherwise", because both read as the defaults.

The wire contract now matches the rule the due-date field already
carried: a save sends only what the user changed in it. The alerts
service accepts a request with the band fields absent — as a set, all
three or none — and preserves the stored values, writing the standard
defaults only for a wallet with no record at all (for whom the default
state is genuinely the current state). The connected app sends the
bands only on a save that touched the risky lane: the toggle itself,
or the advanced band numbers behind it. A first save from a fresh
device therefore writes nothing the user did not touch, which also
closes the known residual noted in the Terms-gate work: a held user's
first opt-out no longer ships the untouched lane's bands to a channel
the wallet linked elsewhere.

Closes #2000. The sibling question — whether the alerts service should
verify Terms acceptance itself — remains tracked as #1999.
