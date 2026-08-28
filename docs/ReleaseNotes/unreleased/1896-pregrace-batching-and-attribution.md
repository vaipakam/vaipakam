## Thread — The keeper's per-tick RPC budget, told apart into scan and action (PR #1992)

The keeper's CPU profiling harness could say how many RPC calls each pass made
per tick, but not what they were for. That gap produced a wrong conclusion the
first time the numbers were published: the liquidator's 528 calls were read as
book-scanning work and queued for batching, when in fact the fixture answers
every health factor below the liquidation line, so every loan it scanned was
actionable and most of those calls were the submission path. Batching them
would have optimised a fixture artifact.

The harness now attributes every request by the contract function it called
(or, for the non-contract ones, by its JSON-RPC method), separates the
transaction-submission methods into a stated subtotal, and reports what was
carried inside each batched read rather than only that a batch happened. The
resulting per-pass breakdown answers the question the bare call count could
not: a pass whose traffic is a paginated list plus one read per item is doing
book scan and batching is the fix; a pass whose traffic is quotes, nonces, gas
estimates and sends is doing per-item work, and the fix there is a bound on how
many items it acts on per tick, or nothing at all. The action share is
explicitly a worst case — the fixture presents a fully saturated book — while
the scan share does not depend on that, and the runner says so in its output.

Applied to the ten passes, that split named one unambiguous case. The pre-grace
warning pass made 612 requests per tick with not one of them on a transaction
path: three sequential reads per active loan, plus one read per offer in the
book it consults to decide whether a borrower already has a viable
counterparty. All of it scan. Those reads are now issued as batched
multicalls in three stages — opt-in caps first, loan details for the loans that
opted in, then the borrower-NFT owner for the loans actually inside the warning
window — which is 24 requests per tick instead of 612, with the same reads
performed and the same per-loan failure isolation. A loan whose read reverts is
still logged and skipped rather than aborting the chain. Nothing about which
borrowers get warned, or when, changes.

The three-stage shape is deliberate rather than one flat batch: each stage's
input is the previous stage's survivors, so reading loan details for a loan
whose owner never opted in would trade the saved round-trips straight back.
A test pins the traffic shape for all four of the pass's reads separately —
a partial regression where one stage quietly falls back to per-item reads while
the others batch is exactly what a combined count would hide.

Refs #1896.
