## Thread — VPFI-token rotation now has an operational guard + an on-chain audit signal (#575)

The address of the VPFI token registered on the Diamond is normally set
exactly once, at deploy. Changing it afterwards — *rotating* it to a
different address — is a rare, migration-class event. Two checks read the
currently-registered token directly: the rule that forbids VPFI as an
NFT-rental prepay asset, and the VPFI-collateral encumbrance consult. So a
rotation done while offers or loans created under the old token are still in
flight leaves a brief window where those checks evaluate against the new
token instead of the one a position was created under.

This is low-risk and operational, not a live bug: there is no way to lose
funds (each user's collateral lien is protected independently of which token
is "current"), and no production state exists yet. The window is a
correctness/UX concern on the checks, not a drain.

The decision recorded for this item is to treat rotation as a controlled
operational procedure rather than to permanently snapshot a token address
onto every offer and loan (which would be disproportionate for a rare,
no-fund-loss, pre-live event). Two things ship:

- **A rotation runbook** (`docs/ops/VPFITokenRotationRunbook.md`) — the safe
  pause → drain live old-token offers/loans → verify zero exposure → rotate →
  re-enable procedure, with the rationale and the decision write-up.
- **An on-chain audit signal** — rotating the token now emits a distinct
  `VPFITokenRotated` event (in addition to the standard set event) whenever
  the previous address was non-zero. The one-time initial registration does
  not emit it. This lets ops and indexers detect a rotation and confirm the
  runbook was followed.

If the protocol later expects routine rotations with live state, the robust
per-position snapshot approach can be revisited. Closes #575.
