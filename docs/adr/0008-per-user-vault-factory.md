# ADR-0008: Per-user UUPS vault via factory, not a commingled vault

**Status:** Accepted
**Date:** 2025 (original choice; ADR backfilled 2026-05-20)

> **2026-05-22 rename note (#227):** This ADR originally used the term
> "escrow" throughout — the factory was `EscrowFactoryFacet`, the
> implementation was `VaipakamEscrowImplementation`, etc. Pre-mainnet,
> every Escrow* identifier was renamed to Vault* (file content + path).
> Reason: "escrow" carries regulated-fiduciary-holder connotations under
> several jurisdictions that didn't fit a permissionless DeFi protocol;
> "vault" is the established DeFi-native term (Yearn / Curve / Morpho /
> Aave all use it). The on-chain semantics described below are unchanged
> — the rename is purely a naming clarification. Storage layouts shifted
> via the ERC-7201 namespace change `vaipakam.userEscrow*` →
> `vaipakam.userVault*`, but pre-mainnet there were no deposits, so the
> shift is a no-op for users. See `docs/GLOSSARY.md` entry "Vault
> (formerly Escrow)" for the user-facing summary.

## Context

Protocol-held user assets need somewhere to live. The two architectural
families that dominate DeFi are:

1. **Commingled vault** — one (or a few) contracts hold ALL users'
   collateral pooled together. Accounting tracks each user's claim
   via internal balance entries. Examples: Compound, Aave's main
   pool.
2. **Per-user contract** — each user gets their own contract (often
   a proxy) holding their own collateral. Examples: dYdX V4
   subaccounts, some restaking primitives.

The commingled approach is simpler — fewer contracts, lower per-user
gas overhead at deposit time, easier supply-side accounting. The
per-user approach is more expensive at deposit time but offers
**physical asset isolation**: a bug in one user's transactions cannot
drain another user's collateral, because the bug can't reach the
other user's storage.

Vaipakam's risk surface argues for isolation:

- **ERC721 / ERC1155 NFT vault** — a buggy or hostile NFT contract
  could (on transfer) attack the receiver. In a commingled vault,
  the receiver IS the vault holding everyone's collateral. In a
  per-user contract, the receiver is one user's vault holding only
  their own collateral.
- **Per-asset hooks** (ERC1363 / ERC777 transfer hooks) — same
  attack surface. A hook running inside a per-user vault can only
  touch that user's storage.
- **Custom vault logic for NFT rental** (per-day deductions,
  ERC4907 user-rights handling) — a per-user contract can carry
  user-specific state without bloating the shared vault.

The cost is upgrade machinery: per-user contracts need to be
upgradeable in lock-step (you can't release a fix to "the vault"
if each user has their own copy of the implementation).

## Decision

Adopt a **per-user UUPS vault via factory**.

- **`VaipakamVaultImplementation.sol`** — the UUPS-upgradeable
  implementation. Holds the per-user logic (collateral receive,
  release, NFT rental hooks, position state).
- **`VaultFactoryFacet`** — a Diamond facet that lazily deploys
  one `ERC1967Proxy` per user the first time the user interacts
  with the protocol. The proxy points at the shared implementation
  contract. The mapping `user → proxy` is stored on the Diamond.
- **UUPS upgrade path** — when the implementation needs to change,
  one `_authorizeUpgrade`-gated call upgrades the implementation
  address. Every per-user proxy reads the new implementation on
  the next call (no per-user migration).
- **Cross-facet access** — facets that need to interact with a
  user's vault (`OfferAcceptFacet`, `RepayFacet`, etc.) call
  through the user's proxy via `address(this).call(...)` or via
  `IERC20.safeTransferFrom` (when ERC20).

## Consequences

**Positive**

- **Physical asset isolation**. A bug, malicious token, or
  malicious NFT touching one user's vault cannot reach another
  user's collateral — there's no shared storage to corrupt.
- **Per-user customisation possible** without polluting a shared
  vault — NFT rental's per-day-deduction state, ERC4907 user-
  rights handling, the future partial-fill residual posting (#102)
  all carry per-user state without inflating a global accounting
  surface.
- **Upgrade is lock-step**: one UUPS upgrade transaction switches
  every user's vault to the new logic atomically. No per-user
  migration; no "half the users on v1, half on v2" state.

**Negative / accepted costs**

- **Per-user deploy cost** — each user pays ~80K gas (proxy
  deploy) on their first protocol interaction. Acceptable; the
  ones who care most about gas can subsidise via the keeper /
  matcher relay.
- **Storage map `user → proxy`** lives on the Diamond. Every
  facet that touches user funds has to resolve the proxy
  address first. Boilerplate.
- **`_authorizeUpgrade` is a high-impact admin function** — it
  upgrades the implementation behind every per-user proxy
  simultaneously. Mitigated by: admin → multisig → timelock at
  mainnet; UUPS pattern is the standard OpenZeppelin shape
  (well-audited upstream); per-user proxies have no separate
  upgrade override (so they can't be exploited individually).

**Risks the decision creates**

- A bug in `VaipakamVaultImplementation` affects every user
  simultaneously (no isolation at the *logic* layer; only at the
  *state* layer). Mitigation: this is true of any shared-logic
  pattern; mitigated by the upgrade path (UUPS) and the standard
  test + audit coverage that the implementation gets.
- The per-user proxy address is a non-trivial-to-derive
  identifier. Cross-protocol integrations have to query the
  factory to get a user's vault address. Documented; not a
  practical issue at protocol scale.

## Alternatives considered

**Alternative A — Commingled vault**: Rejected for the
hook-attack-surface and per-user-state reasons in Context. The
NFT-rental subsystem alone would force a lot of per-user
accounting that fits poorly into a global vault model.

**Alternative B — `CREATE2`-deterministic addresses without proxy
deployment** (the user's vault address is computable but no proxy
exists until needed): Considered. Rejected because the cross-facet
call pattern (`address(this).call(...)` into the vault) needs the
vault to actually exist as a contract — `CREATE2` predicting an
address that hasn't been deployed yet doesn't give us callable
code.

**Alternative C — One vault contract per user, NON-upgradeable**:
Rejected. The protocol expects to evolve. A non-upgradeable
per-user contract would mean per-user migration if vault logic
ever changed.

**Alternative D — Transparent proxy (vs UUPS) per user**: The
upgrade-admin lives in a separate ProxyAdmin contract. Rejected
because UUPS keeps the upgrade logic in the implementation
(simpler reasoning; no separate ProxyAdmin to secure) and the
gas cost on the hot path is lower (one fewer SLOAD per call).

## References

- Source:
  [`contracts/src/VaipakamVaultImplementation.sol`](../../contracts/src/VaipakamVaultImplementation.sol),
  [`contracts/src/facets/VaultFactoryFacet.sol`](../../contracts/src/facets/VaultFactoryFacet.sol)
- Spec: [`apps/www/src/content/whitepaper/Whitepaper.en.md`](../../apps/www/src/content/whitepaper/Whitepaper.en.md) §6 (Vaipakam Vaults)
- Related: ADR-0001 (Diamond pattern — vault factory uses a Diamond
  facet, but the per-user proxies are separate UUPS contracts)
