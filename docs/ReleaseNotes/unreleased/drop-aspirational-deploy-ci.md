## Thread — Drop aspirational deploy-workers.yml + 3 GitHub Environments (PR #<n>)

Removed `.github/workflows/deploy-workers.yml` and the three unused
GitHub Environments (`mainnet`, `testnet`, `dev`). The workflow was
designed to run `wrangler deploy` from CI on every push to `main`, but
it never had the Cloudflare credentials it needed (`CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID` — neither set at the repo level nor inside any
environment). The result was that every PR touching `apps/defi/` or
`ops/hf-watcher/` quietly failed the deploy job, and every other PR
"succeeded" only because the path-filter short-circuited the job
before it could attempt the broken deploy.

The real deploy path is `wrangler` on the operator's local machine —
authenticated by an interactive `wrangler login` whose credentials
live in the operator's browser session, never in a shared service.
Adding a long-lived Cloudflare API token to GitHub purely to enable
CI deploys we don't actually use would have introduced security debt
(a leaked PAT is a deploy-to-our-domain attack vector) without
delivering any operational benefit.

What this changes:

- `.github/workflows/deploy-workers.yml` deleted.
- The 5 `apps/*/README.md` files that documented `pnpm deploy` as
  "via `.github/workflows/deploy-workers.yml`" now say
  *"wrangler deploy; uses `wrangler login` on the operator's machine"* —
  matching how deploys actually happen today.
- `docs/internal/CloudflareStagingState.md` drops the
  `deploy-workers.yml matrix` row from its "Pending — author action"
  list, since that item no longer corresponds to planned work.
- The three GitHub Environments (`mainnet` / `testnet` / `dev`) are
  deleted via the API. Nothing referenced them, and the
  `required_reviewers` rule on `mainnet` was guarding a workflow that
  no longer exists.

If CI-driven deploys are ever needed, the cleaner path is to author a
fresh workflow then with OIDC-based short-lived authentication (the
shape supported by major cloud providers; Cloudflare's OIDC story
should mature over the next year), rather than carrying a long-lived
Cloudflare PAT in the repo.
