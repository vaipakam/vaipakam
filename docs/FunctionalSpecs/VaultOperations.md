# Vault and Protected Account Functional Specification

This document consolidates the vault decisions in the November 2–15, 2026
release notes, while retaining later recorded intent. It defines intended
behavior; a dated release or a deployed contract does not establish that a keeper duty is armed or an app capability
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

## Independent boundaries on value leaving a vault

- The platform classifies each outflow and records its asset, quantity,
  destination, reason, and associated position. The vault checks the outcome
  independently. Treasury, backstop, marketplace, listing conduit, order
  protocol, and price-guard addresses are fixed in its code; changing one
  requires delayed vault code. Launch checks refuse endpoint mismatches, including a conduit key resolving
  to a different conduit. The treasury has one source: the vault code, not a
  second platform setting or registry entry.
- The vault hashes only orders whose terms name itself, or its own listing
  escrow, as seller and its own conduit. It answers signature checks only
  from the named marketplace or order protocol. Teardown withdraws the order.
- No allowance survives a transaction. Swaps have an exact temporary limit,
  measured maximum debit and minimum arrival, and close allowance before
  returning. NFT listing approvals exist only inside a fill; a multi-token
  listing uses a separate escrow for its exact lot and returns its remainder
  at teardown. An open allowance blocks other vault movements.
- Stage B1 establishes these outcome and fixed-endpoint checks. It does not
  establish owner-signed lien amounts, complete payment-leg authorization,
  or a vault-verified fair swap floor. Those remain explicit Stage B follow-ups
  before deployment; the platform still chooses the swap adapter and floor
  until the vault can verify the floor against its own price guard. A claim
  that these independent checks already guarantee every payment is incorrect.
- Ordinary claims, net principal, and repayment credits belong to the current
  position holder's own vault. Stored-party balances held for someone else's
  claim remain reserved and cannot become that stored party's free deposits.
  The documented partial swap-to-repay lender payment and full swap surplus
  retain their wallet destinations pending the separate swap-route change.

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

## Vault-owned authority and signed changes

- Each vault alone records its protection delay, lock, signers, destinations,
  owner, and pending replacement. The platform reads that record and cannot
  rewrite it. Owner and signer changes require the right key's direct call
  or signature; ordinary and contract wallets are supported by the contract.
  A relayed signature binds network, vault, exact action, and request, works
  once, expires, and can be voided. Request, approval, cancellation, and removal
  signatures cannot substitute for each other or for a later proposal round.
- The vault enforces its destinations and lock independently. Its address is
  derived from its original owner, so a forged owner record in an unrelated
  look-alike vault cannot qualify that vault as a protocol payee.
- Enabling protection, raising delay, locking, unlocking, switching off, and
  replacing the owner apply the platform's corresponding NFT-lock and payout
  effects in the same transaction. A failed platform action or insufficient
  gas refuses the change; it cannot report success with only half applied.
  Each lock cancels the work pending at that lock. A later unlock cannot
  revive it, and late application of an old lock cannot cancel requests made
  after that unlock. Anyone may request reconciliation of the platform side.
- Queued payout rows still belong to the platform until Stage B3. Release
  reads the vault's lock even before a cancelled row is reconciled, so a
  waiting cancellation cannot make the payout releasable.

## Optional account protection

- The owner may enable protected mode and choose a delay of two to five days.
  Payouts from the vault to the owner's own wallet wait that delay, including
  owner withdrawals. Ordinary net loan proceeds, claims, and open-loan
  lender receipts credit the payee's own vault whether or not protection is
  enabled; withdrawing that credit is a separate action. Protected-mode
  rerouting also catches other settlements that would pay the owner's wallet.
  An account's protection never delays payments it owes to counterparties.
- Payout destinations are the owner or up to five allowlisted addresses.
  Up to five secondary signers must each accept the role with their own key;
  they may cancel payouts, co-sign them, and lock the account. A nominee may
  withdraw its nomination; an active signer cannot cancel its own removal.
  Neither the original account wallet nor its current manager can be a signer.
