## Thread — Recycled-credit counters lose their upgrade-in-place seeding (PR #<n>)

Each chain's recycling ledger carried machinery for a Diamond refreshed in place over state older than its counters. The lifetime absorption figure a chain reports to Base was published as the larger of the stored counter and a floor derived from the bucket and the payout total, so an upgraded chain whose counter was still zero would report its historical absorption. Several ledger writes copied that floor into the stored counter first. A flag recorded whether recycled accounting had ever run, so the watcher could treat a zero counter on an upgraded chain as unverifiable. An admin ceremony, resumable across transactions and guarded against races, rebuilt the released-remittance stranded total and the lifetime release count from the reservation history. Every chain reaches this build by fresh deploy (owner decision O1 = A), so every counter starts at zero with the Diamond and is exact from the first credit. All of this is removed. Nine storage slots stay in place under retired names, so the layout is unchanged.

What changes for a reader:

- The cumulative a chain reports to Base is now exactly the stored absorption counter. The floor could only add wei-scale rounding dust from a claim that consumed slightly more than the bucket held; the reported figure no longer picks that dust up.
- The composition view no longer returns the "accounting seeded" flag. Its outputs are now: credited, released-remit stranded, canonical role, released-remit resolved.
- The stranded-seed functions, their state view, their errors and events, and the lifetime release counter that only the ceremony read are gone. The in-place redeploy script no longer prints the ceremony, and its runbook section is removed.
- The mesh watcher's bucket-composition check is always critical now; the "unverifiable, unseeded" advisory is gone. The `reported-derivation` check is retired: with no floor it would compare one stored number with itself. The relocation exclusion is still caught by bucket composition.

Refs #2875.
