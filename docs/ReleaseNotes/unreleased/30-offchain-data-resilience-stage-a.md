## Thread — Off-chain data resilience: Stage A (B2 backup) + design doc (PR #?)

Closes the lockout-survival gap that issue #30 (T-077) opened. The
protocol has always been single-cloud on the off-chain side: every
indexed offer / loan row, every legal-hold audit entry, every legal
document uploaded by an operator lives only in Cloudflare's D1 + R2.
A Cloudflare account loss — billing dispute, credential
compromise, accidental delete — would lose all of it. On-chain state
is unaffected (the Diamond + VPFI live on the chain itself) but the
off-chain layer is what makes the protocol *usable*: the offer-book,
the diagnostic stream, the legal-hold register.

This PR ships **Stage A** of the resilience plan: a new
`ops/cloud-backup` Cloudflare Worker that nightly exports the two
production D1 databases (`vaipakam-archive` + `vaipakam-lz-alerts-db`)
and mirrors the R2 `vaipakam-legal-vault` bucket to a **Backblaze B2**
bucket on a separate billing + credential boundary. Every archive is
client-side encrypted with AES-256-GCM using a key kept OFFLINE
outside Cloudflare. A second weekly cron probes the most recent
archive — confirming it exists, decrypts cleanly, and its SHA-256
matches the manifest — and pages the operator on any drift. The
restore procedure (stand-up of a fresh Cloudflare account, archive
decryption, table-by-table reload, indexer re-bootstrap from block 0)
is documented end-to-end in `docs/ops/OffChainRestore.md`.

The PR also lands the umbrella design doc
`docs/DesignsAndPlans/OffChainDataResilience.md`. The doc covers
Stage A and forward-references **Stage C** — a 2-required + 1-optional
multi-cloud indexer quorum across Cloudflare + Fly.io + Hetzner
(or equivalent), with a thin aggregator that takes the majority on
every offer-book read and treats divergence as a security alarm —
plus cold-standby for the keeper / agent / lz-watcher Workers. The
quorum work is sized for the audit-to-mainnet window and tracked as
a separate Project card; Stage A is intentionally the floor that
ships immediately so the worst case (CF lockout = total off-chain
loss) is no longer realistic.

The Worker itself is npm-based (outside the pnpm workspace, matching
the `ops/lz-watcher` precedent) and has the standard
`build`/`typecheck`/`deploy` script set so Cloudflare Workers Builds
runs the type-check as a pre-deploy gate.
