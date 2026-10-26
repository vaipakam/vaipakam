## Thread — Keeper reads a Diamond's forced-sale surface in one request (PR #<n>)

The keeper now finds out which forced-sale calls a Diamond routes (added in #2908) with one loupe read per attempt. Before, it made ten: five at the start and five again at the final gate. The grace-default pass runs under a hard budget of 40 requests per visit, and on BNB Testnet the extra reads used it up, so the two past-grace test loans there were skipped on every visit with "subrequest-budget-spent".

The single read asks whether the Diamond routes the sale plan. If it does, the keeper uses the sized calls; if not, it uses the older whole-collateral ones. Nothing is lost by dropping the other reads. The keeper still previews or estimates the exact call it is about to send, and a call the Diamond does not route reverts there, before anything is broadcast. So a Diamond part-way between the two surfaces, or one cut while an attempt was being judged, still gets nothing sent. The log now shows that as a preview failure rather than a named "mixed surface" reason.

The whole-collateral bridge is still removed at the all-waves fresh deploy (#2907).
