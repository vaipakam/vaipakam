## Thread — Serialize contracts CI jobs to halve cold-cache build cost (PR #<n>)

The CI workflow that landed in #84 + #86 ran `contracts-fast` and
`contracts-full` in parallel. Both jobs invoked `predeploy-check.sh`,
which itself runs a cold `forge build` before testing — so a typical
fresh PR paid for the same compile twice on two parallel runners.
Compute is free on public repos, so this didn't cost a dollar, but
the duplicate work was visible as wasted CI minutes and would matter
materially if Vaipakam ever moved to a self-hosted runner (one
machine, sequential builds, full cost on each duplicate).

This change serializes the two jobs: `contracts-full` now
`needs: contracts-fast`. The cache mechanics that make this efficient:

- `actions/cache` saves the cache at job END (post-action hook fires
  when the job finishes — `out/` + `cache/` get persisted under the
  content-based key contracts-fast just populated).
- A subsequent job in the SAME workflow run that hits `actions/cache`
  with the same key restores from that just-saved entry.
- contracts-full now restores contracts-fast's freshly-built
  artifacts, so its own `forge build` step hits warm and skips
  re-compile entirely.

Critical-path latency to merge-ready is UNCHANGED: contracts-fast is
the required-status-check gate either way. The only observable
difference is that contracts-full's wall-clock visibility on the PR
arrives ~5-10 min later than before — it's informational only, not
gating, so a slight delay there doesn't slow merges.

A bonus property of the serial design: if contracts-fast fails, the
`if: needs.contracts-fast.result == 'success'` guard skips
contracts-full entirely. Fail-fast — no point burning compute on a
full regression when the build itself is broken.

The `contracts-full` timeout drops from 45 → 30 min in this change.
With warm-cache restore the cold-build minutes are no longer in this
job's budget; 30 min leaves comfortable headroom for the full
regression itself (~5-15 min observed) plus runner variability.

Closes #74 (the optional CI-hygiene optimisation; the required-check
gate landed earlier in this arc).
