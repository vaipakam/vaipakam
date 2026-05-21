## Contracts docs site — auto-enable Pages on first deploy (Issue #177)

The `Contracts docs` workflow (push-to-main NatSpec → mdbook site
publish) had been failing on every recent push with
`Get Pages site failed ... Error: Not Found`. The root cause was not
`forge doc` (that step succeeded — mdbook + breadcrumb generated):
GitHub Pages had never been enabled on the repository at all, so the
`actions/configure-pages` step couldn't find a Pages site to deploy
to.

The fix is a one-line change to pass `enablement: true` to that step.
With that, the action auto-creates the Pages site with
`build_type=workflow` on first run when no site exists, then succeeds
no-op-style on every run after. The workflow already carries the
`pages: write` permission that `enablement` exercises.

Side-effect: the next push to `main` after this PR merges will
self-provision the Pages site at `https://vaipakam.github.io/vaipakam/`
and start serving the generated docs from there. No operator action
needed — the workflow file is now self-sufficient.

This does not touch the `Build docs` job inside `ci.yml` (the PR-time
preview-artifact path), which uploads its artifact directly and never
talks to Pages. That job was already green on every contracts PR.
