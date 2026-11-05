# Vault and Protected Account Functional Specification

This document consolidates the vault decisions in the November 2–4, 2026
release notes. It defines intended behavior; a dated release or a deployed
contract does not establish that a keeper duty is armed or an app capability
is available. The keeper's dedicated Cloudflare database and Oracle Cloud VM
remain governed by [Keeper Operations](KeeperOperations.md).

## Deposits, ownership, and free funds

- A vault accepts the owner's ERC-20 tokens, individual NFTs, and multi-token
  balances as deposits without requiring a loan. An asset-specific depository
  record states what the owner deposited or adopted, plus payments credited
  to them, less withdrawals and spending.
- Funds held for loans, offers, intents, rental prepayments, collateral, or a
  position holder's claim are not an owner's deposit merely because they
  physically sit in that vault. Depository withdrawals cannot release them.
- Every payout is bounded by the vault's tracked holding of the exact asset,
  including its kind and token identifier. Marketplace collateral sales
  reduce that holding when they fill. A registered Vaipakam vault may deliver
  an NFT to another registered vault; this does not open receipt to arbitrary
  senders.
- The protocol reports all assets in the depository record and the free
  amount after loans, offers, intents, and queued payouts are accounted for.
  Deposit and withdrawal cards, the desk, accept reviews, fee checks, and
  locked-balance displays use that same figure. A queued payout is not free
  capital that can be spent again.

## Adopting or disowning an untracked asset

- An asset delivered outside the ordinary deposit flow is not withdrawable
  until adopted. Adoption credits the verified untracked amount to the
  account without moving it; an ordinary withdrawal then follows the usual
  payout and protection rules. Adoption replaces the old direct stuck-token
  recovery payout.
- The owner declares the source and signs the acknowledgement. Source
  sanctions screening, the recovery ban, and its automatic lifting remain
  applicable. A replaced account cannot currently adopt, even though its
  replacement controller can manage other assets; the app states that gap.
- The app supports tokens, NFTs, and multi-token balances. It reads the
  protocol's untracked figure for that exact asset on lookup and immediately
  before signing. A wrong NFT standard is refused as a wrong kind, never
  presented as no untracked balance. A single NFT has no typed quantity.
- The acknowledgement, saved attempt, transaction, and result carry the same
  account, network, asset kind, contract, and token identifier. A replacement
  transaction for another asset is reported as that other asset. A missing
  receipt stays unresolved, never a failed payout or permission to retry.
  Concurrent tabs cannot overwrite another unresolved attempt.
- An asset link may fill in its identity, never its source declaration or
  amount. A malformed link opens a blank form.
- Disowning records publicly that an asset is not the account's property.
  It moves nothing and credits nothing. It requires no source declaration,
  acknowledgement signature, or sanctions check, and remains reachable when
  adoption is unavailable. Its result comes from transaction evidence; an
  unknown outcome stays unconfirmed with its transaction link.

## Optional account protection

- The owner may enable protected mode and choose a delay of two to five days.
  Payouts from the vault to the owner's own wallet wait that delay, including
  owner withdrawals and protocol settlements. Payments from elsewhere that
  would reach the protected owner's wallet are credited to their vault
  instead. An account's protection never delays the payments it owes to
  counterparties.
- Payout destinations are the owner or up to five allowlisted addresses.
  Up to five secondary signers must each accept the role with their own key;
  they may cancel payouts, co-sign them, and lock the account.
- A lock cancels queued payouts and transfers and blocks new payouts and
  positions, including taking a lender position by sale or a borrower
  obligation by handover. It does not block loan servicing. A settlement to
  a locked owner stays in the vault instead of preventing settlement.
- An owner's voluntary depository withdrawal, VPFI withdrawal, or release of
  surplus collateral to their own account ends paid, queued, or refused.
  A lock or full queue cannot produce a successful voluntary withdrawal that
  silently pays and queues nothing. A settlement may retain value safely;
  the app distinguishes that hold from a payment or queued withdrawal.
