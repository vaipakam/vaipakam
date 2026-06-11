## Thread — T-092 #518 sibling: add AdminFacet + AutoLifecycleFacet to keeper-bot ABI export

Companion to `vaipakam-keeper-bot` PR #7 (sibling repo). The bot now has an `autoExtendDetector` mirroring the apps/keeper `runAutoLifecycle` pass; this PR makes future `bash contracts/script/exportAbis.sh` runs pick up the two facets the new detector reads, so the bot's `src/abis/` stays in sync with the monorepo.

### What's new

`contracts/script/exportAbis.sh` FACETS array gains:

- **`AdminFacet`** — `getAutoExtendEnabled()` admin kill switch.
- **`AutoLifecycleFacet`** — `getAutoExtendBorrowerCaps` / `getAutoExtendLenderCaps` / `extendLoanInPlace` (the new detector's read + write surface).

### Why this matters

Without this update, a future operator who runs `bash contracts/script/exportAbis.sh` after a contract change would not refresh the two new ABI files. The bot's auto-extend detector would silently decode against a stale shape and break on the next selector change. Adding them to the FACETS array makes the sync mechanical.

### What's NOT in this PR

The actual detector + the initial ABI seed went into the sibling repo via PR vaipakam-keeper-bot#7. This PR is the monorepo-side companion so future syncs don't drift.

### Verification

- `bash -n contracts/script/exportAbis.sh` syntax check passes (no actual run because that writes into the bot repo's working tree).
