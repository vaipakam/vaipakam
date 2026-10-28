## Thread — Testnet faucet NFTs can only be burned by their owner (PR #TBD)

The two faucet NFT collections deployed on the testnets for rental demos
(vRENT and vART) let any wallet burn any token, including one another user
held or one escrowed for a demo loan. Burning now needs the token's owner or
an operator it approved, the same rule a transfer follows. This is testnet
tooling only: these contracts are never deployed on a mainnet. The change
reaches the testnets on their next mock deploy. Closes #2359.
