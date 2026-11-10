## Keeper reads its secrets through the shared reader

The keeper now reads its Secrets Store bindings through the same shared reader the agent and indexer adopted in #3491. When a secret cannot be read, the log line names that secret, and when every bound secret fails together it says once that the store is unavailable, instead of repeating an unnamed failure for each one. A secret that cannot be read is still treated as unset for that run, so one unavailable secret never stops the whole tick.

The private-send routes are the one exception, as before (#3240): because having none of them means sending publicly, a configured route list the keeper cannot read makes the private-send path refuse for that run. Its log line now names the secret too.
