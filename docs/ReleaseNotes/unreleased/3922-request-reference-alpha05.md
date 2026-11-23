## Troubleshooting — the new app shows the request reference on a service failure

The new app (alpha05) now sends a fresh request reference with every write to its own services: the alert service (alert settings, the Telegram link, test alerts, loan watches, goals) and the offer book (listing a signed order). It reads the reference each answer returns. When one of those writes is refused or gets no answer, the line the person sees ends with "Reference 7KQ2M9XD4B: quote it if you contact support." The service keeps the same reference in its log line and its service error record, so support can find exactly what happened.

The reference appears only beside such a failure, never beside a success, a wallet refusal (nothing was sent) or a chain read. It is kept in memory only. A write that got no answer shows the reference it sent, since the service may still have received it. Failed reads follow in a later change.

Advances #3922.
