## Thread — The connected app downloads a quarter of the contract data it used to (PR #2392)

Every connected session downloads a description of the platform's contract: which functions exist, and which errors and events it can report. The 2026-10-03 live review found this file had grown to 2.8 MB, about three and a half times its size in July. That was recorded as UX3-008.

The cause was repetition, not growth. The description was assembled by joining each part of the contract's own description. Each part repeats the errors and events it shares with the others, and three quarters of the file was exact copies.

The description is now built once, when the contract data is exported, with the exact copies removed: 0.65 MB instead of 2.8 MB. A removed copy is identical to the entry kept, so nothing the app, the indexer or the keepers can read or decode has changed. The indexer's own coverage checks report the same events before and after.

A check now fails the build if the combined file falls out of date, or if a new part of the contract is not listed in it. The file can no longer drift from the parts it is built from.
