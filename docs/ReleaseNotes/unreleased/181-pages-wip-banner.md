## WIP banner on the public NatSpec docs site — shipped and retired (Issue #181)

When `https://vaipakam.github.io/vaipakam/` first went live (#177),
the auto-generated NatSpec mdbook still described the **pre-T-068
LayerZero architecture** in several places. The CCIP migration
(T-068, April 2026) had scrubbed the deployed contracts but the
NatSpec comments hadn't been swept yet — auditors / integrators
landing on the docs site could honestly try to follow wording that
no longer matched the code.

This release shipped a temporary **sticky, high-contrast "WORK IN
PROGRESS" banner** on every page of the generated site — home page,
every facet, every function — to flag the discrepancy while the
scrub was in flight. The banner named the issue, pointed at the
current cross-chain authority (ADR-0004 + the CCIP migration plan),
and stayed pinned during scroll so it couldn't be missed.

The scrub then landed in PR #190 (issue #181 closed). With the
discrepancy gone, the same release cycle retired the banner: the
post-build step in `.github/workflows/contracts-docs.yml` now only
writes the `CONTEXT.md` breadcrumb at the site root pointing at the
protocol-level docs (the ADR set, glossary, functional specs,
operator handbook). No banner is injected.

The next docs build re-publishes the site without the banner.

Implementation lived entirely in `contracts-docs.yml` (no contract
or doc-source changes for either the add or the remove). Banner
styling had been inline so the mdbook theme switcher (light / dark
/ ayu) couldn't defeat it; the inline approach also meant the
removal was a single workflow-step edit, no stylesheet cleanup
needed.
