# Analytics-Firm Label Registration — Post-Deploy Runbook

Status: **Operational checklist for post-mainnet-launch.**

Audience: release engineer + compliance lead, run after each new
chain deploy where Vaipakam is operating with real value.

Companion docs:
- [`EscrowStuckRecoveryDesign.md`](../DesignsAndPlans/EscrowStuckRecoveryDesign.md)
  — explains why the labeling matters in the threat model.
- [`DeploymentRunbook.md`](DeploymentRunbook.md) — the broader deploy
  procedure this fits inside.

---

## 1. Why labeling matters

Vaipakam uses a **Vaipakam Vault proxy** pattern. Every user that
interacts with the protocol gets their own ERC1967 proxy deployed by
`EscrowFactoryFacet.getOrCreateUserEscrow`. The proxy delegates to a
shared `VaipakamEscrowImplementation`.

Two implications:

1. **Per-user proxy addresses are NOT pre-known.** They're created on
   first interaction (CREATE-deployed; address deterministic from
   `nonce` of the Diamond at the time of deployment).
2. **External taint-tracking tools** (Chainalysis, TRM Labs, Elliptic,
   block explorers) treat these addresses as anonymous EOAs unless
   they're labeled.

The recovery design includes a **proof-of-non-spend** property: the
counter math (`protocolTrackedEscrowBalance`) guarantees that
unsolicited dust never participates in protocol-side outflows. But
this property is invisible to a generic taint-tracking tool — it has
no idea the address belongs to Vaipakam. Without labels, an honest
user whose vault received tainted dust may have their CEX deposits
flagged, their addresses scored down, and their protocol position
mistakenly labeled "exposed to sanctioned origin."

**Labels solve this.** Once an analytics firm labels the vault
proxy pattern as "Vaipakam Vaults", their tooling can apply
protocol-aware accounting rules — most importantly, recognize that
unsolicited dust sitting in the vault without an outflow is "stuck" not
"laundered."

This runbook walks through registration with each major firm.

---

## 2. What there's no API for: per-instance Etherscan tagging

**Etherscan does not expose a public API for per-address name tags.**
Public name tags are human-curated by Etherscan staff. There is a
private-tag API for personal-account use (managed via the Etherscan
account portal) but that's only visible to the logged-in user and
doesn't propagate to public viewers.

**What works automatically instead — ERC1967 proxy detection.** When
Etherscan loads any contract page, it reads the EIP-1967
implementation slot
(`bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)`)
to detect proxy contracts. If the slot is set, Etherscan shows on the
proxy page:

> **This contract is a Proxy.** Implementation: `0xImpl...address`
> [Vaipakam Vault Implementation]

If the **implementation contract** is tagged, every Vaipakam Vault
proxy automatically displays the relationship. Same mechanism Aave /
Compound / Uniswap rely on for their proxy-based deployments.

So our Etherscan strategy is:
- **One** public-tag submission for the `VaipakamEscrowImplementation`
- **One** public-tag submission for the `VaipakamDiamond`
- Verified contract source for both
- Rest is automatic — every spawned proxy gets the impl link visible
  on its page

For analytics firms (Chainalysis / TRM / Elliptic), pattern
registration achieves automatic per-instance labeling — see §5 below.

---

## 3. Pre-flight checklist (before submission)

Complete these BEFORE reaching out to any firm:

- [ ] All contracts deployed on the target chain.
- [ ] Diamond + implementation source verified on Etherscan (or
      Blockscout / equivalent for non-Etherscan chains). Use the
      project's standard verification flow:
      `forge verify-contract --chain <chain> <address> <contract>`.
- [ ] Verified on Sourcify (`sourcify.dev/server/verify`) — many
      tools fall back to Sourcify when Etherscan verification isn't
      available.
- [ ] Public docs page live at e.g. `vaipakam.com/protocol/escrow.md`
      explaining: per-user proxy pattern; counter-based accounting;
      proof-of-non-spend property; recovery flow semantics.
- [ ] Sample of 5–10 already-deployed vault proxy addresses (the
      analytics firms ask for examples to confirm the pattern).
- [ ] Factory function signature documented:
      `EscrowFactoryFacet.getOrCreateUserEscrow(address user) external returns (address proxy)`
      and the deterministic deployment salt / pattern.

---

## 4. Etherscan public name tags

