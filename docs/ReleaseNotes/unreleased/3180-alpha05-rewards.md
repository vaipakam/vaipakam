## Thread — alpha05 has a Rewards page with your VPFI (PR #3474)

The new app now has its own Rewards page. It shows the wallet's rewards
through the same claim widget Home uses, the VPFI in the wallet's own vault,
and the fee-discount consent. Until now Rewards pointed to the current app.

On a network where no VPFI token is set, the page says so and offers no
deposit or withdrawal. Otherwise it reads, at one block, the VPFI in the
wallet, the VPFI counted in the vault (what the fee-discount tier reads), how
much of it is free to withdraw and how much is held, and any VPFI that sits in
the vault without being counted because it was sent there directly, with the
way to adopt it from the Vault page. VPFI in the vault is not collateral.

Depositing and withdrawing VPFI use the vault's own deposit and withdrawal for
this one token. They count VPFI for the tier exactly as the VPFI-only entries
do, and the withdrawal keeps the escape route open while the protocol is
paused. A deposit asks for the Terms first; a withdrawal never does. Each
receipt adds the tier's side: deposited VPFI counts toward the tier under the
holding rules and pledges nothing; a withdrawal works the tier out again from
what stays counted, and taking the counted VPFI to zero restarts the holding
time. Both say whether the fee-discount consent is on. The outcome is measured
from the chain.

Only VPFI in the vault on VPFI's home network sets the tier; other networks
apply a copy of the tier worked out there. On those networks the page says so,
and each receipt says the move changes no tier instead of describing a tier
effect.

Nothing on the page buys, sells, prices or stakes VPFI.

Advances #3180.
