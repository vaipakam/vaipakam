## Thread — The treasury lives only in the vault code (#3569)

The protocol treasury now lives in exactly one place: the treasury address fixed into the vault code that every user vault runs. The Diamond no longer keeps its own copy. The admin setter for the treasury and its announcement are removed, the protocol registry no longer holds a treasury entry, and the Diamond's treasury read now reports the treasury named by the current vault code. Before this change the two copies could disagree, and a disagreement either refused fees or sent them somewhere the other copy did not name. This follows the owner's decision to keep the treasury in the vault code only.

Moving the treasury is now a vault code change and nothing else: register new vault code built with the new treasury, propose it as the current version, wait the seven-day vault-code delay, and make it current. After handover the vault version registry is owned by the governance timelock, so the move is visible for the whole wait and the pauser can cancel it.

Fees follow the code of whoever pays them. A fee the Diamond moves itself, from a payer's wallet or from a share it already holds, goes to the current vault code's treasury. A fee drawn from a vault goes to the treasury that vault's own code names, so a vault whose owner pinned an older version keeps paying that version's treasury until the owner unpins. To end that, revoke the old version; its pinned vaults then run the current code.

The Diamond's own treasury ledger counts a fee only when the fee actually reached the Diamond. Treasury conversion, payroll funding and the backstop seed and withdrawal, which spend funds the Diamond holds as treasury, work only while the current vault code names the Diamond. A fee with no treasury set is refused by name and never sent to an empty address. The deploy refuses a missing treasury, builds the vault code with the one it is given, and checks that the Diamond reports it back; the launch check no longer compares the treasury between two copies, because there is only one.

Off-chain, the protocol console marks the treasury as a setting the Diamond does not announce, since it moves with the vault code, and the indexer no longer listens for the removed announcement. Tests change a test Diamond's treasury by installing vault code that names the new one, and the guard that refused direct setter calls in tests is retired with the setter. The platform is pre-live and every chain gets a fresh deploy, so nothing is migrated.

> Caveat: a vault pinned to an older vault version pays that version's treasury until it unpins or the version is revoked.

Closes #3569
