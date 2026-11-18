# Vaipakam Terms of Service

**Version:** 3
**Effective:** 2026-11-18

## What this document is

These Terms govern your use of the Vaipakam
protocol. Vaipakam is a non-custodial, on-chain peer-to-peer lending
and NFT-rental protocol. When you connect your wallet and interact
with the app at vaipakam.com (or any other Vaipakam-branded frontend),
you are doing so under these Terms.

## Not a service provider

Vaipakam is not a custodian, broker, bank,
exchange, adviser or fiduciary. The smart contracts run on public
blockchains by themselves, and you interact with them directly from
your own wallet. The site and the app at vaipakam.com are an
interface to those contracts, not a party to any loan or rental:
every loan and rental is between its own participants. No one holds
your assets for you; they stay in your wallet or in your own vault,
which only the contracts and you can move. The same contracts are
reachable from any wallet and any other interface.

## No advice

Nothing on the site or in this document is financial,
legal, tax, or investment advice. You are responsible for evaluating
the risks of every position you take and for your own regulatory
compliance in whatever jurisdiction you reside in.

## Key risks

Read these before you use Vaipakam. The app shows the same list before
you accept these Terms.

- You can lose some or all of your funds. Nothing here is insured or
  guaranteed, and no one can reverse a transaction.
- If you lend: when a borrower does not repay, their collateral is
  sold to repay you. If it cannot be sold, you receive the collateral
  itself, in part or in full, and it may be worth less than you are
  owed.
- If you borrow: your collateral can be sold if its value falls or you
  repay late, and you may lose it.
- The software, price feeds, tokens and networks this platform relies
  on can fail or be attacked. These risks come with every blockchain
  system.
- You alone control your wallet. If you lose access, no one can
  recover it.
- This is not financial advice. Decide for yourself, and only use what
  you can afford to lose.

Also: a token meant to hold a steady value, such as a dollar token,
can lose that value; a price feed can be wrong or late, and a sale or
a limit can act on that price; rules and taxes differ by country and
can change, and tax on what you do here is your own responsibility;
and wallets, networks, swap routes and cross-chain transfers are run
by others, outside this platform's control. Every loan and rental
review in the app also states what happens to your side of that loan
if things go wrong.

## Prohibited use

You may not use Vaipakam:

- if you are under 18, or under the age of majority where you live;
- from a jurisdiction where accessing a non-custodial DeFi protocol
  requires registration you haven't completed, or where participation
  is prohibited outright;
- if your wallet address is listed under any sanctions programme in
  force in the United States, European Union, or United Kingdom;
- while hiding your location to get round any of the above;
- to launder funds, finance terrorism, or otherwise violate any
  applicable law;
- to attack, exploit, or probe the protocol or its infrastructure.

## Protocol changes

The protocol's parameters — fees, liquidation
thresholds, reward rates, supported assets — can be changed by
governance. Changes that could affect an active position give users a
public notice window through the Timelock mechanism (see
`GovernanceRunbook.md` for the exact delays). Your active positions
continue to follow the parameters in force when you opened them,
unless explicitly stated otherwise for a specific change.

## Keeper delegation

Vaipakam supports delegating "keeper" actions
on your behalf to whitelisted addresses. A keeper you authorize can
execute non-claim, role-scoped actions on your loans (repay,
add-collateral, preclose). Keepers CANNOT claim funds or
transfer your position NFT. You can enable or disable keeper access
per-loan or per-offer at any time while the position is active. You
remain responsible for any action a keeper you authorized takes.

## Stuck-token recovery

Vaipakam offers a recovery flow for tokens
accidentally transferred into your isolated vault that the protocol
does not track. To use it, you sign an EIP-712 attestation declaring
the source of the stuck tokens. That attestation is your representation
that you know where the funds came from. The protocol does not
independently verify the truthfulness of your declaration. You are
responsible for the contents of every recovery signature you produce.
If the source you declare is flagged on the on-chain sanctions oracle,
the recovery transaction will not move the funds and your nonce will
burn. Your wallet will be treated as sanctioned by the protocol for
as long as the source remains flagged on the oracle — new positions,
recovery, and claims are blocked, while you can still repay your
existing loans so the counterparty can be made whole. The block lifts
automatically when the source is de-listed, and any claims that
accrued in the meantime can then be processed normally. This is
distinct from *lost-wallet* recovery: stuck-token recovery returns
funds you can prove the source of to your wallet; it cannot restore
access to a wallet you no longer control.

## Your wallet is your signature

The wallet address you connect IS
your identity on the protocol. Your acceptance of these Terms is a
cryptographic record anchored to that wallet, time-stamped by the
on-chain block number. If you lose access to the wallet, you lose
access to every position it holds — the Vaipakam team cannot recover
any asset on your behalf.

## Changes to these Terms

Governance can publish a new version of
these Terms. When it does, the on-chain `currentTosVersion` +
content-hash pair increments, and you must accept the new version
from your wallet before your next action that starts something new.
Continued use alone is never taken as acceptance.
Failure to re-sign does not affect your on-chain positions — the
Terms gate is only a frontend gate, not a protocol gate.

## Provided as is

The protocol, the site and the app are provided "as is" and "as
available", without any warranty of fitness, merchantability,
availability, or absence of bugs. Every participant — including the
protocol's own developers and governance signers — uses Vaipakam at
their own risk.

## Limitation of liability

To the fullest extent the law allows, no one who builds, operates or
contributes to this software is liable for any loss from using it,
including loss of funds or assets, loss caused by faults in the
software, price feeds, tokens, networks or third-party services, lost
access to a wallet, and any indirect loss such as lost profit. Where
the law does not allow liability to be excluded, liability to any one
user is in no case more than the fees that user paid to the platform
in the last 12 months, and not less than $10 or more than $1,000.
This is a ceiling on a claim, not an amount anyone is promised.
Nothing here limits liability that the law does not allow to be
limited.

## Indemnity

You agree to cover the people who build, operate or contribute to
this software against claims, losses and costs that arise from your
breach of these Terms, your breach of any law, or your misuse of the
protocol, the site or the app.

## Governing convention

These Terms are deliberately short and
written in plain English. They do not substitute for professional
legal advice. If your jurisdiction imposes specific disclosures on
DeFi usage, you are responsible for obtaining them.

## Contact

Security reports: via the bug bounty link in the
footer. Non-security questions: via the public Discord link.
