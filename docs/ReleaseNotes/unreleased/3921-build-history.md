## Troubleshooting — which build each service was running, from when

The indexer now keeps a build history, so a past problem can be matched to the code that was serving at the time. Advances #3921. The second half of that card, where every derived row names the event that last changed it, follows in its own pull requests.

A row is added each time a service is seen running a build other than the one its latest row names, so a rollback to an earlier build is recorded as its own period. Each build is the commit stamp every deploy already records. A dirty build is marked as such, and a build that cannot be named is recorded as "unstamped" rather than left out.

How each service is seen:
- The indexer and the agent note their own version on their scheduled runs.
- The failed transaction pass names the commit its bundle was built from with each write it already sends.
- The app, the public site and alpha05 now serve a small `build.json` naming their commit, never cached. The indexer reads these files from their public addresses once an hour.

The indexer's reads run after a tick's chain work, and only with what that work left of the tick's allowance.

The history names no user. It cannot be rebuilt from the chain, so it is kept for the life of the deployment, archived nightly, and restored from the archive.

> Caveat: the keeper machine's own build is not yet in the history; the keeper's switch history and decision record cover it with the keeper's part of the design.
