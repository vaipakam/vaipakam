# Vault beacon verification (#3436)

## What is checked

`contracts/test/invariants/VaultBeacon.invariant.t.sol` runs the beacon on its
own, with a stand-in Diamond (a paused flag) and two stand-in vaults with known
owner keys. A handler calls every entry as every role: the Timelock owner, the
guardian (paused and unpaused), the Diamond (with junk signatures, a stranger's
signature, raises, cancels and voids), the vault owner (pins, unpins, delay
changes, and replays of its own earlier signatures) and a stranger. After every
step it records in ghost state what changed and who changed it. The six
properties:

1. No version becomes current until `MIN_CODE_DELAY` after its registration, on
   any route, the guardian's emergency revoke included. The constructor's first
   version is the stated exception.
2. The current version is always live. A vault resolves to its pin while the pin
   is live, and to the current version otherwise. (The issue's wording about
   successor chains predates the design, which has none: section 3.3 of
   `VaultCentralImplementationDesign.md`.)
3. A pin or pin delay changes only on a valid owner signature over the current
   nonce. Each signature lands once, and each accepted one moves the nonce by
   exactly one.
4. `MAX_DIAMOND_PIN_DELAY` is strictly below `MIN_CODE_DELAY`, and the Diamond's
   raise without a signature never leaves a delay above that cap. So a pin
   requested when a change is proposed always executes first.
5. Neither the Diamond nor a stranger ever moves the current version.
6. A revoked version never becomes live again. The owner and the guardian never
   change, so no path renounces or takes ownership.

## What it found

Property 1 did not hold. `guardianRevokeVersion` accepted any registered
successor, however new. It now requires the successor to have been registered
at least `MIN_CODE_DELAY` earlier. The one rule (`_requireSeasoned`) is checked
wherever code becomes current: the executed proposal and both revoke routes.

## What it does not cover

It is a fuzzing campaign: it shows these properties hold on the sequences it
generated, not on all of them. A symbolic prover would give that stronger
result. Halmos runs these same Foundry tests symbolically, so the suite is
written to be reusable for that. Installing a prover in this environment needs
the owner's approval, so that pass has not been run. Hand both the suite and
this note to the external audit (#892).
