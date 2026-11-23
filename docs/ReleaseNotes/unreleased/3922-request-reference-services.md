## Troubleshooting — a request reference and a kept record of service errors (PR #<n>)

The indexer and the agent now give every response a short reference, ten characters that can be read out without ambiguity, in a response header the browser is allowed to read. When the app's request is a write, the reference is the one the app sent; on a plain read the service makes it, because a custom header on a read would turn every indexer read into two requests. The reference is random each time and is derived from nothing about the user.

When a request fails or is refused, the service writes one log line naming the reference, and one row in a new service error record in the shared database: the service, the method, the route, the status, the reference, where the reference came from, the build and the time. A successful request writes nothing. The route is kept only as a pattern, with every id, hex value or other free segment replaced by a placeholder and the query string never read, so no wallet or address that appeared in a path reaches the record; the caller's network address is never read either.

Every server error is recorded. A refusal (a 4xx) is recorded only when it came from one of the app's own origins, so scanners probing for paths do not crowd out the failures users saw. The record keeps at most 500 rows per service per hour, and the hour's counter keeps counting past that, so it says how many it did not keep. A request that throws now becomes a 500 that carries the CORS header and the reference, instead of the platform's bare error page.

The record is not served by any public route. It is kept 90 days by default (the indexer's SERVICE_ERROR_RETENTION_DAYS setting, held to 7 to 400 days) and pruned by the indexer's scheduled run. It is archived nightly and restored like the other records that no replay can recreate. Migration 0131 adds the two tables; it is additive, and the write is made after the response is sent, so a database without the tables changes nothing a caller sees.

The app's own error record is unchanged. Showing the reference in the apps follows in the next changes.

Advances #3922.

> Caveat: a read that gets no response at all has no reference to show, because on a read the service makes the reference.
