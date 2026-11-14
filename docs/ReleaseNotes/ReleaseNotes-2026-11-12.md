# Release Notes — 2026-11-12

The day's contract work makes three safety rules harder to bypass. New vault code, or a revoke of an old version, now waits at least seven days, longer than any payout delay a protected account can choose (#3593). The guardian's instant lever on a secondary price source can now only stop a source from loosening prices, and removing a source waits 48 hours (#3584). Each liquidity tier now has a default starting loan-to-value and a governance ceiling it cannot pass (#3597).

In the new app, the rewards card now says why a claim waits and names the step that clears it. A claim starts on the protocol's own delivery rule, and Advanced mode lets the person choose the vault or the wallet. The rewards section also shows what the wallet has claimed so far, and how much of that went to its vault.

## alpha05: what you have claimed so far (RW-31)

The rewards section on Home and on the Rewards page now shows what the connected wallet has claimed on the current network over its lifetime, and how much of that was delivered into its vault. Every claim counts, including a release of rewards held while a wallet was flagged, whichever destination the claim chose. Each claim is counted on the UTC day it was paid, not on the reward day it was earned.

The figures come from the indexer, through a new read that sums the claim and vault-delivery records it already keeps for each wallet. The line says up to when the indexer has recorded every claim. While it has not recorded the network that far, or is still reading the network's past claims, the line says the total is not known yet. If the indexer cannot answer, the line says so; it never shows zero in place of an unknown total. A claim the wallet confirms re-reads the total at once.

A vault credit that fell back to the wallet is counted in the total but not in the vault part, because the protocol records no vault delivery for it.

The Basic and Advanced guides describe the line in all ten languages.

Closes #3216.

_Committed 2026-11-12 03:42 UTC (a7a34944a)._
<!-- assembled-fragment: 3180-alpha05-lifetime-claimed.md sha256=b7248bb439943bed9fad85e2921b3f61234b0f25de7e57f7595eb75124ec7c92 -->

## alpha05: choose where a reward claim lands (RW-26)

A reward claim in the new app now starts on the same delivery rule the protocol uses by default. A person's own wallet account, including one with an EIP-7702 delegation, is paid into its vault. A wallet that is a contract, such as a multi-signature wallet, is paid to the wallet itself. Before this change every claim named the vault, whatever kind of account made it.

In Advanced mode, the claim offers a choice between the vault and the wallet before the review. Each option says what it means: VPFI in the vault is not locked and can be withdrawn at any time. A separate note says what the choice does to the fee-discount tier on this network: on VPFI's home network, VPFI in the vault counts toward it and VPFI in the wallet does not; on another network the tier is worked out on the home network, so neither choice changes it there. The review's "Delivered to" line names the chosen destination and binds it, the re-check simulates that destination, and the outcome reports where the VPFI actually arrived. Claim everything still sends its reward legs to the vault and says so.

With protected mode on, the protocol sends every reward claim to the vault whatever destination is passed. In that case the claim names the vault, says withdrawals wait the account's delay, and offers no wallet option. If the mode cannot be read, the claim names the vault too. The re-check reads the mode again before signing.

The Basic and Advanced guides describe the choice in all ten languages.

_Committed 2026-11-12 02:25 UTC (6383c7d09)._
<!-- assembled-fragment: 3180-alpha05-reward-venue.md sha256=7a3b9c48eec1948f545c804fd643578443e221efc641e0c89f8d834454017bd5 -->

## Thread — alpha05: why a reward claim waits

When a reward claim cannot run now, the new app's rewards card names the reason. A claim that waits on a reward day also says what that day waits on, read at the same moment as the claim's own check. On VPFI's home network, that is whether the day can be finalised yet: no network has reported it, the networks still have time to report, the list of networks expected to report does not allow it, or it can be finalised now and anyone may run that step. On a network that reports to the home network, it is whether the home network's figures for the day have arrived, or, for the day's funding, whether the day is priced here, whether this network's report was sent (named only for a day that needs it), and how much of the new and of the recycled VPFI has landed, each against its own declared whole.

Every waiting reason says that later days wait behind it, that no step of the wallet's own clears it, and that anyone may run the step that does. A day whose funding arrived in parts stating different totals is disclosed as one that cannot be repaired and can be closed unpaid after a waiting period. On a network that has left the reward network, the card says nothing new becomes claimable there and offers no step that could clear it. On a network with no reward role set, no reward day can be finalised, so the card says that instead of a finalisation reason, and the Rewards page's headline says no reward day there can be finalised or claimed yet rather than describing it as a home network.

A claim refused for funding is named too, with the protocol's own figures: the programme's pool of new VPFI paid out with no recycled VPFI in the claim to pay instead (recycled VPFI still pays later rewards); the pool's remainder or the recycled VPFI reserved for pending settlements, with what the claim needs and what is free; or the VPFI held here short of what the claim needs, with both amounts. Under the global pause the card names the pause and says that full and partial repayment and adding collateral stay open. A fact that does not answer is stated as unread, never guessed. Rewards stay usage rebates, never yield. Advances #3180.

_Committed 2026-11-12 01:12 UTC (da85d83d0)._
<!-- assembled-fragment: 3180-alpha05-reward-wait.md sha256=d6aed0d9fcc7c008ae099f7de62a90ff59628b1792f2e108f9dbb843ea5b5bac -->

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

_Committed 2026-11-12 02:56 UTC (7928e3c4c)._
<!-- assembled-fragment: 3421-vault-code-delay-seven-days.md sha256=b3e9698207802ade2d5bb57f1653781a44968cc152ffa54f544b1016dcc802c3 -->

## Price guard — the guardian's instant price-source lever is stop-only (PR #3584)

The guardian (the Pauser Safe) could switch off a secondary price source at
once. The price guard accepts the primary price alone once no secondary
source is available, so switching off the sources that disagreed with the
primary turned a refused price into an accepted one, instantly. Every price
the platform uses goes through the guard, so that was a fast way to loosen
loan creation, health factors and liquidations, not only to stop them.

The lever is now split in two. The guardian or the owner may **mute** a
source at once: a muted source no longer approves a price, but it still
refuses a price it contradicts. A mute can therefore only refuse more prices;
it is the right tool against a source that is approving a wrong price.
**Removing** a source also drops its refusals, so it waits a fixed 48 hours
after it is proposed, on every chain. The source is muted from the moment the
removal is proposed, anyone may execute the removal once the wait ends, and
the owner or the guardian may cancel it before then. That is the tool for a
source that is broken and refusing good prices: an asset it contradicts stays
refused for at most 48 hours, the same window as a Timelock unpause.

Turning a muted or removed source back on still waits the guard's own delay
(7 to 14 days on a production chain). A mute or a removal proposal cancels a
pending re-enable, and a re-enable that lands first drops a removal still
waiting. The count of agreeing and disagreeing sources the guard reports now
follows the same rule: a muted source's agreement is not counted.

We chose this over the issue's first plan (an instant disable allowed only
while another source stays enabled) because that floor counts sources, not
answers: a remaining source with no price for a given asset would still have
left that asset on the primary alone, at once.

