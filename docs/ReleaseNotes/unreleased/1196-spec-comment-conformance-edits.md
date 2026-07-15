## Thread — Pass-2 documentation and code-comment corrections (spec-doc PR)

This is a documentation-and-comments-only change: it corrects stale spec text and
stale code comments that the Pass-2 conformance review flagged as lagging the
ratified code. There is no behaviour change and no ABI change.

Functional-spec corrections: the refinance payoff description is now
mode-aware (a full-term-interest loan preserves full-term interest, a
pro-rata-opted loan settles only the accrued amount); a refinance-tagged offer's
principal is described as frozen (not adjustable); the retired `setStakingApr`
and `updateRiskParams.liqThresholdBps` governance knobs are removed/replaced with
the current per-tier liquidation-threshold setter; the position-NFT
transfer-lock exception for a live prepay-sale listing is acknowledged; the
oracle-unavailable sanctions posture is corrected to note that never-flagged
wallets keep the liveness (fail-open) behaviour; the flash-loan liquidator's
profit-headroom is clarified as off-chain keeper policy rather than an on-chain
revert condition. (The proposed fee-discount-consent carve-out for an
already-prepaid borrower rebate was NOT made: review found the ratified code
does not preserve it — a consent-off settlement zeros the rebate and forfeits
the prepaid VPFI to treasury — so it was re-opened as a code-vs-spec decision
rather than a spec edit.)

Code-comment corrections: a partial-liquidation docstring now describes the
current interest-clock-only re-stamp (maturity is immutable); the tier
liquidation-threshold comments are de-inverted (Tier 1 is the conservative low);
a sequencer-outage comment is corrected (time-based defaults revert, they don't
transfer collateral); and a rental-NFT comment is corrected to the vault-custody
model. A residual retired-terminology comment sweep is tracked separately.

Closes the Pass-2 spec/comment cluster (umbrella #1196). Related follow-ups:
#1253 (terminology sweep), #1251 (alpha02 consumers).
