## Thread — Secondary oracles ask about an asset under its registered feed name (PR #2929)

Tellor, API3 and DIA cross-check each Chainlink price. They used to be asked
about an asset under its own `symbol()`, read live from the token. A token
controls its symbol, and an upgradeable one can change it, so a token could
point its own cross-check at another asset's price. A malformed `symbol()`
reply also reverted the whole price read instead of reading the secondary
as unavailable (#2745).

The asset's identity for the secondary sources is now the name of the
Chainlink pair registered for it in the chain's feed registry: "LINK" for
"LINK / USD". The registry publishes it through a new read, and the oracle
asks it under the same quotes, in the same order, as the primary price read.
That name was checked against the feed's own description when governance
registered it, behind the registry's delay and the guardian's veto, so it
comes with no new per-asset setting. Wrapped ether is asked about as ETH.
The oracle never reads a token's symbol any more, and a registry reply that
is not exactly one word reads as no identity rather than a failure.

An asset with no registered pair, such as one priced by an industrial-fork
direct-feed override, now gets no secondary check: its price stands on
Chainlink alone, exactly as when no secondary source answers. The per-token
override first sketched for this was not built, because a name the
secondary sources do not recognise only reads as unavailable. OracleFacet
is about 1.1 KB smaller, since the symbol decoder is gone.

Closes #2745.
