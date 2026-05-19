## Thread — OfferFacet split into OfferCreateFacet / OfferAcceptFacet (PR #<n>)

`OfferFacet` had grown to 23,993 bytes of runtime code — only 583 bytes
under the 24,576-byte EIP-170 contract-size limit the EVM enforces. One
more feature on the offer surface would have breached the limit and made
the protocol's diamond undeployable — the same failure mode the
`RiskFacet` split (Issue #66) fixed reactively. This change addresses it
proactively, before the breach.

`OfferFacet` carried two self-contained bodies of work — offer
*creation* and offer *acceptance*. They were lifted into two facets of
the same diamond:

- **`OfferCreateFacet`** — creating lending and borrowing offers
  (including the Permit2 and cross-facet internal variants), and the
  per-user escrow lookup.
- **`OfferAcceptFacet`** — accepting offers, which initiates the loan,
  plus the rental-prepay and transaction-value helpers.

The cross-facet escrow-resolution wrapper that both halves rely on was
extracted into a small shared library (`LibUserEscrow`) so it lives in
one place rather than being duplicated.

This is a pure relocation — no logic changed. The same functions run the
same way; they are simply hosted by two facets instead of one. The offer
events and errors moved with their respective functions (their on-chain
signatures, and therefore their topic and selector hashes, are
unchanged, so indexers and consumers see no difference). After the
split, `OfferCreateFacet` is 10,839 bytes and `OfferAcceptFacet` is
15,982 bytes — both with a comfortable margin under the limit. The
diamond now cuts 36 facets.

Because the change is a mechanical split with no behavioural difference,
no functional-spec update is required.

Closes #67.
