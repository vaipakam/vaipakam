## Troubleshooting — the app shows the request reference on a service failure (PR #4039)

The connected app now sends a fresh request reference with every write to its own services: the agent (alert settings, the Telegram link, the alert phrase, support tickets, diagnostics erasure) and the indexer's gasless offer post. It reads the reference each response returns. When one of those writes fails or is refused, the message the user sees ends with the reference, for example "Reference 7KQ2M9XD4B. Quote it if you contact support." The service keeps the same reference in its log line and its service error record, so support can find exactly what happened from what the user reads out.

The reference is shown beside such a failure and nowhere else. It is kept in memory only and never written to browser storage. It is also kept apart from the message the app's own error record captures, so that record is unchanged; whether it should carry the reference is the owner's decision, after the first drill.

A write that gets no response at all still shows the reference it sent, since the service may have received it. Showing the reference on a failed read follows in a later change.

The one new string is translated into the nine translated languages.

Advances #3922.
