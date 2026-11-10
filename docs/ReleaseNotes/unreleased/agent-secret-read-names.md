### Secret read failures name the secret (agent, indexer)

When the agent or the indexer cannot read a secret from Cloudflare's Secrets
Store, the log now names the secret, for example "could not read RPC_ARB".
It used to say only that some secret failed, and the reader had to work out
which one from the order of a list in the code. When every secret fails in
the same run, which means the store itself was unavailable, the run logs one
line saying so and listing them all, instead of one line per secret.

Behaviour is otherwise unchanged. A secret that cannot be read is still
treated as unset for that run, so only the features that need it skip, and
the next run reads it again. Both Workers now share one module for this,
`@vaipakam/lib/secretsStore`. It was prompted by a single all-secrets outage
on the agent on 5 November that was first misread as a missing key.
