# `apps/www` live post-deploy drives

Committed drives that exercise the **deployed** marketing site. They run
after a production deploy, per the live-review definition-of-done — not
against a preview build, and not as part of CI.

## Why these are not CI specs

Each one checks something that is only true once the deployed site has
fetched the published protocol-config snapshot from the deployed
indexer. A preview build, a prebuild guard, or an inspection of the
shipped bundle can all pass while the rendered page shows something
else. That gap is the reason the live review exists, so closing it
requires a real browser pointed at the real origin.

The `apps/www` prebuild guards (`check:livevalue`, `check:knobs`, and
the rest of `pnpm --filter @vaipakam/www typecheck`) cover the
build-time half and stay the first line of defence. These drives cover
what those structurally cannot see.

## Running one

```bash
pnpm --filter @vaipakam/www exec node e2e/live/live-worked-example.mjs
```

Override the target with `WWW_ORIGIN` (defaults to
`https://vaipakam.com`):

```bash
WWW_ORIGIN=https://preview.example.com node apps/www/e2e/live/live-worked-example.mjs
```

Each drive prints a `PASS` / `FAIL` / `SKIP` line per check and exits
non-zero if anything failed, so it can gate a release step.

`SKIP` is used deliberately where a check is only meaningful under
known configuration — a value assertion pinned to the shipped default
fee rates is skipped, not failed, after a governance retune, and the
live rates are printed so the skip is legible rather than silent.

## Known environment limitation

**These cannot currently run from a Claude Code remote container**
(#1777). Chromium gets `ERR_CONNECTION_RESET` on every navigation
through the agent proxy, while `curl` to the same URL through the same
proxy returns 200. Run them from an operator machine until that is
fixed. Substituting a bundle inspection is not the same assurance and
should not be reported as though it were.

## The drives

| File | Covers | Introduced by |
| --- | --- | --- |
| `live-worked-example.mjs` | The Overview's worked-example figures render as derived live values with the contract's integer arithmetic and honest provenance; the help search finds a page by a figure printed on it | #1751 (#1664 items 1 + 2) |

## Adding one

Keep them dependency-free beyond `playwright`, parameterised by
`WWW_ORIGIN`, and self-describing on stdout — someone reading the
output during a release should be able to tell what was checked without
opening the file. Query with what the page actually rendered rather
than a hardcoded expectation wherever the invariant is "these two
agree", so the drive keeps testing the invariant after a retune instead
of testing a snapshot of one moment's configuration.

Add a row to the table above in the same change.
