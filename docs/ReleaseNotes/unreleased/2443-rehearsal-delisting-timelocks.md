## Thread — Delisting timelocks recorded on the testnets (PR #<n>)

The sanctions delisting timelock is now deployed on Base Sepolia and on Arbitrum Sepolia, one for each chain's rehearsal sanctions list, and both are recorded in their deployment artifacts and the exported deployments bundle. The delister service installed from this commit therefore finds them without any hand-configured address. On both chains the admin owns the timelock, the delister bot's own key is its only proposer, and proposals wait the default 48 hours. The timelock was made a remover of the list in addition to the existing remover (the testnet Safe on Base Sepolia, the admin on Arbitrum Sepolia), and the existing remover keeps its direct delist.

Neither timelock has a RedStone check yet, so every execution refuses until the cross-chain clearance wiring is done. Until then the delister proposes nothing and reports that the delistings await the existing remover. The Diamond screens against neither list, and nothing a user sees changes.

Refs #2443.
