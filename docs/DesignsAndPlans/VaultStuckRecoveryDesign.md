# Escrow Stuck-Token Recovery — Design Spec

Status: **Locked design — ready for implementation.**

Audience: contracts engineer implementing the recovery flow + frontend
engineer wiring the discoverability gating + ops engineer running the
post-deploy labeling sequence.

Companion docs:
- [`AnalyticsLabelRegistration.md`](../ops/AnalyticsLabelRegistration.md) —
  post-launch labeling steps so analytics firms recognize Vaipakam
  per-user escrow proxies.
- [Receiver-hook hardening — 2026-05-03 release notes](../ReleaseNotes/ReleaseNotes-2026-05-03.md)
  — the NFT side of the same defence-in-depth picture (already shipped).

---

## 1. Threat model

The Vaipakam escrow design is permissionless on the inbound side for
ERC-20: anyone holding an ERC-20 token can call `transfer` /
`transferFrom` directly to a user's escrow proxy address, and the EVM
gives the recipient zero opportunity to reject. (NFTs are fully gated
by the receiver-hook hardening landed in 2026-05-03; this document
addresses ONLY the ERC-20 case the EVM cannot block at receive time.)

Three scenarios drive the design:

1. **Taint poisoning.** A griefer sends dust from a Chainalysis-listed
   wallet (or any reputation-tarnished address) to a high-value user's
   escrow. The escrow's on-chain history now includes a transfer from
   a sanctioned source. Generic taint-tracking tools may flag the
   escrow regardless of whether the dust ever moves. Precedent: the
   August 2022 Tornado Cash dust-attack on ~600 high-profile wallets.

2. **Self-mistake.** A user copies their escrow address from a block
   explorer (or an out-of-band channel) and sends ERC-20 funds to it
   directly — perhaps from their own wallet, perhaps from a CEX
   withdrawal. The funds land in escrow without protocol bookkeeping.
   Under the current code there is no path back out for these tokens.

3. **Unsolicited drift.** A token contract behaves unexpectedly — a
   rebase pushes balance up, a fee-on-transfer drops it down. The
   escrow's `balanceOf` diverges from the protocol-tracked balance.

The design must:
- Provide a recovery path for #2 (legitimate stuck funds).
- Make #1 a no-op (taint dust does not pollute protocol mechanics, and
  the user is not pressured into actions that would expose them).
- Bound recovery so it can never touch protocol-managed balances
  (collateral / principal / claims / staking).

---

## 2. Locked design decisions

The decisions below were resolved through a multi-round design
discussion. They are commitments — implementation should follow them
verbatim unless a security finding forces a revision.

### 2.1 Recovery cap — counter-bounded

Every per-user escrow proxy maintains a per-token running counter:

```
protocolTrackedEscrowBalance[user][token]
  +=  every escrowDepositERC20 amount
  -=  every escrowWithdrawERC20 amount
```

The recovery cap is:

```
unsolicited = max(0, IERC20(token).balanceOf(proxy) - protocolTrackedEscrowBalance[user][token])
require(amount <= unsolicited)
```

This is **self-bounding by construction**. Even if every other check
is bypassed — sanctions oracle compromised, signature verified
incorrectly, admin role abused — the arithmetic forbids draining
beyond the truly-unsolicited delta. The math is the load-bearing
safety property; everything else is policy.

### 2.2 Single-sig recovery; no source-side signature

The recovery flow is initiated by the escrow owner (the EOA whose
address is recorded in `userVaipakamEscrows[user]`). The transaction
itself authenticates `msg.sender`. There is **no second signature**
from the source wallet — the contract has no on-chain way to verify
that a declared source actually originated the unsolicited transfer
anyway, so requiring a second signature would be security theatre.

The asymmetry-of-consequences makes this safe:

- Honest user with self-deposit → declares own source → sanctions
  oracle clears it → recovery succeeds.
- Honest user with self-deposit from CEX hot wallet → declares the
  hot wallet → sanctions oracle clears it → recovery succeeds.
  (No CEX-hot-wallet whitelist is needed.)
- Honest user with taint poisoning → reads warning → does not
  initiate recovery → dust sits inert; protocol functions normally.
- Sanctioned-fund launderer → either declares actual sanctioned
  source (escrow gets banned, self-incrimination) OR lies and
  declares a clean source (recovery succeeds, but funds go to their
  already-Tier-1-cleared EOA, which they could have moved to without
  Vaipakam — net-zero benefit).

### 2.3 Three terminal states

