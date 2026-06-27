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

These endpoints now answer entirely from the indexer's own current-holder columns
(which already track who currently holds each loan's lender/borrower position NFT,
including secondary-market transfers), with a real database row limit. The work per
request now scales only with the requesting wallet's **own** holdings, not the
global loan count, and makes **zero** on-chain calls — closing both the
quota-amplification vector and the silent under-return bug. The observable results
are unchanged for honest callers; the on-chain position view remains the
authoritative fallback the app uses while the indexer catches up.

(Part of the pre-audit security sweep. A separate, lower-severity defense-in-depth
note about escaping reflected on-chain text is tracked on the frontend; a paginated
on-chain position view is a possible future hardening of the fallback path, not
required for this fix.)
