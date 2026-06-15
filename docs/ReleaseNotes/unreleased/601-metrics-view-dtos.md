# Lean summary projections for paginated dashboard views (#601)

The paginated dashboard and analytics views that return **lists** of loans or
offers now hand back a **lean summary** of each row instead of the entire
on-chain record. The summary carries exactly the fields the dashboard and
analytics surfaces render — identity, the principal and collateral terms,
status, the position-NFT ids, and (for loans) the at-init liquidation
threshold; (for offers) the rate/amount ranges, fill progress, and expiry.

Affected views: the per-user dashboard loan lists (both the single-side and
the combined-sides variants), the per-user dashboard offer list, and the
"all of a user's offers with details" list.

Anything that needs the *complete* record for a single loan or offer — the
rental-prepay accounting, periodic-interest state, fallback/discount
snapshots, or the offer's listing/parallel-sale/refinance flags — continues
to read it from the single-item detail views (`getLoanDetails`,
`getOffer`/`getOfferDetails`), which are unchanged and still return the full
record.

**Why:** returning an *array* of the full 40-plus-field record forced the
Solidity compiler's ABI encoder past an internal stack limit when the whole
test suite was compiled as one unit — a build-time failure that the
per-PR CI lane never saw (it compiles a narrower scope) and that only
surfaced in a full local regression. Projecting each list row onto a small
flat summary keeps that encoder shallow and the whole project compiles
cleanly again. There is **no change to what data the platform exposes or how
loans/offers behave** — only the shape of the list payloads, which now omit
fields the list screens never displayed anyway (and which remain available
from the detail views).

A nested-sub-struct reshaping of the core loan/offer records was trialled
first and **reverted** — it made the build-time problem worse rather than
better. See #601 for the full rationale.
