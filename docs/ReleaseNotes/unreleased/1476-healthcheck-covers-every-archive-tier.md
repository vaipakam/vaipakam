## The backup healthcheck was only ever looking at a third of the backups (#1476)

The nightly backup writes three families of archive: a daily one, a monthly one cut on the 1st, and a yearly one cut on Jan 1. The weekly healthcheck verified the daily family — fetching the newest archive, checking it against its manifest, and decrypting it to prove the key still works — and never looked at the other two at all.

**The damage was not the missing check so much as the confident report.** Every week the operator received "Weekly backup healthcheck PASS", with nothing in it to suggest a scope. Two of the three families had never been examined by anything, and a monthly archive that had been overwritten or had quietly stopped being written would have produced exactly the same green message, indefinitely.

It also propagated. The retention policy sets a floor on how long a superseded archive stays recoverable, and that floor is derived from how often something routinely looks at these objects. For the monthly family there was nothing to derive it from, so the floor was set to a longer, weaker figure chosen only to outlast the monthly write cadence — and the reasoning was recorded honestly as such. A number stood in for a detector that did not exist.

The healthcheck now runs the same verification against all three families, and the monthly floor drops to the same value as the daily one, because the same weekly inspection now genuinely covers it. That change was made only once the detector it names actually existed.

Two smaller decisions worth stating:

**The alert now lists every tier on every run**, pass or fail. Extending the check without changing the message would have fixed this instance and left the next one — a report that does not say what it examined invites the reader to assume it examined everything.

**A missing yearly archive is reported but not paged.** A deployment that has not yet lived through a Jan 1 legitimately has none, and that is a normal state that can last a year; paging weekly for it would train the operator to ignore the alert. A missing daily or monthly archive is a genuine failure and does page.

This closes a detection gap, not the forgery gap: an attacker who holds both the upload credential and the encryption key can still write a self-consistent archive that passes every one of these checks. That remains tracked separately, and the retention floors remain a floor of usefulness rather than a sufficiency argument.
