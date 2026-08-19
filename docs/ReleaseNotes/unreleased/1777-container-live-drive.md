## The marketing-site live drive now runs from the agent environment, and the blocker's real cause is on record

The committed post-deploy drive for the marketing site could not previously be
run from the automated agent environment: the browser there failed every
navigation with a connection error, while ordinary command-line requests to the
same address succeeded, so live reviews waited on an operator machine.

The cause turned out not to be the connection at all. That environment's
outbound traffic passes through an inspecting proxy, and the proxy rejects a
security extension this browser includes in its handshake by default — one the
command-line tools never send, which is why they worked. The visible error
pointed at the connection rather than the handshake, which is what made the
gap expensive to diagnose. A second, quieter requirement — teaching the
browser to trust that proxy's certificates — was uncovered and addressed in
the same investigation.

The drive now honours two optional environment settings so the same committed
script runs in both worlds: an operator machine sets nothing and runs exactly
as before, while the agent environment points the drive at its own browser and
proxy. The setup steps the agent environment needs are documented beside the
drive, including the reason each exists and the instruction that certificate
verification must never be bypassed as a shortcut — the drive watches a
production surface and must not be taught to accept an unverified one.

With that in place the drive was run for real against the production site and
passed every check: the worked example's money figures render from the
published configuration with the contract's exact arithmetic, their provenance
is honest, and the help search finds the page by a figure printed on it. This
closes the outstanding live review that had been waiting on the blocker, and
ends the era of that review being impossible from the environment that
performs the rest of the process.
