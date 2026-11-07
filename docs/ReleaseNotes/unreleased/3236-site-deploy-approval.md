### A person approves each site deploy at mainnet: built now, switched off (#3236)

Every merge to `main` deploys the connected app, alpha05 and the marketing site by itself. That means one bad merge, one stolen token or one agent's mistake reaches the page users sign through. The owner decided to build a human approval step now, rehearse it on testnet and switch it on at mainnet. Until then nothing changes: testnet sites still deploy on merge.

When it is on, a site's build only uploads the new version, stamped with its commit and reachable on its own preview address, and that version takes no traffic. A new workflow waits for that version and rebuilds its commit. It compares the build with what the preview serves (the served-build check), and only then asks for approval in a protected GitHub environment. On approval it makes that version live and records the approving run in the deployment's message. It refuses a version older than the one live, so approving a stale run cannot roll a site back. The token that can deploy belongs to that environment alone, so no job can use it before a person approves.

The six-hourly served-build check reads that message back. With approval on, a live version that no approval run put there is reported as "unapproved". The gate cannot stop someone who holds a Cloudflare deploy token or can edit the build settings, but they can no longer deploy without anyone noticing.

The steps to switch it on, to switch it off and to rehearse it while it is off are in the incident runbook, section 9, under "Prevent". The runbook also records that DNSSEC, CAA records and HSTS are now on for the domain.

Advances #3236.

> Caveat: A version waiting for approval can be opened at its public preview address by anyone who knows that address.
> Caveat: An incident rollback by hand is itself unapproved, so the check reports it until the next approved deploy.
