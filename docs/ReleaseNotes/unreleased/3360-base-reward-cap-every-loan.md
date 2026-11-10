## Thread — Every Base loan carries the fee-linked reward cap (PR #3514)

Each token loan on the canonical reward chain now records its lifetime
reward ceiling when it opens, whatever fee mode either party chose. Before
this change only a loan where someone opted into the Full tariff recorded
it, so an ordinary loan earned with no per-loan ceiling once the
fee-linked cap was armed, and only the per-wallet daily share bounded it.
Two wallets of one person could lend to each other and earn VPFI with no
per-loan limit tied to the fees they paid. The ceiling bounds that per
loan; it does not remove every margin, as the last paragraph states. Recording the ceiling charges nothing: a party who did
not choose Full still pays only the usual fee in the lending asset.

The launch gate gains a check. On the canonical reward chain the first
unpause is refused until the cap's first armed reward day has been set,
the reward clock has started, and that day has arrived, so no loan ever
earns under the older per-ETH cap. The arming setter takes only a future
day, so an operator arms the cap at least one reward day before the
launch. The check reads as not applicable on a mirror chain.

Mirror chains keep the old rule for now: their loans record the ceiling
only on a Full opt-in, because a mirror's claims are funded by Base
against a commitment made per entry, and trimming them would change what
crosses chains. The owner chose to build the same cap on mirrors, with
the VPFI a capped mirror claim does not pay sent back to Base, as its own
change before launch. Until then a mirror loan is bounded by the
per-wallet daily share.

The threat model records the residual: at the default settings the two
sides of one loan can together earn at most about 4.9 times the list
initiation fee per year of term, while the pair pays at least half that
fee plus gas.

Advances #3360.

> Caveat: the next fresh deploy of the canonical testnet must start the reward clock and arm the cap before its launch, or the launch refuses.
> Caveat: mirror-chain loans stay without a per-loan reward ceiling until the mirror half of #3360 ships.
