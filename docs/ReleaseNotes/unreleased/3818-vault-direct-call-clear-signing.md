## Clear signing — direct calls to a person's own vault

Protected mode has two ways to act. A key can sign a message that someone else sends, or it can send the call itself. When it sends the call itself, the transaction goes to the person's own vault as one generic entry point, and the real action travels inside it as raw data. Until now a wallet showed only that raw data for turning protected mode off, changing co-signers, replacing the owner or moving to a recovery address.

The descriptors now cover that route. A new descriptor describes the vault's entry point and shows the data inside it as the call it is. It also describes every protected-mode and recovery action that data can carry. Each action is shown in words, with its choices spelled out: the change, the waiting period, the destination, the co-signer, the new owner, the recovery address, and the key acting. The signature is hidden; on this route it is empty, because the key sends the call itself. Where an action names the Diamond, the wallet is told to refuse any address that is not one of Vaipakam's.

No vault address is known ahead of time, so the descriptor is bound to every vault through the event the Diamond emits when it creates one. A wallet that checks that event knows the vault is a Vaipakam vault.

Every function of the vault code now has a recorded class, as the Diamond's functions do. A new vault function with no class, or a user action with no wording, fails the same build and the same CI check. The finishing steps anyone may run once a waiting period ends are classed as upkeep and get no display, as on the Diamond.

Closes #3818. Part of #3718 (submitting the files to the public registries wallets read is an owner step, held until the contracts are frozen before mainnet).
