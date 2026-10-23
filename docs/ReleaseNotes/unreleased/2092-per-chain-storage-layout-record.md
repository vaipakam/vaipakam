## Thread — Each chain's storage layout is recorded, and in-place upgrades check it (PR #2684)

The storage-layout guard added on 2026-10-20 stops a layout break from merging,
but a chain does not run the newest code: it runs whatever last reached it. So
each deployed chain now carries its own record of the storage layout it runs,
next to its addresses. A fresh deploy writes that record, and every script that
upgrades a chain's code in place (the full and changed-facet refreshes, the two
curated refreshes, the oracle and risk-terms upgrades, and the vault
implementation upgrade) first checks the new code against the chain's record,
refuses before sending anything if a recorded fact would be lost, and rewrites
the record once its change is in. A chain with no record is refused, because
the layout it runs is unknown. Each record is also bound to the live
deployment it describes, all of it: the Diamond's facets, the vault and
adapter templates, and every upgradeable proxy the chain reaches, such as the
cross-chain messengers and receivers. An upgrade is refused when any of that
code has changed since the record was written, for example by an upgrade from
another checkout whose record was never committed, or by a refresh that
stopped part-way after upgrading one proxy. The token and cross-chain deploy
scripts check the record too and rewrite it with the proxies they add. Two upgrades of one chain still must
not run at the same time, and an interrupted upgrade is finished by running it
again, never by replaying its saved transactions, since a replay skips the
check. Declared renames count; acknowledged breaks
never do, since an acknowledged break means that chain needs a fresh deploy.

The check runs inside each script rather than in a wrapper (owner decision
2026-10-23), so no entry point can reach a chain around it. These scripts
therefore run with forge's `--ffi` flag, and the deploy and refresh wrappers
pass it; a run without it is refused before its first transaction. The
project's forge configuration is unchanged.

The three live testnets (Base Sepolia, Arbitrum Sepolia, BNB testnet) are
seeded with today's layout: the code they were deployed and refreshed with is
contained in it, as measured when the guard merged, and no break has been
acknowledged since. The retired Ethereum Sepolia and OP Sepolia carry no
record, so a refresh of either is refused. Refs #2092 (item 1).
