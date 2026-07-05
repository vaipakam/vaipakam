# Vaipakam

**Decentralized peer-to-peer lending, borrowing, and NFT rental — where counterparties set their own terms.**

*Vaipakam (வைப்பகம்) is a Tamil word for "bank / place of deposit."*

[![CI](https://github.com/vaipakam/vaipakam/actions/workflows/ci.yml/badge.svg)](https://github.com/vaipakam/vaipakam/actions/workflows/ci.yml)
[![License: BUSL-1.1](https://img.shields.io/badge/License-BUSL--1.1-blue.svg)](LICENSE)
[![Solidity](https://img.shields.io/badge/Solidity-0.8.29-363636.svg)](contracts/)

Vaipakam is a non-custodial DeFi protocol where lenders and borrowers negotiate directly instead of borrowing from a pooled money market. Each user's assets live in their own isolated vault, every position is a transferable NFT, and safety-critical actions (liquidation, default) are permissionless. The protocol supports ERC-20 lending against ERC-20 or NFT collateral, and true NFT *rental* — the renter receives usage rights while the NFT never leaves vault custody.

> **Status (July 2026):** pre-live. Deployments are testnet/local only. A third-party security audit is required before any mainnet launch.

## Why peer-to-peer instead of a pool?

- **Your terms, not the pool's curve** — rate, duration, collateral requirements, and interest mode are negotiated per loan, so exotic and long-tail assets can be priced by the two parties who actually hold the risk.
- **No shared-pool contagion** — there is no commingled liquidity to drain; a bad loan affects its two parties, not every depositor.
- **Positions are NFTs** — lender-side and borrower-side rights follow on-chain position NFTs, so they are inspectable, and transferable where protocol rules allow.
- **Illiquid assets are first-class** — assets without deep oracle-verified liquidity can still be used with explicit dual consent and in-kind settlement, instead of being silently mispriced.
- **Safety is permissionless** — anyone may trigger liquidation or default once protocol conditions are met; user protection never depends on a privileged bot.

## Architecture at a glance

```
                        ┌──────────────────────────────┐
 users / keepers ──────▶│  VaipakamDiamond (EIP-2535)  │──▶ 60+ facets: offers, loans,
                        │  single entry, shared storage │    risk, liquidation, oracle,
                        └──────────────┬───────────────┘    rentals, VPFI, rewards…
                                       │
                 ┌─────────────────────┼──────────────────────┐
                 ▼                     ▼                      ▼
        per-user UUPS vaults    position NFTs         Chainlink price feeds
        (isolated custody)      (claim rights)        + CCIP cross-chain layer
```

- **Contracts** — Solidity 0.8.29, EIP-2535 Diamond, per-user UUPS vault proxies, Chainlink oracles, Chainlink CCIP for the cross-chain VPFI token and reward mesh. Built and tested with Foundry (unit + fuzz + invariant + deploy-sanity suites).
- **Off-chain** — three Cloudflare Workers (`keeper`, `indexer`, `agent`) for health-factor watching, event indexing, and notifications. The protocol functions without them; they add convenience, not authority.
- **Frontends** — a public website (docs, analytics, NFT verifier) and a wallet-connected app. The frontend is a safety layer, not a gatekeeper: everything it does can be done against the contracts directly.

## Repository map

| Path | What lives there |
| --- | --- |
| [`contracts/`](contracts/) | The protocol: Diamond, facets, libraries, vaults, cross-chain, Foundry tests & deploy scripts |
| [`apps/www`](apps/www/) | Public website — docs, technical whitepaper, analytics |
| [`apps/defi`](apps/defi/) | Wallet-connected app — offers, loans, claims, vaults |
| [`apps/keeper`](apps/keeper/) / [`apps/indexer`](apps/indexer/) / [`apps/agent`](apps/agent/) | Cloudflare Workers — watching, indexing, notifications |
| [`packages/`](packages/) | Shared TypeScript packages — ABIs, deployments, UI, client libs |
| [`ops/`](ops/) | Operational watchers, archives, and tooling |
| [`docs/`](docs/) | Functional specs, design docs, ADRs, release notes, audit findings |

## Documentation

- **[Technical Whitepaper](apps/www/src/content/whitepaper/Whitepaper.en.md)** — the canonical protocol specification, rendered at [vaipakam.com](https://vaipakam.com)
- **[Functional Specs](docs/FunctionalSpecs/)** — the code-independent intended-behaviour specification (the test oracle)
- **[Design docs & ADRs](docs/DesignsAndPlans/)** — architecture decisions and design exploration
- **[Release notes](docs/ReleaseNotes/)** — the shipped-work narrative
- **[Project board](https://github.com/users/vaipakam/projects/1)** — live tracker for in-flight and queued work

## Development

Contracts (from `contracts/`):

```bash
forge build                       # compile (Solidity 0.8.29, viaIR)
forge test --match-path test/RepayFacetTest.t.sol   # targeted tests
bash script/run-regression.sh     # full local regression
```

Frontends and Workers (pnpm workspace, from the repo root):

```bash
pnpm install
pnpm --filter @vaipakam/www dev       # public website
pnpm --filter @vaipakam/defi dev      # connected app
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions and [AGENTS.md](AGENTS.md) for the AI-assisted review workflow used on this repo.

## Security

Security-sensitive reports go through the **private channels in [SECURITY.md](SECURITY.md)** — never public GitHub issues. The protocol's incident procedures live in [docs/ops/IncidentRunbook.md](docs/ops/IncidentRunbook.md). Internal adversarial security reviews are recorded under [docs/FindingsAndFixes/](docs/FindingsAndFixes/); a third-party audit precedes any mainnet deployment.

## License

[Business Source License 1.1](LICENSE) — free for non-production use; converts to MIT per the license's Change Date terms.
