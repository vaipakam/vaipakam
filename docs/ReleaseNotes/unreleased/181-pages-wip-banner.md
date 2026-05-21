## WIP banner on the public NatSpec docs site (Issue #181)

`https://vaipakam.github.io/vaipakam/` went live in #177 — but the
auto-generated NatSpec mdbook still describes the **pre-T-068
LayerZero architecture** in several places. The CCIP migration
(T-068, April 2026) was supposed to scrub those references; the
NatSpec scrub didn't get its own pass. Ten files in `contracts/src/`
carry residual LayerZero comments, and the file
`contracts/src/interfaces/IRewardOApp.sol` is still imported by two
facets — that's real code drift (#181 tracks the full scrub).

While #181 is open, the live docs site can mislead auditors /
integrators landing on it. This change adds a **sticky, high-
contrast "WORK IN PROGRESS" banner** to every page of the generated
site — including the home page, every facet, every function. The
banner names the issue, points at the current cross-chain authority
(ADR-0004 + the CCIP migration plan), and stays pinned during
scroll so it can't be missed.

Implementation lives entirely in `contracts-docs.yml` (no contract
or doc-source changes):

- `forge doc --build` runs unchanged.
- The post-build step now (a) writes the existing `CONTEXT.md`
  breadcrumb, (b) sed-injects the banner `<div>` right after every
  `<body>` tag in `contracts/docs/book/**/*.html`, (c) sanity-checks
  the home page for the banner string and fails the workflow if
  injection didn't take.

Banner styling is inline (no separate CSS file to manage) so the
mdbook theme switcher (light / dark / ayu) can't defeat it.

When #181 closes, the entire banner block in
`.github/workflows/contracts-docs.yml` gets removed in the same PR
— the workflow file is the single source of truth for the banner's
lifecycle.
