## Rewards — the recovery-attribution watermark is retired (PR #TBD)

The recovery position on the canonical reward chain was guarded by a
watermark. It was a one-shot arming step that froze every recovery receipt
created before per-receipt attribution existed, so a Diamond refreshed in
place could not let an old receipt, whose spends had been tracked only as a
total, draw on a newer receipt's backing. A fresh canonical deploy armed that
watermark at zero before its first receipt existed, so on this build it never
held anything back. Every chain reaches this build by a fresh deploy, so the
watermark is removed, together with everything that read it:

- the administrator's arming call and the arming step in the in-place refresh;
- the custody activation's requirement that the watermark be armed, and the
  matching check in the activation script;
- the rule that kept an old receipt's late return or recovery ceremony out of
  the recovery position. Every stranded return and recovery-ceremony inflow
  now credits its receipt's recovery position;
- the separate "returned" figure the unclassified custody row kept for such
  returns. The unclassified row now holds only deliveries' unattributed
  remainders and quarantined compensation; its read-out reports what the
  row holds and how much of the stranded-recovery reservation it backs.

Nothing changes for an operator of a fresh deploy: the arming was automatic
when the chain was made canonical. The two watermark storage slots and the
returned figure's slot keep their places, marked retired, so the storage
layout is unchanged.

The same change drops the generation-1 wording around the remit
acknowledgement's classification. The wire still offsets the classification
by one, so a zero word is never read as a classification, but no
generation-1 messenger can deliver on this build.

Refs #2910.
