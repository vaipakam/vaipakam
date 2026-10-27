## Rewards — the legacy envelope import is retired, and every reward delivery must add up (PR #TBD)

A mirror chain keeps an "uncounted" tally of reward value that arrived without
a split saying how much of it was fresh funding and how much was recycled.
Until now there were two ways value could enter that tally and stay there with
nothing to classify it:

- a Diamond upgraded in place carried value that arrived before deliveries were
  stamped with an identity. An administrator imported that inventory once, as
  one aggregate, through a dedicated "envelope" entry with a preview and a
  read-back view;
- a delivery on the older, non-epoch path whose fresh and recycled figures
  added up to less than what arrived left the difference in the tally, where
  no packet record could ever classify it.

Every chain reaches this build by a fresh deploy, so there is no pre-stamp
inventory. The ingress now refuses any delivery whose fresh and recycled
figures do not add up to exactly what arrived, on both the epoch and the
non-epoch path, before anything else is recorded. The refusal is
re-executable, so a delivery is never lost to it. With both sources closed,
the tally on a fresh deploy only ever rises by an amount it also records
elsewhere: value held aside for a return, which the returned-value total
explains once it goes back.

Removed together:

- the envelope import, its preview and its read-back view, its event and the
  three refusals it could raise;
- the custody helper only that import used.

The administrator's per-packet classification and its correction are
unchanged. The envelope's storage keeps its place, renamed retired, so the
storage layout only grows.

Refs #2910.
