# Mesh watcher names JSON-RPC errors instead of calling them unclassified

On 2026-11-06 the ops channel received a critical "Mesh watcher tick failed … an unclassified error occurred" alert. The alert pointed the operator at the Worker logs, but the Worker logged only that same sentence, so the cause could not be found there.

The watcher's error classifier now recognises a JSON-RPC error from an RPC endpoint by its structure. This is the case where the endpoint answers normally at the HTTP level but returns an error object, such as "header not found" from a load-balanced provider. The alert names the numeric JSON-RPC error code and the error types involved. Any error that is still unclassified now lists its error types, so the alert itself says what kind of failure occurred. The provider's own message text is still never forwarded, so a key or URL in it cannot reach an alert or a log.
