# Vaipakam Terms of Service

**Version:** 1
**Effective:** 2026-04-24

**What this document is.** These Terms govern your use of the Vaipakam
protocol. Vaipakam is a non-custodial, on-chain peer-to-peer lending
and NFT-rental protocol. When you connect your wallet and interact
with the app at vaipakam.com (or any other Vaipakam-branded frontend),
you are doing so under these Terms.

**Not a service provider.** Vaipakam is not a custodian, broker, bank,
exchange, or financial adviser. The smart contracts run on public
blockchains. You interact with them directly via your own wallet. The
frontend at vaipakam.com is a convenience layer — the same smart
contracts are reachable from any wallet and any other UI.

**No advice.** Nothing on the site or in this document is financial,
legal, tax, or investment advice. You are responsible for evaluating
the risks of every position you take and for your own regulatory
compliance in whatever jurisdiction you reside in.

**Risk of total loss.** You can lose every asset you commit to a loan
position, a rental position, or a VPFI balance. Smart contract bugs,
oracle manipulation, liquidation cascades, bridge failures, chain
reorganisations, and wallet compromises are all scenarios in which
the value of an on-chain position can go to zero. Participation in
Vaipakam implies you accept these risks.

**Prohibited use.** You may not use Vaipakam:

- from a jurisdiction where accessing a non-custodial DeFi protocol
  requires registration you haven't completed, or where participation
  is prohibited outright;
- if your wallet address is listed under any sanctions programme in
  force in the United States, European Union, or United Kingdom;
- to launder funds, finance terrorism, or otherwise violate any
  applicable law;
- to attack, exploit, or probe the protocol or its infrastructure.

**Protocol changes.** The protocol's parameters — fees, liquidation
thresholds, reward rates, supported assets — can be changed by
governance. Changes that could affect an active position give users a
public notice window through the Timelock mechanism (see
`GovernanceRunbook.md` for the exact delays). Your active positions
continue to follow the parameters in force when you opened them,
unless explicitly stated otherwise for a specific change.

**Keeper delegation.** Vaipakam supports delegating "keeper" actions
on your behalf to whitelisted addresses. A keeper you authorize can
execute non-claim, role-scoped actions on your loans (refinance,
repay, add-collateral, preclose). Keepers CANNOT claim funds or
transfer your position NFT. You can enable or disable keeper access
per-loan or per-offer at any time while the position is active. You
remain responsible for any action a keeper you authorized takes.

**Your wallet is your signature.** The wallet address you connect IS
your identity on the protocol. Your acceptance of these Terms is a
cryptographic record anchored to that wallet, time-stamped by the
on-chain block number. If you lose access to the wallet, you lose
access to every position it holds — the Vaipakam team cannot recover
any asset on your behalf.

**Changes to these Terms.** Governance can publish a new version of
these Terms. When it does, the on-chain `currentTosVersion` +
content-hash pair increments, and users must sign a new acceptance
from their wallet before the frontend re-opens the app to them.
Failure to re-sign does not affect your on-chain positions — the
Terms gate is only a frontend gate, not a protocol gate.

**No warranty.** The protocol and the frontend are provided "as is"
without any warranty of fitness, merchantability, or absence of bugs.
Every participant — including the protocol's own developers and
governance signers — uses Vaipakam at their own risk.

**Limitation of liability.** To the maximum extent permitted by
applicable law, Vaipakam and its contributors are not liable for any
loss arising from your use of the protocol or frontend.

**Governing convention.** These Terms are deliberately short and
written in plain English. They do not substitute for professional
legal advice. If your jurisdiction imposes specific disclosures on
DeFi usage, you are responsible for obtaining them.

**Contact.** Security reports: via the bug bounty link in the
footer. Non-security questions: via the public Discord link.
