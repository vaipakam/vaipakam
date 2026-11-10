## Thread — protected mode is held by each vault (#3379 Stage B2, #3393, #3415, #3423)

Protected account mode now lives in each user's own vault, not in the platform. The delay, the lock, the secondary signers, the allowlist and a pending replacement of the owner's wallet are written only by the vault. It accepts a change only from the right key: a direct call from that key, or that key's signature submitted by anyone. A signature may come from an ordinary wallet or a contract wallet such as a Safe. Each signature names the network and the vault, can be used once and expires, and a key can void one it gave out before it is used. The rules themselves are unchanged: two to five days of delay, five signers, five destinations, delayed loosening that any signer can cancel, a lock that drops every pending change, and a replacement after the delay.

The vault enforces its record itself. It pays its owner, or an allowlisted address, only while it is not locked, and pays an allowlisted address only once that address has waited its delay. A replacement moves the vault's own owner record to the new wallet, so the vault pays and checks signatures against the new wallet from then on. The vault stays the one created for the account and keeps receiving what the old wallet's positions earn.

An allowlisted address can now verify itself, by its own call or signature (#3415). When the account has signers, a payout to an address that has not verified itself needs a signer's co-signature. A lock signed by the owner or a signer can be submitted by anyone (#3423), and the keeper's lock from a linked chat goes through the vault too.

Vaults are now created at an address derived from their owner (#3393). A vault tells a genuine vault from a look-alike by that address, so a copy deployed by someone else with a forged owner record is refused as a payee.

The platform reads the vault's record and applies its own side of it on request (anyone may ask): it holds the position NFTs and cancels queued payouts on a lock or a replacement, and raises the code-pin and NFT-lock delays. The deploy records the protection code as `vaultProtection`. Design: `docs/DesignsAndPlans/VaultOutflowPolicyDesign.md` (Stage B2 build notes).

> Caveat: queued payout rows stay with the platform until Stage B3. A row cancelled by a lock is cancelled when the platform applies the lock; until then it cannot be released, because the release reads the lock from the vault.
> Caveat: the app, the alpha site and the keeper still call the retired platform entries. They move to the vault's entries in Stage B4, and until then protected-mode settings cannot be changed from them.
