## Old copy of the keeper's runner lease removed (#3550)

The keeper's one-runner lease, which stops a second keeper from running at the same time, moved into the keeper's own private database in #1722. The old copy in the database the indexer, agent and keeper share was kept for one release, so a keeper machine still on the older build could keep claiming its lease during the update.

The keeper machine now runs a build that claims only in its private database, and nothing else ever read the old copy. A drop-only migration removes it, so the shared database no longer carries a writable table with a misleading name.

Closes #3550
