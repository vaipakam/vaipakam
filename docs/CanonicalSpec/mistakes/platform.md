# Mistakes: the platform (PLT)

Mistakes an honest party can make at the platform's own address, as distinct from a vault.
The form is that of the vault's list (`vault.md`, beside this file).

### PLT-M01 · The network's own coin sent to the platform's main address

**Who:** any party.
**Does:** sends the network's native coin, such as ETH, to the platform's main address,
outside a step that asks for it.
**Proposed answer:** Refuse.
**Wanted statement:** the platform's main address takes the coin only inside a step that asks
for it, and refuses it otherwise.
**Answered by:** PLT-100.
