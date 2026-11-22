# Per-asset pause log (#3880)

Every use of the per-asset pause (`AdminFacet.pauseAsset`) and every lift is
recorded here, in public, under the rule in
[`IncidentRunbook.md`](IncidentRunbook.md) §3.8. The contract's
`AssetPauseEnabled` / `AssetPauseDisabled` events carry no reason; this file
is where the reason lives.

## Rules for this file

- **Append only.** Add an entry for each pause and a line for each lift.
  Nothing already written is rewritten or removed. A correction is a new
  line under the entry, starting "Correction (date):".
- **Open it at once.** Opening the entry is a step of the incident
  checklist (§3.8): the network, the asset, the time, the reason number and
  one sentence go in straight away. Evidence that would help someone
  exploit a fault that is still open is added once it is safe; until then
  the entry says "Evidence follows."
- **Say what the pause stops that day.** What the pause refuses can change
  between builds (#3887 will open top-ups and reserve funding), so each
  entry states it as of the day it was opened.
- **One machine-readable marker per pause and per lift**, so the daily
  launch check can compare this file with each network: a pause entry
  starts with `<!-- pause network=<folder> asset=<address> -->` and a lift
  line with `<!-- lift network=<folder> asset=<address> -->`, where
  `<folder>` is the network's folder under `contracts/deployments/`. An
  entry is open until a lift marker for the same network and asset follows
  it.

## Entry template

```markdown
<!-- pause network=<folder> asset=<address> -->
### <network>: <asset symbol> (<address>), paused <YYYY-MM-DD HH:MM> UTC

- Transaction: <hash>
- Reason: <1 (the asset's own code) or 2 (the platform's own reading)>. <One sentence.>
- Evidence: <links, or "Evidence follows.">
- What the pause stops today: <new positions and loan sales in the asset; and,
  until #3887, top-ups, the collateral reserve top-up and reserve funding>.
  Every close-out stays open.
- Lifting: <after handover, through the Timelock's delay; before handover the
  admin lifts it directly>.

<!-- lift network=<folder> asset=<address> -->
- Lifted <YYYY-MM-DD HH:MM> UTC, transaction <hash>: <what changed>.
```

## Entries

None yet.