| State | Action | Tokens | Escrow status |
|---|---|---|---|
| Recover-clean | User declares source → sanctions oracle clears it | Move to user EOA | Operates normally |
| Recover-sanctioned | User declares source → sanctions oracle flags it | Stay in escrow | **Locked-and-banned** (existing sanctions Tier-1/Tier-2 semantics; auto-unlocks if address de-listed) |
| Disown / ignore | User explicitly disowns OR takes no action | Stay in escrow | Operates normally (Locked-but-active) |

"Forfeit" in earlier discussion = the **Disown / ignore** row. The
**Recover-sanctioned** row triggers the existing sanctioned-address
banning semantics on the escrow itself, not just the dust.

### 2.4 Recipient locked to escrow owner's EOA

Recovery transfers go ONLY to `msg.sender` (the escrow owner). The
contract never accepts a recipient parameter. This makes admin abuse,
malware-coerced approvals, and most coordination attacks structurally
impossible to redirect funds.

### 2.5 Two-layer consent for recovery

The recovery action is gated by both:
- **EIP-712 typed-payload signature** — wallet shows structured
  message with the declared source, amount, deadline, and a hash of
  the warning text. Cryptographic record of explicit acknowledgment.
- **Type CONFIRM modal in the frontend** — explicit affirmative
  action before the wallet popup; prevents auto-clicked / malware-
  coerced approval.

The signature is NOT strictly required for security (the transaction
sig already authenticates `msg.sender`), but serves as a portable,
tamper-proof consent record useful for compliance / regulatory
review. The "type CONFIRM" pattern handles the in-the-moment human
attestation.

### 2.6 Discoverability gating

The recovery page is **not linked from anywhere in the main
application UI** — not Dashboard, not Asset Viewer, not Settings, not
the basic User Guide, not FAQ, not Footer. Discovery is restricted
to:
- A dedicated section in the **Advanced User Guide** explaining what
  taint poisoning is, what recovery is, the sanctions consequence,
  and when NOT to use it.
- A deep link from that section to the recovery page.

The recovery page itself sets `<meta name="robots"
content="noindex,nofollow">` to keep search engines from making it
trivially findable.

