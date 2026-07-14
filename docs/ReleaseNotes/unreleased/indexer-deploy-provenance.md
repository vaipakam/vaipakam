# Indexer stats routes report deploy provenance

The backend Workers had no externally visible build marker, so "is the
merged code actually live?" required dashboard access — the frontends
have long answered it with a footer build hash. The indexer's two
stats routes now include the deployed version's id and timestamp
(from the platform's version-metadata binding), covering automatic
and manual deploys alike. One curl now answers what is deployed.
