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

These endpoints now answer **purely from the indexer's database** — zero on-chain
calls, so the operator's RPC quota is never touched and the work scales only with
the requesting wallet's own holdings. To make that database answer trustworthy
(real funds are at stake for claimables), the indexer's record of *who currently
holds each loan's lender/borrower position* was made authoritative across the
lifecycle cases it previously missed:

- a position NFT **burned** on claim now correctly drops out of the lists (it was
  staying attributed to the last holder);
- a **lender sale** or **borrower-obligation transfer** mid-loan (which mints a
  fresh position token for the new party) now re-points ownership to that party;
- a loan whose offer position NFT was **sold on the secondary market before the
  offer was accepted** is now attributed to the actual holder, not the original
  offer creator.

A chain this indexer doesn't serve now returns a clear "not configured" response
so the app falls back to reading the chain directly rather than showing an empty
list.

(Part of the pre-audit security sweep. The app additionally confirms ownership
on-chain using the **user's own wallet** as the authoritative layer over this
database projection — see the companion frontend change. A separate
defense-in-depth note about escaping reflected on-chain text is tracked on the
frontend. Operational note: the position-owner projection is rebuilt from the
chain's transfer history during normal indexing; an environment that pre-dates the
current-holder columns is brought current by a one-time re-index.)