- An allowlisted destination may verify itself by its own call or signature
  bound to this account, platform, and addition request. Cancelling or voiding
  the request clears verification; a later request needs its own proof.
  While signers exist, an unverified destination needs a signer's co-signature.
  The owner's own address needs no such destination proof. A signer cannot
  co-sign a payout to itself; another signer must do so. Removing the last
  signer clears co-signing permanently until the owner enables it again;
  adding a later signer cannot revive an old requirement. All surfaces and
  keeper releases use the protocol's verdict for the individual payout.
- A destination that is itself protected receives its payment in its own
  vault. Verification and destination names saved in a browser are distinct
  from on-chain destination authorization.
- A lock cancels queued payouts, applies the position-NFT holder lock, and
  blocks new payouts and positions, including taking a lender position by sale or a borrower
  obligation by handover. It does not block loan servicing. A settlement to
  a locked owner stays in the vault instead of preventing settlement.
- An owner's voluntary depository withdrawal, VPFI withdrawal, or release of
  surplus collateral to their own account ends paid, queued, or refused.
  A lock or full queue cannot produce a successful voluntary withdrawal that
  silently pays and queues nothing. A settlement may retain value safely;
  the app distinguishes that hold from a payment or queued withdrawal.
- The separate NFT-protection setting enables the standalone position-NFT
  contract's holder lock. It refuses transfers and approvals, disregards old
  approvals, and locks newly minted positions from their start. A sale or
  borrower handover is refused at fill while that lock holds; default,
  liquidation, and grace-period collateral sales still settle.
- Moving a protected position requires the holder to request an unlock at
  the position-NFT contract and wait its delay. There is no platform NFT-transfer
  queue or co-sign release. The platform may lock, cancel a pending unlock,
  or raise the delay toward the protected account's delay, up to five days;
  it may never unlock or lower that delay. Unlock and delay-lowering execution
  remain callable after their wait; an automated keeper service for those
  position-NFT actions is a separate follow-up.
- A protected account's collateral or parallel-sale listing may pay
  marketplace fees only to its owner or allowed destinations. A locked or
  replaced account cannot post it; the protection check runs again at fill.

## Delayed changes and account replacement

- Changes that loosen protection, including switching NFT protection off,
  wait the selected delay and may be cancelled meanwhile. Locks, account
  replacement, and switching protected mode off void
  pending destination and signer changes; replacement also discards the old
  wallet's pending settings. A matured addition expires if not applied within
  one further delay.
- Where three or more recovery signers are configured, their majority may
  move the account to a new wallet after the delay. The new manager cannot also be a recovery signer.
  From completion, only the new wallet manages the account; the old wallet
  and its keepers lose their rights, including control of offers, intent
  capital, extension reserves, vault VPFI, locks, and implementation pinning.
- Replacement permanently moves the vault's owner record to the new wallet,
  which signs and receives for the account, including code-pin signatures.
  The original wallet and the current manager cannot be proposed again.
  Retirement never clears, protection cannot be switched off, and the replaced
  account clears its destinations and admits no new ones. All payouts,
  deliveries, and reward claims go through its vault and the delay to the
  latest manager, or to that manager's own vault if protected there too.
- One wallet may manage several replaced accounts; the app lists each.
  Old extension consent stops counting, and managing one's own recovered
  position earns no keeper reward. An owner-proposed replacement is cancelled
  by a lock; while a signer holds a lock, only a signer may cancel replacement.
  Physical position NFTs may still remain at the retired address under their
  holder lock pending the separate vault-verified NFT movement follow-up;
  replacement of vault authority does not claim that movement is complete.
- Contract authority and app coverage remain distinct: the extension-reserve
  card currently offers only the connected wallet's own reserves, so it does
  not yet expose withdrawing a replaced account's reserve for its controller.

## Pause escape and implementation pinning

- A continuous administrative pause lasting the escape period opens the
  owner's escape withdrawal route from their own vault to their own wallet.
  An automatic pause during that period does not restart the count. Queued
  payouts remain releasable.
- The escape period is three days by default; the admin may set it between
  49 hours and seven days. Each administrative pause keeps the period in force
  when it started, so a change applies only to pauses that start afterwards.
  The time the running pause's escape opens is readable.
