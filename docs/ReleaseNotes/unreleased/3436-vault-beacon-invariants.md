## Vault code: the emergency route can no longer run brand-new code (#3436)

The guardian's emergency revoke on the vault beacon could make any registered vault version current at once. A version registered a minute earlier counted. So governance registering new code and the guardian revoking the current version onto it could put that code in every unpinned vault without the seven-day notice that the ordinary route gives. That notice is what lets an owner pin before a change reaches their vault.

Now each version records when it was registered, and no version can become current until seven days after that, on any route. The constructor's first version is the only exception, because a fresh deploy has no vaults yet. The guardian can still revoke at once onto an older version, and `versionUsableAt` tells operators when a newer one becomes eligible. The incident runbook and upgrade safety notes say to keep a known-good earlier version registered.

The six beacon properties that #3436 lists now run as a stateful invariant suite. Every role (the owner, the guardian, the Diamond, the vault owner and a stranger) calls every entry in random order. A design note records what this covers and what a symbolic prover would add. The issue's second property described successor chains, which the design removed; the suite checks the design's rule instead: pinned and live, otherwise current.
