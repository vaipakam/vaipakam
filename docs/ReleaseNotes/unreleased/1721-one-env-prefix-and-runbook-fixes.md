## Thread — one chain env-prefix map, and four runbook fixes (PR #2989)

The configure scripts now read every per-chain setting under one
chain-to-prefix map, the one the deploy library already used for its
artifact fallback and that matches the deploy wrappers' chain slugs.
Before this, the oracle configure script, the VPFI discount-price script
and the swap-router deploy script each kept their own map, and they did
not agree. The oracle script had no entry for Arbitrum, Optimism or
Polygon mainnet, so the configure step of a mainnet deploy on those
chains would have stopped with "unsupported chainId". The discount-price
script had no BNB testnet entry. On Ethereum mainnet the oracle and
discount-price scripts read `MAINNET_` keys while the wrappers and the
swap-router script used `ETHEREUM_`. Every script now reads `ETHEREUM_`
on chain 1, and Polygon zkEVM is no longer mapped: it is out of scope,
and the mainnet wrapper already refuses it.

The pre-mainnet runbook's chain scope now matches the specification:
Ethereum, Base, Polygon (PoS), Arbitrum and Optimism, with BNB Chain
testnet-only and zk-rollups out of scope. Its note that the discount
step could not be completed on a Phase-1 chain is replaced. The CCIP
cutover runbook now lists the four receiver and sender contracts the
cross-chain deploy actually creates, and it names both Diamond
repatriation calls, the registry and the endpoints, with how to verify
each. It used to name only the registry, so a mainnet Safe batch built
from it would have left repatriation dark. The deployment runbook drops
a stale "do not follow" banner over a section that had already been
rewritten for the current Workers, and the last live references to the
retired watcher Worker now name the current Workers. The docs index
states that older design docs and release notes keep paths from before
the source-tree split and are not rewritten.

Closes #1455, #1462, #1668 and #1721.

> Caveat: an operator `.env` that set Ethereum mainnet oracle keys with the `MAINNET_` prefix must rename them to `ETHEREUM_`. No mainnet is deployed, so no live configuration is affected.
