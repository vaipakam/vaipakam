## Thread — the marketing site may connect only to itself and its indexer (#43)

The public website's content policy used to allow network requests to any secure host. It now allows only the site's own address and the one indexer whose published protocol figures the pages quote, so a script that got onto a page can no longer send what it reads anywhere else. The indexer's address is build configuration, so the build writes it into the policy itself, from the same setting and through the same rule the pages use to fetch from it. That rule now lives in one place, shared by the pages, the build script that writes the machine-readable exports and the policy. A build whose configured address is not a plain secure origin stops instead of shipping a policy that would block the site's own data.

The policy check that runs with the site's typecheck now also refuses any connect policy other than "own address plus the build's indexer". The same build step is in the shared library, ready for the connected app; locking the app's connect policy is still open on #43, because the wallet connectors reach hosts that only appear while a real wallet connects.

Part of #43.
