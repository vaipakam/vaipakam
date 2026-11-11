## Thread — New vault code waits seven days (PR #3593)

A new current vault version, or a revoke, now waits at least seven days
between its proposal and its execution, up from three. The wait is a constant
in the vault version registry, so no later setting can shorten it.

New vault code can move what a vault holds, and a protected account may choose
a payout delay of up to five days. With a three-day wait, a bad version, from a
governance mistake or a compromised Timelock, could reach a protected vault
before the owner's own delay had run, unless the owner pinned in time. At seven
days every proposed change is visible for longer than any protected delay, so
an owner who is alerted always has time to pin.

That is now a stated rule: the vault code wait must always be longer than the
longest protected payout delay. A test pins both sides, so a change to either
fails before a deploy. If the protected range ever grows, the wait has to grow
with it, which means a new registry, since it is not upgradeable. The cap on
the pin delay the Diamond may set (two days) stays below the wait, so a pin
asked for when a change is proposed still lands first.

The registry is not upgradeable, so this reaches a chain only with a fresh
deploy, before the mainnet launch. The position NFT's component wait stays at
three days: a replacement renderer only draws and a replacement transfer check
can only refuse a transfer, so neither can move a holder's assets.

Closes #3421.