- A protected owner's position NFTs move only through queued, cancellable
  transfers under the payout destination and co-sign rules. The lender
  position cannot be sold while its owner's protection is on.
- A protected account's collateral or parallel-sale listing may pay
  marketplace fees only to its owner or allowed destinations. A locked or
  replaced account cannot post it; the protection check runs again at fill.

## Delayed changes and account replacement

- Changes that loosen protection wait the selected delay and may be cancelled
  meanwhile. Locks, account replacement, and switching protection off void
  pending destination and signer changes; replacement also discards the old
  wallet's pending settings. A matured addition expires if not applied within
  one further delay.
- Where three or more recovery signers are configured, their majority may
  move the account to a new wallet after the delay. The new manager cannot also be a recovery signer.
  From completion, only the new wallet manages the account; the old wallet
  and its keepers lose their rights, including control of offers, intent
  capital, extension reserves, vault VPFI, locks, and implementation pinning.
- The replacement manager acts as holder for the account's existing
  positions. Old extension consent stops counting, and managing one's own
  recovered position earns no keeper reward. An owner-proposed replacement
  is cancelled by a lock. While a signer holds a lock, only a signer can
  cancel the replacement; the owner alert states that restriction.
- Contract authority and app coverage remain distinct: the extension-reserve
  card currently offers only the connected wallet's own reserves, so it does
  not yet expose withdrawing a replaced account's reserve for its controller.

## Pause escape and implementation pinning

- A continuous administrative pause of three days opens the owner's escape
  withdrawal route from their own vault to their own wallet. An automatic
  pause during that period does not restart the count. Queued payouts remain
  releasable.
- An owner may pin the vault's current implementation. A vault behind the
  current release is upgraded before it is pinned, so the pin names the code
  actually in use. Only the owner can upgrade a pinned vault; protected mode
  makes unpinning a delayed change.

## App disclosures and keeper service

- The protection page shows settings, payout and NFT-transfer queues, request
  codes, pending changes, destinations, and signers at one block. Failed or
  partly read lists are unknown, never empty. Unreadable settings expose no
  write controls; an unsupported deployment is unavailable, not protection off.
- Before a withdrawal the app names whether it will be queued and for how
  long. Results distinguish paid, queued, held settlement, refused, and
  unresolved outcomes. A recovery signer may open another account to accept
  the role or perform authorized protection and recovery actions.
- Terms acceptance never blocks taking one's own free assets out, releasing
  an existing payout, requesting an unlock, or increasing protection.
  Deposits, adding a destination or signer, and account replacement remain
  subject to the Terms gate.
- Release and matured-change calls remain permissionless. The separately
  armed keeper service processes them on its minute schedule with independent
  work shares; a due item can wait several runs on a busy chain. A payout to
  a destination no longer allowed is cancelled with the asset retained;
  a sanctions-refused payout remains held and is retried.
- Telegram lock requests require a current wallet link, keeper permission,
  and an active lock service on that chain. They expire after one hour and
  are not instant. Pending lock requests hold that account's payouts and NFT
  transfers. Lock, payout, and replacement alerts disclose the request code
  and route to the current manager. Detailed limits and retry rules are in
  [Keeper Operations](KeeperOperations.md#locking-a-protected-vault-from-telegram-and-owner-alerts).
- Protected-mode contracts and the all-asset tracked ledger require a fresh
  deployment; old tracked ERC-20 balances are not migrated. Testnet deployment
  is distinct from arming any keeper protection, lock, or alert duty.

## Sources

- [November 2](../ReleaseNotes/ReleaseNotes-2026-11-02.md): depository ownership,
  protected mode, account replacement, and voluntary withdrawal outcomes.
- [November 3](../ReleaseNotes/ReleaseNotes-2026-11-03.md): all-asset adoption
  and disowning.
- [November 4](../ReleaseNotes/ReleaseNotes-2026-11-04.md): reserve presentation,
  protected releases and settings, Telegram locks, and owner alerts.
