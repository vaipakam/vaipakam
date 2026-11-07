## Vault code — one central, delayed version registry (VaultBeacon)

Every user vault now runs code chosen by one place, the new VaultBeacon contract, instead of each vault carrying its own upgradeable pointer. Each vault is a beacon proxy that asks the beacon which code to run on every call: the version its owner pinned while that version is not revoked, otherwise the current version. One governance change therefore reaches every unpinned vault at once, and no vault can be left on old code because nobody upgraded it. The per-vault upgrade, the mandatory vault version and every rule built on it (#3178) are removed.

The beacon is a separate contract, owned by the Timelock and not upgradeable, so no part of the Diamond can change which code a vault runs. Registering a version, making one current and revoking one are Timelock actions, and making a version current or revoking one also waits a three-day delay the beacon enforces itself, so owners can see a change coming and pin before it lands. The Pauser Safe may cancel a pending change, and, only while the protocol is paused, revoke a version onto code already registered. A contract that does not report the vault's storage-layout identity cannot be registered.

Pins moved to the beacon. Pinning, re-pinning and unpinning carry the vault owner's own signature, which the beacon checks against the owner wallet the vault recorded when it was created, and wait the vault's pin delay. Protected mode raises that delay through a path capped at two days, below the code delay, so a pin asked for as soon as a code change is proposed always lands first; a pending pin change can be cancelled, and none is accepted while the account is locked. Each vault call now pays a beacon lookup, about 17,000 gas cold.

Stated gaps: until #3205, an account whose primary wallet was replaced cannot change its pin (testnets only); the app's vault page for versions and pins is #3281; and the keeper pass that applies matured pin and code changes is #3282. Fresh deploy only. The design and its build notes are in `docs/DesignsAndPlans/VaultCentralImplementationDesign.md`.

Closes #3204.

> Caveat: a replaced protected account cannot change its vault pin until #3205 records replacements in the vault.
> Caveat: matured beacon changes wait for someone to execute them until the keeper pass (#3282) is armed.
