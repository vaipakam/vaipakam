# ADR-0002: Retail-deploy gating policy — sanctions ON; KYC and country-pair OFF

**Status:** Accepted
**Date:** 2026 (ratified per `CLAUDE.md` § "Retail-deploy policy"; ADR backfilled 2026-05-20)

## Context

DeFi protocols sit on a spectrum from "permissionless and pseudonymous"
(Uniswap, Aave) to "gated by off-chain compliance" (Maple, Goldfinch).
Each end of the spectrum optimises for different things:

- **Permissionless** — composability, censorship-resistance, broadest
  user reach, smallest centralised attack surface.
- **Gated** — institutional comfort, lower regulatory risk in specific
  jurisdictions, ability to enforce per-counterparty restrictions.

Vaipakam's design contemplated both audiences from the start. The
question was: does the *retail* protocol code carry the gates (turned
off but present), or do we maintain two separate forks?

A third dimension matters: **sanctions screening** is distinct from KYC
and country-pair gating. Sanctions screening protects the protocol from
OFAC-listed addresses (a real protocol-level threat); KYC and
country-pair gating protect against compliance failure modes specific
to identity-verifying products. Conflating the three would either
over-restrict the retail deploy or under-protect it.

## Decision

The retail Vaipakam deploy is **permissionless** with respect to KYC and
country-pair gating — both end-state, not "permissionless for now".
Specifically:

1. **`s.kycEnforcementEnabled = false` on every retail deploy.**
   `ProfileFacet.meetsKYCRequirement` and `isKYCVerified` short-circuit
   to `true` while the flag is `false`. The setter
   `AdminFacet.setKYCEnforcement(true)` exists but MUST NOT be called
   on a retail deploy.

2. **`LibVaipakam.canTradeBetween(...)` is pure-true on retail** —
   consults no storage. The gated variant
   (`LibVaipakam._canTradeBetweenStorageGated`) is a separate function
   used only by the industrial fork. The two helpers coexist on
   purpose so the industrial fork can flip pair-based restrictions on
   without a storage migration.

3. **Sanctions screening is REQUIRED.** On a retail deploy
   `ProfileFacet.setSanctionsOracle(<chainalysis-oracle>)` MUST be
   called once the oracle's address is known. Tier-1 entry points
   (`createOffer`, `acceptOffer`, escrow create, VPFI deposit /
   buy / withdraw, `triggerLiquidation`, EarlyWithdrawal, Preclose,
   Refinance, Claim) revert `SanctionedAddress(who)` for flagged
   callers. Tier-2 close-out paths (`repayLoan`, `markDefaulted`,
   time-based liquidation) stay open so the unflagged counterparty
   can be made whole.

4. **User-facing copy** — never mention KYC, identity verification,
   or country gating on the website / whitepaper / overview / user
   guide / marketing copy. The retail product is KYC-free and
   country-pair-free end-state, not "permissionless for now".
   Sanctions wording in user-facing copy stays MINIMAL — a single
   defensive bullet under "Prohibited use". Full sanctions wording
   surfaces ONLY in the in-app `SanctionsBanner` (shown to flagged
   wallets) and in contract revert messages.

5. **Industrial-fork branch** — a separate deploy on a separate fork
   that re-uses the same contracts with KYC + country-pair flipped on.
   Don't delete the gates from the source; just don't enable them on
   the retail deploy.

## Consequences

**Positive**

- Maximal composability and permissionlessness for retail users.
- Single Solidity codebase serves both retail and industrial
  audiences — no fork-drift, no two-codebase maintenance burden.
- Sanctions protection is operationally separable: the retail deploy
  carries a real protection (against OFAC exposure) without leaking
  KYC / identity language into user copy.

**Negative / accepted costs**

- KYC + country-pair code paths exist in the deployed bytecode but
  are not exercised — a non-zero amount of dead-ish code an
  auditor must reason about. Mitigated by the `_canTradeBetween
  StorageGated` helper being a clearly separate function from the
  pure-true retail path, with tests in `CountryPairGatedTest`.
- Sanctions screening introduces a third-party oracle dependency
  (Chainalysis or equivalent). If the oracle is misconfigured or
  fails, the protocol fails-open temporarily (returns `false` for
  every address — the intentional pre-`setSanctionsOracle` window).
- Operators must remember to call `setSanctionsOracle` on retail
  deploys. Documented in `CLAUDE.md` § "Retail-deploy policy".

**Risks the decision creates**

- Regulatory regime shifts could require KYC enforcement after the
  fact. Mitigation: the storage + setter already exists, so flipping
  on is a single transaction (with the usual admin /
  timelock routing).
- Misconfigured industrial fork (e.g. flipping `setKYCEnforcement`
  to `true` on a retail deploy by mistake) would break the retail
  user experience. Mitigation: the policy is checked into
  `CLAUDE.md`; PR-time review catches misconfig.

## Alternatives considered

**Alternative A — Mandatory KYC on retail**: Rejected. Would
contradict the protocol's permissionless positioning, narrow the
retail user base, and introduce off-chain compliance machinery the
retail deploy doesn't need.

**Alternative B — Maintain two separate Solidity codebases (retail +
industrial)**: Rejected. Doubles the contract maintenance and audit
burden. Code drift between forks would be a constant operational
overhead. The "gates present but off" approach lets the same
audited bytecode serve both audiences.

**Alternative C — Skip sanctions screening entirely**: Rejected.
Sanctions screening is structurally different from KYC: it's a
protocol-level defence against a specific, well-documented threat
class (OFAC-listed addresses), not an identity-verification
mechanism. Skipping it would unnecessarily expose the protocol to
takedown risk.

**Alternative D — Country-pair gating but no KYC**: Rejected.
Country-pair gating without identity verification is operationally
meaningless (wallets don't carry country attributes; gating would
have to rely on IP geolocation, which is bypassable + a frontend
concern, not a contract concern).

## References

- Policy: [`CLAUDE.md`](../../CLAUDE.md) § "Retail-deploy policy —
  sanctions ON; KYC / country-pair OFF"
- Source:
  [`contracts/src/facets/ProfileFacet.sol`](../../contracts/src/facets/ProfileFacet.sol),
  [`contracts/src/libraries/LibVaipakam.sol`](../../contracts/src/libraries/LibVaipakam.sol)
- Industrial-fork plan: [`docs/DesignsAndPlans/Roadmap.md`](../DesignsAndPlans/Roadmap.md)
- Tests: `contracts/test/CountryPairGatedTest.t.sol`
