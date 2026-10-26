## Delisting timelock: a removed bot key's proposals stay void (#2902)

Removing a delister bot key from the sanctions delisting timelock was meant to void every delisting it had pending. It did, but only while the key stayed removed: if the owner appointed the same address again, every proposal it had made before the removal, and that nobody had cleared away, became executable again, including ones whose waiting window ran out while the key was removed.

Each proposal now records the authority it was made under, and a removal ends that authority for good. Reappointing the address lets it propose again, with a fresh waiting window and a fresh chance for the Safe to veto, but never brings back what it proposed before. The old proposals can only be cleared away, which anyone may do. The delister bot reads the same rule from the contract, so it clears them away too, rather than treating them as its own.

The other safeguards were already holding: a delisting still needs the publication unchanged, no veto, and a current RedStone reading that clears the address. Prelive: fresh deploy only.