- **Which code a vault runs (#3204).** Every vault runs code chosen by one
  central version registry that no part of the Diamond can change. A vault
  runs the version its owner pinned, as long as that version has not been
  revoked; otherwise it runs the current version. So one governance change
  reaches every unpinned vault at once, and no vault is ever left on old code
  because nobody upgraded it.
- Only the governance Timelock may register a new version, make one current,
  or revoke one. Making a version current and revoking one each wait at least
  seven days between proposal and execution, a wait the registry enforces
  itself, so owners can see a change coming and pin before it lands. The
  Pauser Safe may cancel a pending change but never propose or hurry one.
  While the protocol is paused, and only then, it may also revoke a version
  at once, moving vaults only onto code already registered.
- A pin promises: your vault runs version N until you change the pin, or
  until governance revokes N. A revoke moves a pinned vault to the current
  version without its owner's consent. A revoked version is never restored.
- Pinning, re-pinning and unpinning need the vault owner's own signature,
  checked against the vault's current owner, including a replacement manager,
  and the vault's pin delay. With protected mode on, that delay is raised (by
  the protection settings, to at most two days, so a pin requested as soon as
  a code change is proposed still lands first; only the owner's own signature
  may raise it further), a pending pin change can be cancelled, and none is
  accepted while the account is locked. Lowering the pin delay waits the
  current delay.
- Asset movements retain the platform-only entry boundary; vault protection
  controls additionally accept the authorized owner or signer directly or by
  a valid relay. Every code version preserves the append-only vault layout.
- The seven-day code wait is fixed and must exceed the longest protected
  payout delay, currently five days. Raising that protected maximum requires
  a new version registry with a longer wait. The NFT renderer and transfer
  check retain their separate three-day wait because they cannot move assets.

## App disclosures and keeper service

- The protection page shows settings, payout queues, position-NFT lock state, request
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
  are not instant. A pending lock request holds back only the keeper's own
  releases of that account's payouts; it does not hold
  anyone else's. Because release stays permissionless, anyone can still
  release a payout already past its delay until the lock lands on
  chain, so protection starts when the lock lands, not when the request is
  sent. The app's own lock is one transaction from the owner and has no keeper
  delay, and every such payout was queued on chain and could have been
  cancelled during its whole delay. The owner's alert of a queued payout is
  best effort, not a guarantee: it is not sent when alerts are off or the
  owner is not subscribed, and a late or undeliverable one can be missed
  (owner decision #3177, 2026-11-05). Lock, payout, and replacement alerts disclose the request code
  and route to the current manager. Detailed limits and retry rules are in
  [Keeper Operations](KeeperOperations.md#locking-a-protected-vault-from-telegram-and-owner-alerts).
- At the Stage B2 boundary, app, alpha site, and keeper protection actions
  use direct vault transactions. Contract support for relayed changes does
  not imply those surfaces offer it. Until Stage B4 indexes vault events,
  the keeper finalizes only changes with discoverable ledger rows, and owner
  alerts for locks and proposed replacements do not fire. Other alert channels
  and payout processing are not described as a substitute for those alerts.
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
- [November 5](../ReleaseNotes/ReleaseNotes-2026-11-05.md): snapshotted
  pause escape and the permissionless-release race with Telegram LOCK.
- [November 7](../ReleaseNotes/ReleaseNotes-2026-11-07.md): centrally resolved
  vault versions and cancellable, delayed governance changes.
- [November 8](../ReleaseNotes/ReleaseNotes-2026-11-08.md): standalone
  position-NFT ownership, retirement, and holder locks.
- [November 9](../ReleaseNotes/ReleaseNotes-2026-11-09.md) and
  [November 10](../ReleaseNotes/ReleaseNotes-2026-11-10.md): own-vault credits,
  independent outflow checks, and fixed vault endpoints.
- [November 11](../ReleaseNotes/ReleaseNotes-2026-11-11.md): verified NFT
  arrival, swap-route caveats, and isolated agent LOCK state.
- [November 12](../ReleaseNotes/ReleaseNotes-2026-11-12.md): fixed seven-day
  code delay longer than any protected payout delay.
- [November 15](../ReleaseNotes/ReleaseNotes-2026-11-15.md): vault-held
  protection, request-bound verification and signatures, permanent replacement,
  current-manager pin authority, and Stage B3/B4 coverage limits.
