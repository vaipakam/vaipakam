## Troubleshooting — a failed read says what failed and how to quote it

When the connected app cannot load something and shows an "unavailable" state, it now says which source failed and how to quote it to support. The offers list, the positions lists, the offer and loan pages, the desk's positions and open-orders panels, and the offer pickers in the rent, offer and obligation-transfer flows all do this.

Most of these reads ask the indexer first. When the indexer answered with an error, the message shows the reference its answer carried, for example "Reference 7KQ2M9XD4B. Quote it if you contact support." The indexer keeps the same reference in its log line and service error record. When the indexer answered with an error but gave no reference, the message says exactly that. When the indexer did not answer at all, the message says so and says there is no reference. Neither case is left blank, and the two are never confused.

Several of these reads fall back to the network when the indexer fails. If the fallback works, the page shows the data and no failure. If it fails too, the message gives the indexer's reference and says the network read failed as well, which has no reference. A network answer of "no such loan" is an answer, not a failed read.

The reference is kept in memory only. It is never written to browser storage, never sent to the live-review probe, and kept apart from the app's own error record. The protection, vault and approvals cards and the desk's chart, tape, ladder and history panels are not wired yet, and the read-only network proxy does not return a reference; both are noted on #3922.

The four new strings are translated into the nine translated languages.

Advances #3922.
