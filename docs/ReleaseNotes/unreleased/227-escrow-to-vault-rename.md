## Repo-wide rename — Escrow → Vault (Issue #227)

This release renames every "Escrow" / "escrow" reference across the entire
repo to "Vault" / "vault". The change is purely a naming clarification — the
on-chain semantics, fund flows, access control, and per-user isolation are
unchanged. What changed is the surface vocabulary:

- The per-user UUPS proxy that holds a user's assets used to be referred to
  as an "escrow"; from this release on, it is a "Vault" — the established
  DeFi-native term (Yearn, Curve, Morpho, and Aave all use "Vault" for
  per-user or per-position asset containers).
- The deploying facet renamed from `EscrowFactoryFacet` to `VaultFactoryFacet`;
  its shared implementation from `VaipakamEscrowImplementation` to
  `VaipakamVaultImplementation`; the cross-facet helper library from
  `LibUserEscrow` to `LibUserVault`. Every external function, event, error,
  storage slot, and ERC-7201 namespace tracks the same rename.

The motivation is a legal-implications cleanup. "Escrow" carries
regulated-fiduciary-holder connotations under several jurisdictions
(state-by-state US escrow agent statutes; UK Financial Services and Markets
Act references; EU MiCA's "custody" wrapper) — connotations Vaipakam does not
want to anchor to as a permissionless DeFi protocol. The on-chain object
isn't a regulated escrow; it's an isolated per-user vault under the user's
own beneficial ownership. The rename brings the surface vocabulary in line
with that reality before mainnet cutover, while the legal-cost-of-change is
still zero.

Pre-mainnet timing matters: ERC-7201 storage namespaces derive deterministic
storage slots from their string identifier
(`keccak256(abi.encode(uint256(keccak256(name)) - 1)) & ~bytes32(uint256(0xff))`),
so renaming `vaipakam.userEscrow*` to `vaipakam.userVault*` shifts every slot
that holds per-user vault state. Post-mainnet, that shift would orphan every
user deposit; pre-mainnet, with no deposits in flight, the shift is a no-op
for users. Function selectors and event topics also derive from the name
hash, so the rename invalidates every external selector / topic — the ABI
re-export (a separate sync step) regenerates them, and every consumer
(frontend, indexer, keeper, sibling reference bot) updates atomically with
this release.

What the release covers, top-down:

- **Smart contracts (`contracts/src/`)** — 7 file renames, ~110 source-file
  in-place updates. Facets, libraries, interfaces, the UUPS implementation,
  every external function name, event, error, storage variable, and
  ERC-7201 namespace.
- **Contract tests (`contracts/test/`)** — 4 file renames, every test fixture
  and assertion updated. The deploy-sanity guardrails (`FacetSizeLimitTest`,
  `SelectorCoverageTest`) pick the new symbol set up via `DiamondFacetNames`,
  which now lists `VaultFactoryFacet` in place of `EscrowFactoryFacet`.
- **Deploy scripts (`contracts/script/`)** — every deploy / flow script
  references the renamed facet; `exportAbis.sh` and `exportFrontendAbis.sh`
  list the new facet names.
- **Indexer (`apps/indexer/`)** — the event-routing decode shape, sourced
  from the compiled Diamond ABI, picks the new event names up automatically;
  the `check-event-coverage.mjs` CI guardrail's allowlist comments are
  rephrased. No SQL migration was needed — the audit found no `escrow_address`
  column in the migration history.
- **Frontend (`apps/defi/`)** — every component, page, hook, library helper,
  test, and i18n key (English source-of-truth) updated. The 9 non-English
  locales got mechanical English-string substitutions; a translator-review
  follow-up card will route those to native speakers to confirm whether
  "vault" should translate differently than "escrow" in each language.
- **Marketing site (`apps/www/`)** — 21 files mechanically renamed AND
  flagged for legal-counsel review before merge. Highest-priority review
  targets: `TermsPage.tsx` (Terms of Service), `Whitepaper.en.md`,
  `Security.tsx` (security narrative). Reviewer should treat each flagged
  file as a potential blocker — any phrasing that reads as a "regulatory
  description of fund-holding" needs human sign-off before merge.
- **Documentation (`docs/`)** — every FunctionalSpec, ADR, DesignsAndPlan,
  runbook, and historical doc that references escrow renamed. ADR-0008
  (renamed file `0008-per-user-vault-factory.md`) carries an explicit
  "2026-05-22 rename note" header callout explaining the historical "escrow"
  usage and why it changed. `docs/GLOSSARY.md` gains a "Vault (formerly
  Escrow)" entry pointing back at ADR-0008.
- **Cross-cutting docs** — top-level `AGENTS.md`, `CLAUDE.md`, `README.md`,
  `SECURITY.md`, `CHANGELOG.md` all updated.
- **Packages (`packages/contracts/`, `packages/lib/`)** — ABI JSON path
  rename (`EscrowFactoryFacet.json` → `VaultFactoryFacet.json`) plus barrel
  re-export updates. The authoritative ABI re-export (regenerating every
  JSON from the compiled facets) runs as a separate verification step at
  the end of the PR.
- **Sibling reference bot (`vaipakam-keeper-bot`)** — coordinated companion
  PR updates the bot's TS code to consume the renamed symbols and the
  regenerated ABIs. Both PRs land in lockstep so the public reference bot
  doesn't lag the monorepo.

What is intentionally NOT included:

- Historical release notes (`docs/ReleaseNotes/ReleaseNotes-*.md`) stay
  verbatim. They describe what shipped under the old name; rewriting them
  would be revisionism.
- Translator review of the 9 non-English `apps/defi` locales — separate
  follow-up card; the mechanical English-string substitution here is a
  starting point, not a finished translation.
- Brand collateral (logo / favicon / OG image alt text) — separate UX card
  if/when those reference escrow.

Closes #227.
