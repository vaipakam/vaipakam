# Shared accounts with a contract wallet

A family, a club or a team can hold one lending account that several people control. This guide explains how, what the arrangement can and cannot stop, and what to check before you rely on it.

> Using the app from inside a contract wallet is being checked step by step. Until that check is finished, some steps may not work from a contract wallet; this guide names each one found, with its reason.

<a id="shared.how"></a>

## How a shared account works

Vaipakam keeps one vault for each account, and the account is a wallet address. When that address is a **multi-signature contract wallet** (a "safe"), the vault belongs to the safe, and the safe's own rules decide who may sign what. A safe can require, for example, two of three members to approve every transaction, or let one member send small amounts alone.

Vaipakam does not keep a list of members and does not split the account between them. Everything the account holds belongs to the safe. Who may act for the safe, and up to how much, is decided by the safe and nothing else.

<a id="shared.setup"></a>

## Setting one up

1. Create a multi-signature contract wallet with the members and the approval rule you want. Use a widely used, audited contract wallet.
2. Open the Vaipakam app from inside the contract wallet, or connect it through the wallet's own connection to apps.
3. Accept the Terms for the account, from the safe.
4. Deposit through the app. The first deposit creates the account's vault.

Every step is the safe's own transaction or signed message, so it completes only once enough members have approved it in the safe.

<a id="shared.limits"></a>

## What the safe's rules can stop, and what they cannot

**They can stop** any action the account takes: an offer, a borrow, a repayment, a withdrawal, a change of settings. Each needs the approvals the safe asks for.

**They cannot stop** what the platform does by its own rules once the account has agreed to it. A loan the account made is repaid to it, defaults or is liquidated by the loan's terms, whatever the members want at the time. A standing instruction or an auto-lend slot the safe set up keeps working inside the limits the safe set, until the safe changes it.

**They cannot undo** an action. Once enough members approve a transaction and it lands, it is done.

The safe's rules are only as strong as its members' keys. If enough keys to approve are lost or stolen, so is control of the account.

<a id="shared.protected"></a>

## Protected accounts

A shared account can also turn on protected mode. The protected account's delay and its signers apply **on top of** the safe's own rules: a withdrawal the safe approves still waits the account's delay, and the account's signers can still lock it, cancel a waiting withdrawal or approve a replacement. Protected-mode signers are guards: they cannot spend.

<a id="shared.known-limits"></a>

## Known limits

- **Deposit through the app.** A token sent to the account's vault by a plain transfer, from a wallet or an exchange, stays uncounted. Adopting such a token needs a signature from a single key, so a contract-wallet account cannot adopt it today. Deposit through the app instead. A change that lets a contract wallet adopt is planned.
- **The same address is not the same wallet on every network.** A contract wallet's address on one network may belong to a different wallet, or to no wallet at all, on another. Before you use the account's address on another network, for example to claim rewards or to accept the Terms there, confirm that the safe exists at that address on that network and that you control it. Never send assets to the address on a network where you have not confirmed this.
- **Each network is separate.** The vault, the Terms acceptance and the protected-mode settings are kept per network. Set each up on every network you use.

<a id="shared.not"></a>

## What Vaipakam does not do

Vaipakam does not decide who owns what inside a shared account, does not hold a member list, and does not set limits per member. Labels the app shows, such as a member's name, give nobody a right. Agree on how the account is used among yourselves, and write the rules into the safe.