The price guard cannot be upgraded, so this reaches each chain with its next
fresh deploy.

Closes #3537

_Committed 2026-11-12 01:50 UTC (7d8e7f93e)._
<!-- assembled-fragment: 3537-price-source-mute-and-removal.md sha256=2f19ac99386029a947816d467e0fbdba73ab8aa1118cc8330d666e207f7a183a -->

## Tier LTV — a default and a ceiling per tier (PR #3597)

Each liquidity tier now has two numbers: a default starting loan-to-value
(50%, 60% and 65% for tiers 1, 2 and 3) and a governance ceiling (55%, 69%
and 82%). This is the rule the owner set on 2026-11-11.

A fresh reading from peer lending protocols replaces the default, whether it
is lower or higher, and whichever applies is never above the ceiling. A
reading above the ceiling is now stored and clipped to the ceiling when a loan
reads it, rather than thrown away; so a ceiling governance lowers binds the
next loan at once, without waiting for a refresh. The lower edge of the old
per-tier range is gone: when peers lower what they lend against, the platform
follows. With no usable reading (none yet, older than 14 days, or peer reads
paused) the default applies, and it too is capped at the ceiling.

Each reference asset also now contributes the lowest of its agreeing peer
readings instead of their midpoint, so one peer loosening its own
configuration can no longer raise the platform's value.

The hard maximum on any tier setting rises from 80% to 82%, so the tier-3
ceiling can be configured at its default. The governance setter now takes a
ceiling and a haircut per tier (the floor argument is gone), and the refresh
no longer reports "out-of-band" rejections.

Closes #3547

_Committed 2026-11-12 03:35 UTC (0d6e25eec)._
<!-- assembled-fragment: 3547-tier-ltv-default-and-ceiling.md sha256=47eb36db536ffe5f564194e7d98abe867ea212a846a5ccf0b49ff4441256a576 -->
