## Thread — LayerZero → CCIP residual doc sweep (PR #__, Closes #236)

Completes the doc cleanup tail that #230 + #113 deferred. T-068 (PR
#46, merged 2026-05-18) migrated the cross-chain layer from LayerZero
to Chainlink CCIP, and #230 / #113 / #127 cleaned the load-bearing
TypeScript types + the SECURITY.md cross-chain rewrite. This PR
sweeps the remaining ~30 doc + i18n surfaces that still carried the
pre-T-068 LayerZero framing.

**Top-level docs** — `README.md` §0 stale-doc banner removed; §11
token-standard row rewritten to "Chainlink CCIP CCT" with the actual
TokenPool naming; §12.3-§12.4 cross-chain reward + UX paragraphs
rewritten to `VaipakamRewardMessenger` + the CCIP CCT bridge route;
§13 Cross-Chain Surface entirely rewritten — replaces the seven
`VPFIOFTAdapter` / `VPFIMirror` / `VPFIBuyAdapter` /
`VPFIBuyReceiver` / `VaipakamRewardOApp` subsections + the DVN
hardening + LZ pause-surface subsections with the post-T-068
architecture: `ICrossChainMessenger` + `CcipMessenger`, the
canonical `VPFIToken` + `LockReleaseTokenPool` + mirror
`VPFIMirrorToken` + `BurnMintTokenPool`, the `VpfiBuyAdapter` /
`VpfiBuyReceiver` flow, `VaipakamRewardMessenger`, the CCIP RMN +
`VpfiPoolRateGovernor` + `GuardianPausable` security model.

**Operator docs** — `contracts/RUNBOOK.md` rewritten across §1 env
vars, §2 deploy order (collapses to `DeployCrosschain.s.sol`), §4
peer wiring (now `ConfigureCcip.s.sol`), §5 (was DVN hardening — now
the RMN + per-lane rate-limit + GuardianPausable section), §9
monitoring (CCIP-aware checks), §10 incident runbook (CCIP contract
pause map), §11 go/no-go checklist. `docs/ops/DeploymentRunbook.md`,
`docs/ops/BNBTestnetDeploy.md`, and
`docs/DesignsAndPlans/OperatorNodeDeploymentDesign.md` get T-068
status banners with pointers at the CCIP-current scripts + ADR-0004;
their detailed bodies stay as historical reference pending the
structural CCIP rewrite of those long docs (tracked as a follow-up).
`docs/ops/GovernanceRunbook.md` + `docs/ops/AnalyticsLabelRegistration.md`
+ `docs/ops/AdminKeysAndPause.md` get surgical per-line updates
(contract-name substitutions + the pause-surface list rewritten).

**`ops/lz-watcher` README** — top-level deprecation banner notes the
Worker is deferred for decommission post-T-068 (its three checks
describe a LayerZero surface that no longer exists); points at
`contracts/RUNBOOK.md` §9 as the canonical post-T-068 monitoring
spec. The Worker stays deployed only as long as operators want to
keep its alerts live; the replacement CCIP-aware watcher is tracked
as a follow-up card.

**i18n micro-copy** — 20 locale JSON files (10 locales × 2 apps:
`apps/defi/src/i18n/locales/*.json` + `apps/www/src/i18n/locales/*.json`)
swept with conservative term substitutions: "LayerZero OFT" →
"Chainlink CCIP CCT", "via LayerZero" → "via Chainlink CCIP", "OFT
adapter" → "CCIP token pool", "VPFIBuyAdapter" / "VPFIBuyReceiver" →
post-T-068 casing (`VpfiBuyAdapter` / `VpfiBuyReceiver`). 126
substitutions total. The Japanese line at
`Overview.ja.md:278` needed a direct edit because Python's regex
word-boundary `\b` doesn't fire between Japanese letters and ASCII
letters (both are Unicode word characters). Native-speaker review
of the 9 non-en locales is the right backstop — pairs with
EC-004's "9 non-en locale translation" pass.

**Marketing copy + whitepaper** — `apps/www/src/content/whitepaper/Whitepaper.en.md`
§13 fully rewritten to mirror the README §13 rewrite. The 21 marketing
content files (whitepaper + overview + userguide + admin guide across
en + 9 non-en locales) all got the conservative substitution pass.
Native-speaker review still required on the non-en locales for
sentence-structure refinement — flagged for EC-004's translation pass
but the technical proper-noun terminology is now consistent across all
locales.

**Glossaries** — `apps/{defi,www}/src/i18n/glossary.ts`'s
`GLOSSARY_KEEP_VERBATIM` list extended with the post-T-068 contract
names (`CcipMessenger`, `VaipakamRewardMessenger`, `VpfiBuyAdapter`,
`VpfiBuyReceiver`, `VPFIMirrorToken`, `VpfiPoolRateGovernor`,
`LockReleaseTokenPool`, `BurnMintTokenPool`, `TokenAdminRegistry`,
`GuardianPausable`) + the CCIP-era short forms (`CCIP`, `RMN`,
`CCT`). The pre-T-068 LayerZero-era contract names (`VPFIOFTAdapter`,
`VPFIMirror`, `VPFIBuyAdapter`/`VPFIBuyReceiver`,
`VaipakamRewardOApp`) stay in the verbatim list — they still appear
in historical narrative (ADR-0004, the migration design doc, the
release notes from the migration period) and need to render
untranslated there.

**`CLAUDE.md`** — surgical fix on the "VPFIBuyAdapter — payment-token
mode by chain" section: section header updated to the post-T-068
casing (`VpfiBuyAdapter`); the references to
`DeployVPFIBuyAdapter.s.sol` and
`VPFIBuyAdapterPaymentTokenTest.t.sol` (neither file exists
post-T-068) point at `DeployCrosschain.s.sol` and
`contracts/test/VpfiBuyFlowTest.t.sol`.

**Intentionally NOT swept** — every doc that describes the
LayerZero → CCIP migration AS HISTORY: ADR-0004,
`docs/DesignsAndPlans/LayerZeroToChainlinkCcipMigration.md`, every
release-notes file from the migration period (2026-05-01 onward),
the `docs/OlderDocs/` archive, and the historical incident citations
in the references section of README and the whitepaper. The
migration story is load-bearing for understanding why the protocol
uses CCIP today, and the LayerZero references in those documents are
deliberate.

Closes #236 (the residual doc sweep tail of #230's deferred scope).
The structural rewrite of `docs/ops/DeploymentRunbook.md` and
`docs/DesignsAndPlans/OperatorNodeDeploymentDesign.md` from
LayerZero-shaped to CCIP-shaped — currently flagged with status
banners — is tracked as a follow-up card.