This design intentionally trades visibility (some advanced users will
have to dig harder) for safety (naive users can't accidentally
self-incriminate by declaring a sanctioned source on dust they
didn't send themselves).

### 2.7 `disown(token)` event-only function

A dedicated `disown(token)` function emits
`TokenDisowned(user, token, observedAmount, blockNumber)` and changes
no state. Useful in:
- External audits ("this user formally disowned this dust at this
  block")
- Individual user disputes with CEXs / regulators ("here's the
  on-chain record of my disowning the suspicious deposit")

Cheap to add (just an event); valuable for compliance posture.

### 2.8 VPFI integration

`depositVPFIToEscrow` ([VPFIDiscountFacet.sol:394](../../contracts/src/facets/VPFIDiscountFacet.sol#L394))
currently does direct `IERC20.safeTransferFrom(user, escrow, amount)`,
bypassing `escrowDepositERC20`. **Refactor to route through
`escrowDepositERC20`** so the counter ticks correctly for VPFI stakes.

The withdraw side
([VPFIDiscountFacet.sol:525](../../contracts/src/facets/VPFIDiscountFacet.sol#L525))
already calls `escrowWithdrawERC20` — symmetric.

Staking rewards distribution
([StakingRewardsFacet.sol:80](../../contracts/src/facets/StakingRewardsFacet.sol#L80))
sends VPFI directly to user's EOA via `safeTransfer(msg.sender, paid)`
— never touches escrow, doesn't pollute the counter. **No change.**

### 2.9 Staking-checkpoint refactor

`LibStakingRewards.updateUser` and `LibVPFIDiscount.rollupUserDiscount`
currently read `IERC20(vpfi).balanceOf(escrow)`. With the counter in
place, they should read **`min(balanceOf, protocolTrackedEscrowBalance[user][vpfi])`**
so unsolicited VPFI dust does NOT earn yield and does NOT inflate the
discount tier. This kills the "stake by direct transfer" loophole and
the "tainted dust earns yield" loophole simultaneously.

VPFI-as-collateral does land in `tracked` (via `escrowDepositERC20`)
and so DOES earn yield while sitting locked under a loan — this is by
design (token economics decision: collateral earning yield is a user
benefit).

### 2.10 No CEX hot-wallet whitelist

The single-sig model handles legitimate CEX-stuck-deposit cases for
free: user declares the CEX hot wallet as source, sanctions oracle
returns clean (CEX hot wallets are not sanctioned), recovery
proceeds. No special-case mapping or governance mechanism needed.

### 2.11 Forfeit semantics

Tokens that stay in escrow under the **Disown / ignore** or **Recover-
sanctioned** outcomes never move to treasury. They sit in the escrow.
If a sanctions list is later updated to remove the flagged address,
the **Locked-and-banned** escrow auto-unlocks and the user regains
access (consistent with existing sanctioned-address semantics
elsewhere in the protocol).

### 2.12 EIP-712 scope

EIP-712 is used for:
- Recovery acknowledgment (this design)
- Permit2 (already in production)
- Possibly the `disown` action (TBD — small benefit since the action
  is non-financial)

EIP-712 is **NOT** used for:
- Offer creation
- Offer acceptance
- Match offers
- Other facet entry points

For user-initiated, user-pays-gas, single-tx flows, the transaction
signature already authenticates and clear frontend pre-tx review
provides the consent UX. EIP-712 is overkill there. Revisit if/when
the protocol adds gasless/relayed flows or off-chain order books.

---

## 3. Storage additions

In `LibVaipakam.Storage`:

```solidity
/// @dev Per-(user, token) running counter of ERC-20 amount deposited
///      via `escrowDepositERC20` minus amount withdrawn via
///      `escrowWithdrawERC20`. The recovery flow uses this as the
///      load-bearing safety bound: recovery cap =
///      max(0, balanceOf(proxy) - protocolTrackedEscrowBalance[user][token]).
mapping(address => mapping(address => uint256)) protocolTrackedEscrowBalance;

/// @dev Per-user nonce for EIP-712 recovery acknowledgments.
///      Replay-protects each signature; incremented on use.
mapping(address => uint256) recoveryNonce;
```

Both are append-to-end; no layout reshuffle needed for upgrades.

---

## 4. Function specs

### 4.1 `recoverStuckERC20`

```solidity
function recoverStuckERC20(
    address token,
    address declaredSource,
    uint256 amount,
    uint256 deadline,
    bytes calldata signature  // EIP-712 over RecoveryAcknowledgment
) external
```

Located on `EscrowFactoryFacet` (same facet as `escrowDepositERC20` /
`escrowWithdrawERC20` for code locality).

Flow:

1. Sanctions check on `msg.sender` (already in place via Tier-1 entry
   gating).
2. Validate `deadline >= block.timestamp`.
3. Recover signer from `signature` over the EIP-712 payload (see §5).
   Require `signer == msg.sender`.
4. Bump `s.recoveryNonce[msg.sender]`.
5. Resolve `proxy = s.userVaipakamEscrows[msg.sender]`. Revert
   `UserHasNoEscrow()` if zero.
6. Compute `unsolicited = max(0, IERC20(token).balanceOf(proxy) -
   s.protocolTrackedEscrowBalance[msg.sender][token])`.
7. Require `amount > 0` and `amount <= unsolicited`.
8. Sanctions oracle check on `declaredSource`. If sanctioned:
   - Set `s.escrowBanned[msg.sender] = true` (or invoke whatever the
     existing sanctions-banning primitive is — match the pattern used
     by `_assertNotSanctioned`).
   - Emit `EscrowBannedFromRecoveryAttempt(user, token, declaredSource, amount)`.
   - Revert `EscrowBannedDueToSanctionedSource()`.
   - Tokens stay in escrow.
9. If clean:
   - Cross-facet call to the proxy's `withdrawERC20(token, msg.sender, amount)`.
     Recipient is `msg.sender` (the escrow owner) — hardcoded.
   - Emit `StuckERC20Recovered(user, token, declaredSource, amount, signatureHash)`.

### 4.2 `disown`

```solidity
function disown(address token) external
```

1. Sanctions check on `msg.sender`.
2. Resolve `proxy = s.userVaipakamEscrows[msg.sender]`. Revert
   `UserHasNoEscrow()` if zero.
3. Read `observedAmount = max(0, IERC20(token).balanceOf(proxy) -
   s.protocolTrackedEscrowBalance[msg.sender][token])`.
4. Emit `TokenDisowned(msg.sender, token, observedAmount, block.number)`.
5. No state changes beyond the event.

### 4.3 `escrowDepositERC20` / `escrowWithdrawERC20` — counter increments

Add two lines each:

```solidity
function escrowDepositERC20(address user, address token, uint256 amount) external onlyDiamondInternal {
    // ... existing body ...
    s.protocolTrackedEscrowBalance[user][token] += amount;
}

function escrowWithdrawERC20(address user, address token, address recipient, uint256 amount) external onlyDiamondInternal {
    // ... existing body ...
    s.protocolTrackedEscrowBalance[user][token] -= amount;
}
```

`-=` will revert on underflow, which is the correct safety property
(it would mean a withdraw was attempted for more than was tracked,
indicating an accounting bug elsewhere).

### 4.4 `depositVPFIToEscrow` refactor

Replace the direct `safeTransferFrom` with a call into
`escrowDepositERC20`:

```solidity
function depositVPFIToEscrow(uint256 amount) external nonReentrant whenNotPaused {
    LibVaipakam._assertNotSanctioned(msg.sender);
    (address vpfi, address escrow) = _prepareDeposit(amount);

    // Pull VPFI from user to escrow via the escrow factory's
    // bookkeeping path so the protocolTrackedEscrowBalance counter
    // tracks staked VPFI correctly. Replaces the prior direct
    // safeTransferFrom which bypassed the counter.
    IERC20(vpfi).safeTransferFrom(msg.sender, address(this), amount);
    IERC20(vpfi).safeIncreaseAllowance(escrow, amount);
    EscrowFactoryFacet(address(this)).escrowDepositERC20(msg.sender, vpfi, amount);

    emit VPFIDepositedToEscrow(msg.sender, amount);
}
```

Note: this requires the proxy's `depositERC20` to pull from
`address(this)` (the Diamond), which it does today —
`escrowDepositERC20` calls `proxy.depositERC20(token, amount)` which
runs `safeTransferFrom(msg.sender, address(this), amount)` from the
proxy's context where `msg.sender == diamond`. So pulling tokens to
the Diamond first then forwarding is the correct sequence.

The Permit2 variant (`depositVPFIToEscrowWithPermit`) needs the same
restructuring — pull via Permit2 to the Diamond first, then forward
to escrow via `escrowDepositERC20`.

### 4.5 `LibStakingRewards.updateUser` + `LibVPFIDiscount.rollupUserDiscount` — `min` clamp

Both functions currently read `IERC20(vpfi).balanceOf(escrow)`. Change
to read:

```solidity
uint256 escrowBal = IERC20(vpfi).balanceOf(escrow);
uint256 tracked = s.protocolTrackedEscrowBalance[user][vpfi];
uint256 yieldBearingBalance = escrowBal < tracked ? escrowBal : tracked;
```

Use `yieldBearingBalance` instead of the raw `escrowBal` for accrual
math. Unsolicited dust (above tracked) gets ignored; underflow
(balance below tracked, e.g. from FOT/rebase) clamps to balance so we
never over-accrue.

---

## 5. EIP-712 payload

```
domain = {
  name:    "Vaipakam Recovery",
  version: "1",
  chainId: <activeChainId>,
  verifyingContract: <diamondAddress>,
}

struct RecoveryAcknowledgment {
  address user;
  address token;
  address declaredSource;
  uint256 amount;
  uint256 nonce;       // == s.recoveryNonce[user] at sign time
  uint256 deadline;    // unix seconds
  bytes32 ackTextHash; // keccak256 of the warning text (constant)
}
```

`ackTextHash` is `keccak256` of the canonical warning text:

> "I am declaring that the source address belongs to a wallet I
> control or authorized. If the source is later determined to be on
> the sanctions list, my escrow will be locked under the protocol's
> sanctions policy until the address is de-listed. I have read and
> understood the Advanced User Guide section on stuck-token
> recovery."

The hash is a compile-time constant in the contract; the warning text
itself lives in the frontend and the Advanced User Guide. If the text
ever needs to change, bump the constant and the on-chain hash in the
same release.

---

## 6. Frontend flow

### 6.1 Discovery

- Recovery page lives at `/recover`.
- `<meta name="robots" content="noindex,nofollow">` on the page.
- No nav links, no buttons, no banners anywhere in the main app.
- The Advanced User Guide section "Stuck-token recovery" explains
  the mechanic in full, including the sanctions consequence, and
  links to `/recover` at the bottom.

### 6.2 Page UX

```
[Header]
Stuck-token recovery
Use this page only if you sent ERC-20 tokens directly to your
escrow address. Read the Advanced User Guide section before
proceeding.

[Form]
Token contract address:    [_____________]
Source address (yours):    [_____________]
Amount:                    [_____________]

[Review button]
```

On Review click, frontend:

1. Calls a view function `getUnsolicitedBalance(user, token)` that
   returns `max(0, balanceOf - tracked)`.
2. If `amount > unsolicited`, shows error and disables Review.
3. Else: opens confirmation modal.

Confirmation modal:

```
═══ Final confirmation ═══════════════════════════
You are declaring:
  Token:    USDC (0xA0b8...eB48)
  Source:   0xabc...123  (your declaration)
  Amount:   150.00 USDC

⚠️ If the declared source address is on the sanctions list, your
   escrow will be locked under our sanctions policy. The lock will
   automatically lift if the address is removed from the list.

⚠️ Do not declare a source you do not own. Tokens received from
   unknown sources do not affect your protocol balance and are safe
   to ignore.

Type CONFIRM to enable the sign button:  [_______]

[Cancel]   [Sign declaration]  ← disabled until "CONFIRM" typed
```

On Sign:
1. Frontend builds the `RecoveryAcknowledgment` EIP-712 payload.
2. Wallet shows structured message; user signs.
3. Frontend submits the recovery transaction with signature.

### 6.3 Asset Viewer integration

Asset Viewer shows ONLY protocol-managed tokens with their tracked
balances. Below the position list:

> Only tokens managed by the Vaipakam protocol are shown here. Do not
> send any tokens directly to your escrow address — they may not be
> recoverable.

No "stuck tokens" section. No `[Recover]` buttons. No expandable
banner. The dust does not appear in the UI.

---

## 7. Edge cases

### 7.1 Fee-on-transfer (FOT) tokens

Standard FOT (e.g. SAFEMOON-style): user transfers 100, receiver
gets 95. With our counter:

```
escrowDepositERC20(user, FOT, 100):
  counter += 100
  actual transfer credits escrow with 95
  → balance(95) - tracked(100) = -5  // would underflow in unsolicited calc
```

The `max(0, balance - tracked)` floors this to 0 — recovery is denied
for FOT tokens, which is acceptable. FOT tokens shouldn't be
protocol-configured assets in the first place (risk-params validation
filters them out for retail deploy). For taint dust in FOT, recovery
denial is the right outcome (it would only return a lossy fraction
anyway).

### 7.2 Rebasing tokens (positive rebase / yield)

```
deposit 100 stETH:           counter = 100, balance = 100
positive rebase (yield):     counter = 100, balance = 102
→ unsolicited = 102 - 100 = 2
```

User can "recover" 2 stETH as if it were stuck dust. Functionally fine
(it IS theirs), just routes through the recovery path instead of an
unstake path. Slightly weird but harmless.

### 7.3 Rebasing tokens (negative rebase / slashing)

```
deposit 100 stETH:           counter = 100, balance = 100
negative rebase (slashing):  counter = 100, balance = 98
→ unsolicited = max(0, -2) = 0
```

Recovery denied. The user's protocol-tracked balance (100) exceeds
the actual balance (98) — a separate problem visible in protocol
withdrawals, but the recovery flow is correctly inert here.

### 7.4 User has no escrow

If `s.userVaipakamEscrows[msg.sender] == address(0)`, both
`recoverStuckERC20` and `disown` revert `UserHasNoEscrow()`. There's
nothing to recover from a non-existent escrow.

### 7.5 Sanctions oracle unreachable

If the sanctions oracle staticcall reverts or returns garbage, treat
the source as **flagged** (fail-safe). Reverts the recovery with
`SanctionsOracleUnavailable()` so the user can retry once the oracle
recovers, rather than executing recovery on a potentially-flagged
source under unknown conditions.

### 7.6 Escrow already banned

If `s.escrowBanned[msg.sender] == true`, `recoverStuckERC20` reverts
with the standard banned-escrow error. `disown` is allowed (a banned
user may still want to assert non-ownership for compliance). Decide
during implementation whether `disown` honours the ban — leaning
towards "allow disown even when banned, since it's purely
informational."

---

## 8. Tests

New `EscrowStuckRecoveryTest.t.sol`:

| Test | Asserts |
|---|---|
| `testRecoverHappyPathCleanSource` | Clean source → tokens move to user EOA, counter unchanged, balance reduced by amount |
| `testRecoverHappyPathCEXHotWallet` | CEX-style address (not in mock sanctions list) → recovery succeeds |
| `testRecoverRevertsAmountExceedsUnsolicited` | `amount > balance - tracked` → revert |
| `testRecoverRevertsZeroAmount` | `amount == 0` → revert |
| `testRecoverRevertsNoEscrow` | User without escrow → `UserHasNoEscrow` |
| `testRecoverWithSanctionedSourceBansEscrow` | Sanctioned source → escrow banned, tokens stay, revert |
| `testRecoverRevertsExpiredDeadline` | Deadline in past → revert |
| `testRecoverRevertsBadSignature` | Signature signer ≠ msg.sender → revert |
| `testRecoverRevertsReplay` | Same nonce reused → revert (nonce already consumed) |
| `testRecoverRevertsAfterEscrowBanned` | Banned escrow → recovery reverts |
| `testRecoverFloorsFOTUnderflow` | FOT token deposits with counter > balance → unsolicited == 0 → recovery reverts amount-too-high |
| `testRecoverWorksAfterRebaseUp` | Rebase increased balance → recovery of the delta succeeds |
| `testRecoverHardcodedRecipient` | Frontend cannot pass a different recipient — function signature has no recipient param; test by directly crafting calldata to verify ABI rejection |
| `testRecoverIncrementsNonce` | After recovery, `recoveryNonce[user]` is `prev + 1` |
| `testDisownEmitsEvent` | Disown of stuck token → event emitted with correct (user, token, amount, blockNumber) |
| `testDisownChangesNoState` | Pre/post storage snapshot identical except for the event |
| `testCounterTracksDepositsAndWithdrawals` | After multiple deposit/withdraw cycles, counter == sum(deposits) − sum(withdrawals) |
| `testStakingDepositCountsTowardCounter` | After `depositVPFIToEscrow`, counter increments correctly |
| `testStakingCheckpointReadsMin` | Direct VPFI transfer (bypassing protocol) → escrow balance > tracked → staking yield computed on tracked, not balance |

Plus regression: every existing test that touches `escrowDepositERC20`
or `escrowWithdrawERC20` should continue to pass — the counter
operations are invisible to them since the math is correct.

---

## 9. Implementation order (PR sequence)

| PR | Scope | Tests |
|---|---|---|
| PR-1 | Storage additions (`protocolTrackedEscrowBalance`, `recoveryNonce`) + counter increments in `escrowDepositERC20` / `escrowWithdrawERC20` | Counter consistency tests; full regression must remain green |
| PR-2 | `depositVPFIToEscrow` + Permit2 variant refactor through `escrowDepositERC20`; `LibStakingRewards.updateUser` + `LibVPFIDiscount.rollupUserDiscount` `min` clamp | Staking-checkpoint min-clamp tests; existing VPFI tests still pass |
| PR-3 | `recoverStuckERC20` + `disown` + EIP-712 verifier + new errors / events | New `EscrowStuckRecoveryTest.t.sol` suite |
| PR-4 | Frontend `/recover` page + Asset Viewer warning copy + Advanced User Guide section + escrow-address redaction | Manual UAT on Sepolia |
| PR-5 | Post-deploy: analytics-firm label registration (see [`AnalyticsLabelRegistration.md`](../ops/AnalyticsLabelRegistration.md)) | Operational sign-off |

---

## 10. Open questions

1. **`disown` while banned**: should `disown` revert if the escrow is
   banned, or should it stay allowed (informational, useful for
   compliance even when banned)? Leaning **allow even when banned**,
   but flagging for implementer judgement.
2. **Permit2 variant gas overhead**: `depositVPFIToEscrowWithPermit`
   refactor adds an internal cross-facet hop (`escrowDepositERC20`)
   on top of the Permit2 pull. Estimate gas delta during PR-2;
   acceptable if < ~30k overhead.
3. **EIP-712 for `disown`**: low value (action is non-financial);
   skip unless implementer sees a strong reason.

---

## 11. References

- [Receiver-hook hardening release notes (2026-05-03)](../ReleaseNotes/ReleaseNotes-2026-05-03.md)
  — the NFT-side counterpart already shipped.
- [`AnalyticsLabelRegistration.md`](../ops/AnalyticsLabelRegistration.md)
  — post-launch labeling sequence.
- [`VPFIDiscountFacet.sol`](../../contracts/src/facets/VPFIDiscountFacet.sol)
  — staking deposit / withdraw flow.
- [`LibStakingRewards.sol`](../../contracts/src/libraries/LibStakingRewards.sol)
  — accrual checkpoint to be `min`-clamped.
- Tornado Cash dust attack precedent (August 2022) — public-record
  precedent for taint-poisoning griefing.
