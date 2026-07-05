# Legacy `README §N` Citation Map

Older code comments (contract natspec), audit notes, and design docs cite
`README §N` from the historical root-README technical layout. The root
`README.md` is now the GitHub repo/profile landing page and carries no
technical sections, and the canonical technical whitepaper
([`apps/www/src/content/whitepaper/Whitepaper.en.md`](../apps/www/src/content/whitepaper/Whitepaper.en.md))
was rewritten in July 2026 (v4.0) with renumbered sections. Treat legacy
citations as references to the whitepaper sections and FunctionalSpecs
sources below.

| Legacy citation | Whitepaper v4.0 section | Supplementary source |
| --- | --- | --- |
| README §1 Introduction and motivation | §1 Introduction and Design Principles | — |
| README §2 System model, chain model, roles | §2 System Model | — |
| README §3 Diamond architecture, facets, vaults, position NFTs | §3 Architecture | `docs/adr/` |
| README §4 Asset classification and active-network liquidity | §4 Asset Classification and Liquidity | `docs/FunctionalSpecs/ProjectDetailsREADME.md` |
| README §5 Offer and loan lifecycle | §5 The Offer Book + §6 Loan Lifecycle | `docs/FunctionalSpecs/` workflow specs |
| README §6 Risk engine | §7 Risk Engine | `docs/DesignsAndPlans/ProgressiveRiskAccessDesign.md` |
| README §7 Liquidation and fallback settlement | §8 Liquidation and Default Settlement | liquidation design docs under `docs/DesignsAndPlans/` |
| README §8 Oracle stack | §9 Oracle Infrastructure | `docs/DesignsAndPlans/OraclePolicy.md` |
| README §9 NFT rental subsystem | §10 NFT Rental | — |
| README §10 Strategic flows | §11 Strategic Position Management | matching `docs/FunctionalSpecs/` workflow coverage |
| README §11 VPFI token and tokenomics | §12 VPFI Token and Tokenomics | `docs/FunctionalSpecs/TokenomicsTechSpec.md` |
| README §12 Reward system | §13 Interaction Rewards | `docs/FunctionalSpecs/TokenomicsTechSpec.md` §4/§4a |
| README §13 Cross-chain surface | §14 Cross-Chain Infrastructure | cross-chain design docs under `docs/DesignsAndPlans/` |
| README §14 MEV protection | §15 MEV Protection and Keeper Authorization | `docs/DesignsAndPlans/MEVProtection.md` |
| README §15 Governance and operations | §16 Governance, Security, and Operations | `docs/ops/` runbooks |
| README §16 Frontend as safety layer | §17 Product Interfaces | `docs/FunctionalSpecs/WebsiteReadme.md` |
| README §17 Verification and testing | §18 Verification and Testing | `docs/TestScopes/` |
| README §18 References | §19 References | — |

Whitepaper v3.0 (pre-rewrite) section numbers matched the legacy README
numbering above one-for-one, so a citation to "whitepaper §N" written
before July 2026 maps the same way.
