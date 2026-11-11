## Thread — Keeper checks fees and chain before it signs (PR #3553)

The keeper lets its RPC fill in each transaction's chain id and fee fields, then signs. Until now nothing local checked those fields, so a faulty or hostile RPC could have had the keeper sign transactions that burn its gas money in fees, or one for a different chain. The keeper wallet holds only gas money, but it pays for liquidations, so draining it would stop them.

Every path on which the keeper's key signs now runs one check between preparation and signature, including a send whose transaction number the caller chose and the private route's public fallback, which rebroadcasts the bytes already checked. The transaction must be for the chain the keeper was configured to act on (its own chain list, never the RPC's answer), and that configured chain id is what is signed over. Its fee per gas (or gas price on a legacy chain), its tip and the most its fee can cost (gas limit times fee per gas) must each be at or under the chain's ceiling. The last figure is what bounds an inflated gas limit, which no per-gas ceiling catches.

Every chain the keeper runs on has built-in ceilings well above what it charges in a busy hour: on Base and Arbitrum 20 gwei, a 2 gwei tip and 0.01 ETH per send; on BNB 30 gwei and 0.03 BNB; on Ethereum 300 gwei, a 20 gwei tip and 0.3 ETH. An operator may set others per chain with three plain variables in the same form as the CCIP fee ceilings.

A send outside the ceilings is not signed and not sent, and its transaction number is released for the next send. Operators get an ops alert naming the Diamond function and its loan or offer id and the figure that was over, at most once per chain every ten minutes, so a genuine fee spike is a decision to raise the ceiling rather than a silent stall of liquidations. A ceiling that cannot be read holds every send on that chain and says why.

Closes #3543.

> Caveat: the value a transaction carries is not in this bound (the keeper chooses it, and a paid CCIP fee has its own ceiling), and a rollup's L1 data fee is charged by the chain outside the transaction's fields.
> Caveat: the guard checks the RPC's figures against fixed ceilings only; it does not compare them with a second fee source.
