# ADR-0009: BSL-1.1 on the protocol, MIT on the public reference keeper bot

**Status:** Accepted
**Date:** 2026 (original choice when LICENSE was added; ADR backfilled 2026-05-20)

## Context

Open-source licensing in DeFi is a real decision, not a default. Two
families dominate:

1. **Permissive (MIT / Apache 2.0 / ISC)** — anyone can copy, fork,
   modify, redistribute. Useful for libraries and reference
   implementations. Risk: a competitor can fork the protocol, brand
   it differently, and capture value without contributing back to
   the original team.
2. **Source-Available time-delayed-permissive (BSL-1.1 — the
   "Uniswap V3" model)** — source visible to anyone; commercial /
   production use restricted for a defined period (typically 2-4
   years); after the "change date", the license converts to a
   permissive one (typically GPL or MIT). This is the **DeFi-native
   answer** to the "fork-and-rebrand" problem.

Vaipakam has two artefacts with very different audiences:

- **The protocol contracts** (`contracts/src/`, the monorepo at
  `vaipakam/vaipakam`). The protocol IS the product. Permissive
  licensing here means a competitor can fork the entire protocol
  on day one and ship.
- **The public reference keeper bot** (the sibling repo
  `vaipakam/vaipakam-keeper-bot`). This is a *reference
  implementation* of an autonomous keeper that liquidates
  underwater loans + matches range offers. It exists for the
  ecosystem — anyone running a keeper bot should be able to use
  it as a starting point.

The two artefacts want opposite license shapes.

## Decision

**License the protocol monorepo (`vaipakam/vaipakam`) under
Business Source License 1.1 (BSL-1.1).** License the public
reference keeper bot (`vaipakam/vaipakam-keeper-bot`) under
**MIT**.

Specifically:

- `vaipakam/vaipakam/LICENSE` = BSL-1.1. (Change date and converted
  license to be set per the BSL standard at version bump time.)
- `vaipakam/vaipakam-keeper-bot/LICENSE` = MIT (`Copyright (c)
  2026 Vaipakam contributors`).

## Consequences

**Positive**

- BSL-1.1 on the protocol gives the team a defined window to build
  user trust + brand recognition before any fork can ship
  commercially. This is the same shape Uniswap V3 used; it's
  proven in DeFi.
- MIT on the keeper bot maximises ecosystem adoption — anyone
  running a Vaipakam-aware keeper can fork the reference bot
  without licensing friction. More keepers = more protocol
  liquidation health.
- The asymmetry intentionally reflects the role each artefact
  plays. Protected vs. ecosystem-grow.

**Negative / accepted costs**

- BSL-1.1 is more complex to read than MIT. Contributors need to
  understand the "change date" + "additional use grant" mechanics.
  Mitigated by the in-LICENSE text being the canonical BSL-1.1
  template (familiar to anyone who has read the Uniswap V3
  license).
- "Source-available" is not the same as "open source" in the OSI
  sense. Some ecosystem partners and OSS-purist contributors will
  object on principle. Accepted — this is a known trade-off of
  the BSL-1.1 family.
- The change date and converted license must be set at LICENSE
  authoring time and respected at the dated transition. If we
  forget the transition, the license remains BSL-1.1 — minor
  follow-up risk.

**Risks the decision creates**

- A future need to relicense (e.g. to a more permissive license
  before the change date) requires re-papering. Mitigated by:
  BSL-1.1 allows the licensor to grant additional permissions
  for specific use cases without changing the base license.
- The MIT-licensed keeper bot relying on a BSL-1.1 protocol is
  legally fine (MIT-licensed software can link / interact with
  source-available software) but worth noting for clarity.

## Alternatives considered

**Alternative A — Permissive on both repos (MIT or Apache 2.0
across the board)**: Rejected for the fork-and-rebrand reason.
Permissive licensing on a DeFi protocol surrenders the protective
window before brand / trust accrues.

**Alternative B — BSL-1.1 on both repos**: Rejected. The keeper
bot is a reference for ecosystem participants; the friction of
BSL would discourage exactly the third-party keeper adoption that
the protocol benefits from.

**Alternative C — Custom commercial license**: Rejected. Custom
licenses are unfamiliar to potential users, force lawyers into
every adoption decision, and don't carry the standard interpretive
case-law that BSL-1.1 has accumulated.

**Alternative D — Proprietary / closed source on the protocol**:
Rejected. Closed-source contracts on-chain are a contradiction
(deployed bytecode is observable); the value of *source*
visibility for trust + audit + reproducibility is high.

## References

- Protocol license: [`LICENSE`](../../LICENSE) (BSL-1.1)
- Keeper-bot license: `../vaipakam-keeper-bot/LICENSE` (MIT)
- Comparable choice: Uniswap V3 (BSL-1.1, converted to GPL-2.0
  in 2023)
- Related: ADR-0001 (Diamond pattern — the entity the BSL protects)
