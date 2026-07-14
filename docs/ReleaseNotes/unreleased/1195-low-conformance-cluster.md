## Thread — Six low-severity spec-conformance fixes (PR #1195)

This change lands six small, independent conformance fixes surfaced by the
Pass-2 review, each a "do exactly what the spec says" correction:

- **Signed-offer single-value shorthand on the direct fill path.** A signed
  offer can be authored with its upper amount left as zero, meaning "fill at the
  single stated amount". The order-matching path already understood that
  shorthand, but the direct-accept path did not and rejected such an offer. Both
  paths now honor it, so an offer that fills through matching also fills through
  a direct accept.
- **Expired offers are now reported as expired.** The authoritative offer-state
  read had no "expired" value, so an offer whose good-till time had passed still
  read as "open" (even though fills correctly refused it). It now reports a
  distinct expired state once its deadline is reached.
- **Good-till-time boundary.** A signed offer is now treated as expired at its
  deadline second, not only strictly after it, matching the rest of the
  protocol's expiry checks.
- **Treasury analytics on time-based defaults.** When a liquid asset is
  liquidated on a time-based default, the treasury's cut is now recorded in the
  revenue analytics counter, matching the health-factor liquidation paths; the
  figure was previously under-counted for this path.
- **Late cross-chain reward self-report is now rejected.** On the home chain,
  submitting a day's reward self-report after that day has already been
  finalized is now refused, matching the guard the incoming (mirror-chain) path
  already had. Storing a late report was harmless to payouts but corrupted the
  day-completeness bookkeeping and the audit trail.
- **Mainnet timelock minimum-delay floor.** The governance timelock deploy now
  refuses a minimum delay below 48 hours on a Phase-1 mainnet, so the delay
  can't be floored to the 1-hour development minimum without a gate. Testnets
  keep the 1-hour floor for iteration speed.

None of these change the ABI. The offer-state addition appends a new value to an
enum (keeping the existing values and wire encoding unchanged); consumer apps
that display offer state will gain a new "expired" case to surface, tracked
separately. Closes #1195 (Pass-2 conformance umbrella #1196).
