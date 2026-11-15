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

## Symbolic proofs (Halmos)

`contracts/test/formal/VaultBeaconHalmos.sol` states the same properties as
Halmos `check_` functions, run with `bash contracts/script/halmos-beacon.sh`
(owner approved installing Halmos, 2026-11-15). Each check takes one arbitrary
call to the beacon: any function, any arguments, any sender, any later time,
paused or not. It starts from a state chosen so the property can bite: fresh
and seasoned versions registered, a proposal pending (1b, 5), a version already
revoked (6). Halmos then proves the property for every such call, not a
sample. All seven pass. With the guardian's new check removed, Halmos finds
the counterexample at once: the guardian, at the same moment, while paused.

Its first run reported an ownership loss through `acceptOwnership` by
`address(0)` while no transfer was pending. No transaction can have that
sender, so the checks assume a non-zero sender.

## What it does not cover

- The Halmos checks prove one call from each chosen state; sequences of calls
  are covered by the fuzz suite, not proved. Halmos's invariant mode could
  extend the proofs to short sequences.
- Halmos treats signature recovery abstractly. Property 3 is therefore proved
  as "a pin moves only in a call that consumes exactly one nonce", which
  every signed path does. That a signature is checked correctly relies on
  OpenZeppelin's `SignatureChecker`, which is outside these proofs.
- The script copies the beacon into a small project of its own, because Halmos
  builds the project it runs in and this repository's build is the full,
  test-inclusive compile. It does not run in CI.

Hand the suite, the proofs and this note to the external audit (#892).
