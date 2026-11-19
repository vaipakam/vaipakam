## Clear signing — wallets can show what a Vaipakam call or message does

Wallets and hardware devices that read the open clear-signing format (ERC-7730) can now show a Vaipakam action in words instead of raw data: "Create an offer" with the lending asset by name, the amount in units, the rate as a percentage, the term in days, and each acknowledgement flag spelled out. The descriptors cover all 135 Diamond functions a person signs from their own wallet, and every typed message Vaipakam asks a person to sign: signed offers and offer sets, an acceptance, a co-signer's fill approval, adding a direct transfer to a vault, every protected-mode and recovery message, vault version pins, and the two Permit2 transfers the Diamond asks for. In the Permit2 messages and the two vault messages that name the Diamond, the wallet is told to refuse any spender or Diamond that is not one of Vaipakam's.

The files are generated from the exported ABIs, the Solidity sources and the deployment addresses, so nothing is copied by hand: every enum, every constant-coded choice (keeper permissions, flexible options, reserve kinds, protected-mode actions) and every signed type string is read from the contracts. Every non-view Diamond function now has a recorded class (user, upkeep, admin or internal), with no facet-wide defaults, because a default hid two user calls while this was written. A new function with no class, a user function with no wording, an input with no rule, a hidden input with no reason, or an enum label that no longer matches its Solidity enum stops the ABI export and fails the contracts package test in CI.

Where a call does not tie an amount to a token address (most calls that take only a loan or offer id), the amount is labelled as smallest units of its asset rather than formatted as if the wallet knew the token.

Closes #3348. Part of #3718 (step 1; submitting the files to the public registries wallets read is an owner step and is not done here).

> Caveat: direct calls to a person's own vault, the no-signature route of protected mode, are not described yet (tracked in #3818); their signed route is.
> Caveat: the vault-protection messages are signed to each person's own vault, so their descriptor binds the domain name only, not an address.
