## Thread — release-notes automation: per-PR fragments + CI drift backstop (PR #48)

Release notes were appended to a per-day file from memory after each
merge, and that lagged — 2026-05-17 had five threads merge to `main`
with no release-notes coverage, and the 2026-05-16 file was committed
mid-day so it missed that day's later merges.

Release notes now use a fragment model. Every behaviour-changing PR
carries its own note as a small file under
`docs/ReleaseNotes/unreleased/`, committed in the PR's own diff — so the
note merges atomically with the work and two PRs landing the same day
never append-conflict. After the day's PRs merge,
`docs/ReleaseNotes/assemble.sh` folds the pending fragments into the
dated `ReleaseNotes-<date>.md` file and clears them. A non-blocking CI
check warns in the Actions tab when a merge to `main` changed contract
or app code but added no release-notes entry. The convention is
documented in `docs/ReleaseNotes/unreleased/README.md` and `CLAUDE.md`.

This release note is itself the first fragment authored under the new
convention. Closes #47.
