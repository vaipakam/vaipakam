## Security — wallet loan/claimable lookups no longer fan out unbounded on-chain calls (#749)

Three public indexer read endpoints — a wallet's loans as lender, as borrower, and
its claimable loans — used to answer by pulling **every** matching loan from the
database (with no row limit) and then making one or two on-chain ownership calls
**per loan** to filter down to the requesting wallet. The page-size limit was only
applied *after* that fan-out, so it didn't bound the work.

Two problems followed. First, an unauthenticated caller could make each request
issue on-chain calls scaling with the **global** number of loans — and by varying
the wallet in the URL to bypass the short edge cache, sustain that load cheaply,
burning the operator's paid RPC quota that the keeper and alert services also rely
on. Second, once the loan table grew past the per-request subrequest ceiling, the
extra ownership calls failed silently and those loans simply **dropped out of the
results** — so the endpoints quietly under-reported for legitimate users at scale.

These endpoints now answer from a **single authoritative on-chain call** that
enumerates exactly the loans whose position NFT the requesting wallet currently
holds. The work per request scales only with that wallet's **own** holdings, not
the global loan count, so the quota-amplification vector and the silent
under-return are both gone — and because it reads live ownership directly, it's
correct across secondary transfers, position-NFT burns on claim, and the other
lifecycle cases an indexer projection can lag on. The wallet's role (lender vs
borrower) is resolved from the loan's fixed position-token identifiers, and a chain
this indexer doesn't serve now returns a clear "not configured" response so the app
falls back to reading the chain directly rather than showing an empty list.

(Part of the pre-audit security sweep. A separate, lower-severity defense-in-depth
note about escaping reflected on-chain text is tracked on the frontend. The
on-chain enumeration is bounded by the wallet's NFT count; a paginated variant — to
keep even a wallet deliberately stuffed with thousands of dust NFTs responsive — is
tracked as a follow-up.)