**Submission URL**: [`etherscan.io/contactus`](https://etherscan.io/contactus)
→ "Update Address Information" → "Update Name Tag / Label".

For mainnet (Ethereum) and each Etherscan-family explorer
(BscScan, Polygonscan, Arbiscan, etc.) where we deploy, repeat:

### 4a. Diamond contract submission

```
Address:        0xDiamond...
Suggested Name: Vaipakam: Diamond
Description:    The main entry point for the Vaipakam P2P lending
                protocol (EIP-2535 Diamond Standard). All facet
                routing and shared storage. Public protocol docs:
                https://vaipakam.com/protocol/
```

### 4b. Vault implementation submission

```
Address:        0xImpl...
Suggested Name: Vaipakam Vaults
Description:    Shared UUPS implementation that every Vaipakam
                per-user vault proxy delegates to. Each user gets
                their own ERC1967 proxy pointing at this address.
                Per-user proxies handle ERC-20 / ERC-721 / ERC-1155
                custody for that user's loans, offers, and VPFI
                staking. Public protocol docs:
                https://vaipakam.com/protocol/vaults.md
```

This name is intentional. When a curious user lands on a per-user
vault proxy on Etherscan, they see "**This contract is a Proxy.**
Implementation: `0xImpl…` [Vaipakam Vaults]" — the brand surface
without a redundant "Implementation Implementation" suffix. The
implementation page itself shows just "Vaipakam Vaults" as the
contract title.

### 4c. Optional — Vaipakam token contracts

If the chain has VPFI / VPFIOFTAdapter / etc. deployed, submit those
too with appropriate names. Skip on mirror chains where only a subset
of the token plumbing exists.

### Expected timeline

Etherscan typically processes name-tag requests within 2–7 business
days. Re-submit if no response after 10 days. Proof of ownership of
the contract address (e.g. via signing a message with the deployer
account) may be requested.

---

## 5. Chainalysis label registration

**Submission**: email `business@chainalysis.com` (or use the KYT
customer portal if we have an existing relationship — at scale, a
data-team contact is appropriate).

### 5a. Email template

```
Subject: Vaipakam — per-user escrow proxy label registration

Hi Chainalysis Data Team,

We're requesting a protocol label for Vaipakam, a P2P lending
protocol with a per-user escrow proxy architecture. We'd like the
escrow proxies to be classifiable in your address-classification
database so taint-tracking tools (Reactor / KYT / SDK) can apply
protocol-aware accounting.

Protocol summary:
- EIP-2535 Diamond contract: 0x[diamond_address] (chain: <chain>)
- Per-user escrows are ERC1967 proxies deployed by
  `EscrowFactoryFacet.getOrCreateUserEscrow(user)` and delegate to
  a shared implementation at 0x[impl_address].
- Each escrow custodies one user's collateral / lending tokens /
  staked VPFI. No commingling.
- The protocol maintains a per-(user, token) `protocolTrackedEscrowBalance`
  counter that is incremented only on protocol-mediated deposits
  and decremented only on protocol-mediated withdrawals. The
  counter is the load-bearing accounting boundary: protocol
  outflows never exceed it. ERC-20 tokens that arrive directly
  (outside the protocol flow) cannot be moved out by protocol
  operations and are bounded by the counter as the "unsolicited"
  delta.

We'd like the proxy address pattern labeled
"Vaipakam: Per-User Escrow". This would let your indexers
recognize that:

  1. Tainted dust arriving at one of these proxies is bounded —
     the protocol-tracked balance never includes it.
  2. The user's protocol-side outflows trace back through the
     Diamond, not through the dust path.

Sample escrow proxy addresses (verifiable via the factory):
- 0x[sample_1]
- 0x[sample_2]
- 0x[sample_3]
- 0x[sample_4]
- 0x[sample_5]

Public documentation:
- Protocol overview: https://vaipakam.com/protocol/
- Escrow architecture: https://vaipakam.com/protocol/escrow.md
- Recovery design (explaining the proof-of-non-spend property):
  https://github.com/[org]/vaipakam/blob/main/docs/DesignsAndPlans/EscrowStuckRecoveryDesign.md

Verified source on Etherscan:
- Diamond: https://etherscan.io/address/0x[diamond_address]#code
- Implementation:
  https://etherscan.io/address/0x[impl_address]#code

Happy to provide additional info or jump on a call to walk through
the architecture.

Thanks,
[Your name], [role]
[org] / vaipakam.com
```

### 5b. Expected timeline

Chainalysis data-team submissions typically take 2–4 weeks. They may
ask for additional examples or a technical call.

### 5c. What it gets us

Once registered:
- Reactor (their forensic tool) shows "Vaipakam: Vaipakam Vaults"
  on every address they identify as matching the pattern.
- KYT (their compliance tool used by exchanges and on/off-ramps)
  applies protocol-aware risk scoring — tainted dust sitting in our
  vault doesn't propagate taint to the user's other addresses.
- Their public sanctions oracle is unaffected (it's only sanctions
  classifications); but the broader risk-scoring API used by CEXs is.

---

## 6. TRM Labs label registration

**Submission**: [`trmlabs.com/contact`](https://trmlabs.com/contact)
→ "Data team / address classification".

Email template substantially similar to Chainalysis (§5a). TRM's
ingestion process is parallel; submit independently.

TRM's free sanctions oracle exists but their main commercial product
(Phoenix risk scoring) is what matters for CEX-side compliance. Same
labeling rationale.

---

## 7. Elliptic label registration

**Submission**: [`elliptic.co/contact`](https://elliptic.co/contact)
→ compliance team.

Same email template. Their Navigator product applies protocol-aware
rules once labels exist.

---

## 8. Arkham Intelligence

Arkham combines automatic on-chain pattern detection with community-
submitted labels. They often label protocols automatically once they
detect factory-deployment patterns and decode the calldata.

**Manual submission**: log in to `arkhamintelligence.com`, navigate
to the contract address, click "Suggest Label", provide name and
description. Arkham reviews quickly (often hours).

For factory-style deployment, request a "label all addresses created
by 0x[factory_address] with name 'Vaipakam: Vaipakam Vaults'" — this
is a common Arkham operation.

---

## 9. DeBank / Zapper / Zerion (portfolio aggregators)

Each maintains a protocol catalogue. Apply via:
- DeBank: [`debank.com/lounge` → Submit Project](https://debank.com/lounge)
- Zapper: [`zapper.xyz/dapp/listing`](https://zapper.xyz/dapp/listing)
- Zerion: [`zerion.io/contact`](https://zerion.io/contact)

What it gets us: user portfolios on these dashboards display Vaipakam
positions correctly (not as "unknown contract interaction"). Helps UX
for retail users who track holdings across protocols.

---

## 10. Open-source registries

These feed many wallets and explorers:

- **MyEtherWallet ethereum-lists**: PR to
  [`github.com/MyEtherWallet/ethereum-lists`](https://github.com/MyEtherWallet/ethereum-lists).
  Add Diamond + implementation entries.
- **Trusted Token List repos**: e.g. for VPFI token, get listed in
  the major token lists (Uniswap, 1inch, CoinGecko).
- **Sourcify**: `sourcify.dev/server/verify` — verify all our
  contracts. Many tools fall back to Sourcify metadata.

PR-based; no API auth required.

---

## 11. Frontend communication

Once labels start propagating (typically 2–6 weeks total across
firms), update:

- The Asset Viewer warning copy may be slightly softened (still warn,
  but reference the labeled-protocol status in case of disputes):
  > Tokens managed by the Vaipakam protocol are shown here.
  > Vaipakam vault addresses are registered with major
  > blockchain analytics providers; if you encounter compliance
  > friction at an external service, contact us with your vault
  > address.

- The Advanced User Guide stuck-recovery section should mention the
  proof-of-non-spend property and link to the analytics firms'
  public documentation of our protocol if any exists.

---

## 12. Per-chain checklist

For each new chain we deploy on, complete in order:

| Step | Action | Owner | Time-box |
|---|---|---|---|
| 1 | Verify all contracts on chain explorer + Sourcify | Release eng | Day 1 |
| 2 | Submit Etherscan-family public name tags (Diamond + Implementation) | Release eng | Day 1 |
| 3 | Email Chainalysis data team | Compliance lead | Day 2 |
| 4 | Email TRM Labs | Compliance lead | Day 2 |
| 5 | Email Elliptic | Compliance lead | Day 2 |
| 6 | Submit Arkham label | Release eng | Day 3 |
| 7 | Apply to DeBank / Zapper / Zerion | Marketing / partnerships | Week 1 |
| 8 | PR to MEW ethereum-lists | Release eng | Week 1 |
| 9 | Update frontend copy once labels confirmed | Frontend eng | When confirmed |

Track each chain's progress in
`docs/internal/AnalyticsLabelStatus.md` (create on first use). Each
row: chain, firm, submission date, confirmation date, label string,
notes.

---

## 13. References

- [`EscrowStuckRecoveryDesign.md`](../DesignsAndPlans/EscrowStuckRecoveryDesign.md)
  — explains the protocol-aware accounting that labels make
  externally-visible.
- [EIP-1967 proxy slot spec](https://eips.ethereum.org/EIPS/eip-1967)
  — the slot layout Etherscan reads to auto-detect proxy
  relationships.
- Chainalysis: [`chainalysis.com/integrations`](https://www.chainalysis.com/integrations)
  — overview of their classification system.
- TRM Labs: [`trmlabs.com/products`](https://www.trmlabs.com/products)
  — Phoenix and KYT product lines.
