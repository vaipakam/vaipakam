# VPFI tier table joins the config-snapshot display path (#1238)

Follow-up to the read-diet config-snapshot slice, found during the
post-deploy live review: the VPFI discount tier table shown on the
Help and VPFI pages was still read live from the chain on every visit,
even though the indexer's config snapshot already carries the tier
thresholds and discounts.

The tier-table display now reads the snapshot first — zero per-user
chain reads — and falls back to the live chain read when the snapshot
is absent, stale, or arrives in an unexpected shape. Fee settlement is
unaffected: discounts are applied by the contract on-chain, never from
this display surface.
