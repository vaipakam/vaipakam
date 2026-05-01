# Release Notes — 2026-05-02

Functional record of work delivered on 2026-05-02, written as
plain-English user-facing / operator-facing descriptions — no
code. Continues from
[`ReleaseNotes-2026-05-01.md`](./ReleaseNotes-2026-05-01.md).

Coverage at a glance: one piece of housekeeping — **merging six
commits from `main` into `feat/range-orders-phase1`** (LayerZero
buyOptions defaults, BuyVPFI error fixes, README whitepaper
content, gitignore housekeeping) so the feature branch is current
with everything that landed on the trunk while range-orders work
was in flight. No new contract logic. No new frontend features
beyond what the merge brought in.

## main → feat merge

Background: while the Range Orders Phase 1 work has been
progressing on `feat/range-orders-phase1` for several weeks, six
commits landed on `main` in parallel — small operator-quality
items (a deployment-script ergonomics pass, a Buy VPFI error fix,
a README whitepaper update, a `.gitignore` cleanup). To avoid the
feature branch drifting too far from the trunk before its
eventual merge, today's batch pulls those six commits in.

**Commits brought across:**

- `715290a` — Buy VPFI error fix: `quoteBuy` was reverting with
  `LZ_ULN_InvalidWorkerOptions` (selector `0x6592671c`) on a
  freshly-deployed adapter when the operator forgot the post-deploy
  `setBuyOptions` call. The fix encodes a default Type-3 LayerZero
  payload inline at deploy via
  `OptionsBuilder.addExecutorLzReceiveOption(LZ_RECEIVE_GAS,
  LZ_RECEIVE_VALUE)` so the adapter is buyable end-to-end without
  the follow-up step. Default gas budget 200,000; tunable per chain
  via env. Frontend gained a `journeyLog` hook around the
  bridged-buy `quoteFee` call so a `quoteBuy` revert now lands in
  the Diagnostics drawer instead of just the inline `quoteError`.
- `098c6ea` — `SetBuyOptions.s.sol` companion script for
  post-deploy gas-budget adjustments to an already-live BuyAdapter.
  Same encoding shape as the deploy-time inline default, so the
  two paths produce byte-identical options when configured the
  same way.
- `e495c3c` — `.gitignore` adds `.claude/` (the Claude Code
  per-machine / per-session runtime state — `scheduled_tasks.lock`
  rewrites every session, `settings.local.json` is per-user,
  `worktrees/` is ephemeral). Two old per-machine lock files
  removed from tracking on the same commit.
- `1777ee4` — LayerZero scripts harness: cleans up the deploy
  script's options-building so all three flows (deploy-time,
  post-deploy `setBuyOptions`, the `BridgeVPFI` runtime quote)
  share one `OptionsBuilder` recipe.
- `5c77612` — README is now the canonical Whitepaper text — the
  same content shipped under `frontend/src/content/whitepaper/`
  is the repo's top-level README so anyone landing on the public
  GitHub gets the protocol overview directly without hunting.
- `9eb4784` — `docs/ProjectDetailsREADME.md` added — the
  internal/operator-facing companion to the public whitepaper.

**Conflicts hand-resolved during the merge:**

| File | Resolution |
|---|---|
| `.claude/scheduled_tasks.lock` | Accepted main's deletion (lock file, no value) |
| `.claude/settings.json` | Accepted main's deletion |
| `.gitignore` | Both branches' additions kept — `.claude/` block (from main) sits alongside the `docs/internal/RoughNotes.md` operator-scratchpad rule (from feat) |
| `README.md` | Replaced with the verbatim contents of `frontend/src/content/whitepaper/Whitepaper.en.md` per operator direction — the whitepaper IS the README, single source of truth |
| `contracts/script/DeployVPFIBuyAdapter.s.sol` | **Both branches' additions combined.** Main contributed the `OptionsBuilder` import + `_defaultBuyOptions()` helper + the inline buy-options encoding at deploy time. Feat contributed the `_chainRequiresWethPaymentToken()` pre-flight gate (T-036, mainnet WETH-pull mode enforcement on BNB / Polygon). Both functions coexist; the deploy flow now does the WETH-pull pre-flight first, then encodes default buyOptions if the env is unset, then broadcasts. |

**Auto-merged with no conflict markers** but worth noting:

- `frontend/src/pages/BuyVPFI.tsx` — main's `journeyLog` hook
  around the bridged-buy quote sat at lines that didn't overlap
  with feat's T-038 asset-symbol + CoinGecko-link work.
- `frontend/src/lib/decodeContractError.ts` — minor adjustment.

**Verified after the merge:**

- `forge build` clean on the combined state.
- `RepayFacet` targeted suite 63/63 passing (regression sanity
  check — repay path was the busiest area in T-037).
- Full no-invariants regression run as the final gate before the
  merge commit lands.

## Notes for follow-up

The feat branch is now ~59 commits ahead of main (53 pre-existing
+ 1 T-037 + 1 merge commit + the 6 inherited from main, minus
overlaps). The eventual feat → main merge at the end of Range
Orders Phase 1 should be straightforward — most of the
recent-trunk-vs-feat conflict surface was DeployVPFIBuyAdapter,
which today's merge already reconciled.
