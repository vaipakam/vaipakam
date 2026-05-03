# Release Notes — 2026-05-04

Functional record of work delivered on 2026-05-04, written as
plain-English user-facing / operator-facing descriptions — no code.
Continues from
[`ReleaseNotes-2026-05-03.md`](./ReleaseNotes-2026-05-03.md).

Coverage at a glance: **Escrow protocol-tracked balance counter shipped
ahead of T-054**. The per-(user, token)
`protocolTrackedEscrowBalance` mapping landed today as the architectural
chokepoint refactor. Every protocol-side ERC-20 deposit / withdrawal
flows through `EscrowFactoryFacet.escrowDepositERC20` (or its cross-
payer / counter-only siblings), so the counter stays the symmetric
mirror of all protocol-mediated escrow movements. The Asset Viewer
now displays `min(balanceOf, protocolTrackedEscrowBalance)` so
unsolicited dust is structurally hidden from the UI. The future
stuck-token recovery flow (T-054) will cap recovery at
`max(0, balanceOf - tracked)` — the arithmetic itself becomes the
load-bearing safety property.

---

## What changed under the hood

### A new chokepoint for protocol-side ERC-20 deposits

`EscrowFactoryFacet.escrowDepositERC20(user, token, amount)` was
previously a thin forwarder that called the proxy's `depositERC20`.
Most production flows bypassed it, doing direct
`IERC20.safeTransferFrom(user, escrow, amount)` from facet code. That
asymmetry meant any per-(user, token) running counter would only see
withdrawals (which all flow through `escrowWithdrawERC20`) and never
deposits — the counter would underflow on the first legitimate
withdraw.

The refactor turns `escrowDepositERC20` into the single chokepoint:
it pulls `amount` directly from the user's wallet (via the Diamond's
existing allowance) into the user's escrow proxy, AND increments the
counter under `user, token`. Two siblings handle the cases the simple
chokepoint can't cover:

- **`escrowDepositERC20From(payer, user, token, amount)`** — cross-
  payer variant. Used by repay / preclose / refinance flows where the
  borrower pays into the lender's escrow. Pulls from `payer`'s
  allowance, credits `user`'s escrow, ticks the counter under `user`.
- **`recordEscrowDepositERC20(user, token, amount)`** — counter-only
  sibling. Used after Permit2 has already moved funds (the transfer
  happens via the signed permit; this just updates the counter so it
  doesn't drift).

Plus a public view: **`getProtocolTrackedEscrowBalance(user, token)`**
that consumers (Asset Viewer, the future recovery flow) read.

### Every production deposit migrated to the chokepoint

The refactor sweeps across:

- **OfferFacet** — `_pullCreatorAssetsClassic` (lender ERC-20 lending,
  borrower ERC-20 collateral on offer creation, NFT-rental prepay) and
  `_acceptOffer`'s borrower-side collateral / prepay paths. The
  Permit2 paths use the counter-only sibling after the Permit2 pull.
- **AddCollateralFacet** — top-up of an active loan's collateral.
- **VPFIDiscountFacet** — `depositVPFIToEscrow` and the Permit2
  variant. Both now route through the chokepoint so VPFI staking
  ticks the counter consistently with every other protocol asset.
- **RepayFacet** — borrower → lender's-escrow principal+interest at
  full repayment; NFT-rental settlement of the lender's rental share;
  fallback collateral re-deposit on cure.
- **PrecloseFacet** — borrower → lender's-escrow at precloseDirect;
  the offset-with-new-offer payment to the old lender; Alice's
  shortfall path on transferObligationViaOffer.
- **RefinanceFacet** — borrower → old-lender's-escrow at refinance.
- **EarlyWithdrawalFacet** — Diamond → new-lender's-escrow on
  position-buy completion (both classic + sale paths).
- **ClaimFacet** — the Diamond → escrow re-distribution at retry-
  succeeds and fallback-collateral split.
- **RiskFacet** — HF-liquidation Diamond → lender / borrower escrow
  proceed splits.
- **DefaultedFacet** — time-based default Diamond → lender / borrower
  escrow proceed splits; illiquid-collateral transfer-to-lender;
  rental prepay-to-lender on default.
- **LibFacet.depositFromPayerForLender** — internal helper used by
  position-buy flows.

That's ~20 production deposit sites now uniformly tracked.

### What was deliberately NOT changed in this PR

- **Staking checkpoint min-clamp.** The
  `LibStakingRewards.updateUser` / `LibVPFIDiscount.rollupUserDiscount`
  callers still pass the raw `balanceOf` of the user's escrow VPFI as
  the new staked balance. Switching them to
  `min(balanceOf, protocolTrackedEscrowBalance[user][vpfi])` would
  drop existing testnet stakers' effective stake to zero (legacy
  stakes have `tracked = 0` since the counter just shipped today).
  This is a separate migration that needs either a counter backfill
  script or a coordinated re-stake; deferred to a future PR.
- **Recovery flow itself.** The recovery flow (T-054) is unchanged
  by this PR. The counter is the architectural pre-requisite that
  recovery will eventually consume; recovery's `max(0, balanceOf -
  tracked)` cap and `disown` event-only function ship in T-054 PR-3.

### Test infrastructure changes

`HelperTest.sol`'s two `EscrowFactoryFacet` selector lists
(`getEscrowFactoryFacetSelectors` / `getEscrowFactoryFacetSelectorsExtended`)
each grew by 3 entries (`escrowDepositERC20From`,
`recordEscrowDepositERC20`, `getProtocolTrackedEscrowBalance`).

Tests that previously seeded escrow balances via direct
`ERC20.transfer(escrow, …)` / `deal(token, escrow, …)` /
`ERC20Mock.mint(escrow, …)` — bypassing the protocol path — were
updated to follow each direct seed with a
`recordEscrowDepositERC20(user, token, amount)` call so the counter
agrees with the on-chain balance and the subsequent
`escrowWithdrawERC20` doesn't underflow. Affected files:
RefinanceFacetTest, ClaimFacetTest, LoanFacetTest, RepayFacetTest,
EarlyWithdrawalFacetTest, VPFIDiscountFacetTest (auto-applied across
8 patterns).

`testEscrowDepositERC20` was rewritten under the new semantics: the
chokepoint pulls from the user's allowance to the Diamond, not from
the Diamond's own balance. Two new sibling tests landed:
`testEscrowDepositERC20From` (cross-payer) and
`testRecordEscrowDepositERC20` (counter-only).

Four failure-mode tests that mocked
`EscrowFactoryFacet.getOrCreateUserEscrow` to revert
(`testRefinanceLoanGetLenderEscrowFails`,
`testPrecloseDirectGetLenderEscrowFails`,
`testTransferObligationGetEscrowFails`,
`testRepayLoanCrossFacetCallFailed`) now mock
`EscrowFactoryFacet.escrowDepositERC20From` instead — the escrow
resolution that was previously a separate cross-facet call now lives
inside the chokepoint, so the mock target shifted accordingly.
The tests still exercise the same failure-propagation guarantee:
when the protocol's escrow plumbing fails, the calling flow must
bubble the revert up.

### Frontend

The Asset Viewer page now reads `min(balanceOf, tracked)` per token.
For each protocol-managed token configured in the active chain's
deployment record, the page issues two parallel reads —
`IERC20.balanceOf(escrow)` and
`EscrowFactoryFacet.getProtocolTrackedEscrowBalance(user, token)` —
and displays the lesser of the two. Unsolicited dust that arrives
via direct `IERC20.transfer` is structurally hidden from the UI.

### Testnet display cutover (one-time, documented)

Existing testnet deploys have stakes / collateral that were deposited
before the counter shipped. Those deposits never ticked the counter
(it didn't exist), so for those users `tracked = 0` while
`balanceOf > 0`. Under the new display rule, those balances render
as `0` until the user re-deposits via the new chokepoint.

Acceptable for testnet — we communicate this once to existing testers
("re-deposit your VPFI / collateral once after the upgrade to refresh
the display"). On a fresh mainnet deploy this case never occurs
because the counter starts ticking from day 1.

For the future T-054 recovery flow, this cutover matters more: a
recovery cap of `max(0, balanceOf - tracked)` on a legacy
unrecorded-balance escrow would treat ALL the legacy balance as
unsolicited and allow recovery to drain it. The recovery flow MUST
NOT ship until the counter is bootstrapped for legacy balances —
either via a migration script that walks active loans / stakes /
claims, or via a coordinated re-deposit cycle. Captured in
`docs/DesignsAndPlans/EscrowStuckRecoveryDesign.md`'s open-questions
section as a deploy-day prerequisite for T-054.

---

## Verification

- New tests: `testEscrowDepositERC20From`, `testRecordEscrowDepositERC20`
  — both green. Existing `testEscrowDepositERC20` rewritten under new
  semantics — green.
- Full no-invariants regression: **1596 passing / 0 failed / 5 skipped**
  (up from 1594 yesterday; net +2 from the new chokepoint tests).
- `forge build` clean.
- Frontend `tsc -b --noEmit` clean.
- ABIs re-exported to the frontend + keeper-bot.

---

## What's next

The counter is the architectural pre-requisite for the stuck-token
recovery flow (T-054). With this landed, the next steps in the T-054
sequence are:

- **PR-2**: switch the staking checkpoint to read
  `min(balanceOf, tracked)`. Requires counter backfill for legacy
  testnet stakes; design that migration first.
- **PR-3**: ship `recoverStuckERC20` + `disown` + EIP-712 verifier.
  Recovery cap `max(0, balanceOf - tracked)` is now correct because
  the counter is comprehensive.
- **PR-4**: frontend `/recover` page + Advanced User Guide deep-link
  + escrow-address redaction (the redaction part already shipped on
  2026-05-03).
- **PR-5**: post-deploy analytics labeling per
  `docs/ops/AnalyticsLabelRegistration.md`.

The escrow-address redaction + Asset Viewer + receiver-hook hardening
that shipped on 2026-05-03 + the counter chokepoint that shipped today
together complete the "user-facing escrow surface is locked down,
and protocol-managed balance is structurally tracked" milestone.
The recovery flow itself is the only remaining piece of the security-
audit thread.

---

## T-054 PR-2 — Staking-checkpoint min-clamp (pre-live build)

Because the protocol is still pre-live, no legacy escrow state
needs to be preserved across the T-051 chokepoint refactor. PR-2
collapses to its core security improvement — clamp the
yield-bearing VPFI balance against the protocol-tracked counter so
unsolicited dust doesn't earn staking rewards or inflate the
fee-discount tier.

### What changed

`LibVPFIDiscount.clampToTracked(actualBal, trackedAfter)` is the
new pure helper — returns the smaller of the two. Plumbed through
every staking-checkpoint and discount-accumulator call site:

- **`VPFIDiscountFacet._prepareDeposit`** (deposit path) — clamp
  on `prevBal + amount` vs `prevTracked + amount`.
- **`VPFIDiscountFacet.withdrawVPFIFromEscrow`** (unstake path) —
  clamp on `prevBal - amount` vs `prevTracked - amount`.
- **`LibVPFIDiscount.tryApplyBorrowerLif`** — borrower-side LIF
  custody pull. Both the `updateUser` and the post-withdraw
  `rollupUserDiscount` consume the clamped value.
- **`LibVPFIDiscount.tryApplyYieldFee`** — lender-side yield-fee
  pull. Pre-rollup, post-checkpoint, post-rollup all use the
  clamped value computed from current storage.
- **`LibVPFIDiscount.settleBorrowerLifProper`** — settlement-time
  rollup at the snapshot read.

For every legitimate flow post-T-051 the clamp is a no-op (actual
balance and tracked counter track each other). Where direct
`IERC20.transfer` dust inflates the actual balance, the tracked
side is unchanged and the clamp excludes the dust.

Two new internal helpers in `LibVPFIDiscount`:
- `trackedVPFIBalance(user)` — symmetric mirror of
  `escrowVPFIBalance(user)`.
- `clampToTracked(actualBalance, trackedAfter)` — pure min.

### What was deliberately NOT shipped

A bootstrap-style admin function that installed counter values for
legacy obligations would ONLY be needed for upgrades over a
pre-counter contract that already had real positions in escrow.
The protocol is pre-live, so there's no legacy state to migrate —
every existing testnet position can be drained and re-deposited on
the upgrade if it's not already counter-tracked. The earlier
"backfill mechanism" sketch (bootstrap function + Foundry
migration script + 5 dedicated tests) was reverted before landing
because it added 100+ lines of contract surface and a separate
script for a use case the pre-live build doesn't have.

If a future mainnet-to-mainnet upgrade ever needs this kind of
backfill, the pattern is straightforward to add at that point —
the storage shape is already there, the chokepoint already
enforces the invariant, and the helper just needs an
admin-gated setter that respects the idempotency rule (only
write when current value is zero).

### Verification

- Full no-invariants regression: **1596 passing / 0 failed / 5 skipped**.
- `forge build` clean.
- ABIs re-exported (frontend + keeper-bot).

### Where this leaves T-054

```
✓ PR-1 (2026-05-03 + 2026-05-04 morning) — Storage + chokepoint refactor + counter + min-display
✓ PR-2 (this entry)                       — Staking-checkpoint min-clamp
  PR-3                                    — recoverStuckERC20 + disown + EIP-712 verifier
  PR-4                                    — frontend /recover page + Advanced User Guide section
  PR-5                                    — post-deploy analytics labeling
```

PR-3 is now unblocked — the counter is comprehensive (every
deposit / withdrawal site routes through the chokepoint) and the
yield-bearing balance is clamped, so the recovery cap formula
`max(0, balanceOf - tracked)` is structurally correct.

---

## T-054 PR-3 — Stuck-ERC20 recovery flow

The recovery contract surface is in. ERC-20 tokens that landed in a
user's escrow proxy via direct `IERC20.transfer` (outside the
protocol's deposit flow — copy-paste accidents from a CEX
withdrawal, dust attacks, etc.) now have a clean exit path that
structurally cannot reach into protocol-managed collateral / claims
/ stake.

### `EscrowFactoryFacet.recoverStuckERC20(token, declaredSource, amount, deadline, signature)`

User-facing entry point. Pulls `amount` of `token` from the user's
escrow proxy back to the user's EOA. Recipient is hardcoded — no
caller-supplied recipient parameter. Properties:

- **Cap = `max(0, balanceOf(escrow, token) - protocolTrackedEscrowBalance[user][token])`.**
  The arithmetic is the load-bearing safety property — recovery
  cannot drain protocol-managed balance no matter what other check
  is bypassed.
- **EIP-712 acknowledgment** with replay protection. The user signs
  a typed-data payload bound to the diamond + chainId; the contract
  consumes a per-user nonce on success so the same signature can't
  be re-submitted.
- **Sanctions oracle check on `declaredSource`.** Three outcomes:
  - **Source clean** → recovery succeeds, tokens return to EOA,
    nonce bumps.
  - **Source flagged** → escrow gets BANNED (state writes commit;
    the function returns rather than reverts so the ban persists).
    Tokens stay in escrow. The ban is source-tracked, not
    persistent: it auto-unlocks if the source is later de-listed
    from the oracle. Same Tier-1 / Tier-2 sanctioned-address
    semantics the protocol already enforces — Tier-1 entry points
    revert, Tier-2 close-outs (repay, mark default, etc.) stay
    open so unflagged counterparties can be made whole.
  - **Oracle unset / oracle reverts** → fail-safe revert
    (`SanctionsOracleUnavailable`). Recovery refuses to proceed
    until the oracle is reachable.
- **EIP-712 ack-text hash.** The signed payload includes a
  `keccak256` of the canonical warning text the user sees on the
  recovery page. A future change to the wording bumps the constant
  and invalidates old signatures — historical signatures can't be
  used against new warning text.

### `EscrowFactoryFacet.disown(token)`

Event-only. Emits `TokenDisowned(user, token, observedAmount,
blockNumber)` with no state change. Used as a public on-chain
assertion in compliance disputes ("the dust isn't mine and I never
touched it"). Not sanctions-gated — even a banned escrow can call
disown because the action is purely informational.

### Sanctions semantics extension

`LibVaipakam.isSanctionedAddress(who)` now checks `escrowBannedSource[who]`
in addition to the direct oracle lookup. When the field is non-zero,
the function delegates the question to the source's CURRENT oracle
status — so banning a user via recovery doesn't write a permanent
flag, it just records "treat this user as sanctioned for as long as
the source they declared IS sanctioned." Auto-unlock is implicit in
the oracle-delegation pattern; no separate clear-ban admin path is
needed.

### Discoverability gating (deferred to PR-4)

The recovery flow is intentionally narrow: a user who got dust-
poisoned by a third party should NOT trip the sanctions ban by
accidentally clicking "recover" on dust they didn't send. PR-4 will
hide the recovery page from the main UI entirely — only reachable
via a deep link from the Advanced User Guide section, with
`<meta name="robots" content="noindex,nofollow">` and a "type
CONFIRM" modal in front of the wallet popup. The contract itself
doesn't enforce discovery — the policy is at the frontend layer.

### Storage additions

- `mapping(address => uint256) recoveryNonce` — per-user EIP-712
  replay-protection nonce.
- `mapping(address => address) escrowBannedSource` — per-user
  source-tracked recovery ban marker. Zero means no ban.

### New errors

`RecoveryAmountExceedsUnsolicited`, `RecoveryAmountZero`,
`RecoveryDeadlineExpired`, `RecoverySignatureInvalid`,
`RecoveryUserHasNoEscrow`, `EscrowBannedDueToSanctionedSource`
(unused in current design — kept for explicit-revert variants),
`SanctionsOracleUnavailable`, `EscrowAlreadyBanned`.

### New events

- `StuckERC20Recovered(user, token, declaredSource, amount, nonce)`
  — happy-path recovery completed.
- `EscrowBannedFromRecoveryAttempt(user, token, declaredSource, amount)`
  — recovery flow concluded with the ban-as-outcome (source
  flagged, tokens stayed).
- `TokenDisowned(user, token, observedAmount, blockNumber)` —
  user formally disowns unsolicited token balance without
  recovering it.

### Verification

- 17 new tests in `EscrowRecoveryTest.t.sol` covering: happy path
  (clean source); partial-amount recovery; cap enforcement
  (amount exceeds unsolicited; cannot touch protocol-tracked);
  sanctioned-source ban-as-outcome (no revert, ban persists,
  nonce bumps); auto-unlock when source de-listed; banned escrow
  cannot recover further; replay protection (nonce mismatch);
  expired deadline; bad signature; zero amount; user has no
  escrow; oracle unset; oracle reverts; disown happy path; disown
  with no escrow; disown with no unsolicited dust.
- Full no-invariants regression: **1613 passing / 0 failed / 5 skipped**
  (up from 1596; net +17 from new tests).
- `forge build` clean.
- ABIs re-exported (frontend + keeper-bot).

### What's next (T-054 PR-4)

Frontend `/recover` page + Advanced User Guide section. The
contract surface is complete; PR-4 wires the user-facing UX:

- New page at `/recover` (`noindex, nofollow`).
- Form: token contract + declared source + amount.
- "Type CONFIRM" modal pre-empting the wallet popup.
- EIP-712 payload construction matching the on-chain digest
  (frontend reads `recoveryDomainSeparator()` + `recoveryAckTextHash()`
  + `recoveryNonce(user)` to populate fields).
- Wallet shows the structured message; user signs.
- Tx submission with the signature embedded in calldata.
- Success surface: "X tokens returned to your wallet."
- Banned surface: "Your escrow has been locked under our sanctions
  policy because the declared source is on the sanctions list.
  The lock auto-lifts if the source is removed from the oracle."

Reachable only via a deep link from a new "Stuck-token recovery"
section in the Advanced User Guide.

### Where this leaves T-054

```
✓ PR-1 — Storage + chokepoint refactor + counter + min-display
✓ PR-2 — Staking-checkpoint min-clamp
✓ PR-3 — recoverStuckERC20 + disown + EIP-712 verifier (earlier today)
✓ PR-4 — frontend /recover page + Advanced User Guide section (this entry)
  PR-5 — post-deploy analytics labeling
```

---

## T-054 PR-4 — Frontend recovery page

The user-facing surface for the recovery flow is in. A new page at
`/app/recover` collects a token + declared source + amount, gates
the wallet popup behind a "type CONFIRM" modal, signs the EIP-712
acknowledgment, submits the transaction, and surfaces one of three
outcomes: success / banned / error.

### Discoverability gating (per design)

The page is **NOT** linked from anywhere in the main app navigation
— not the sidebar, not the Asset Viewer, not the Dashboard, not the
Basic User Guide, not the FAQ, not the Footer. The only entry path
is a deep link from a new "Stuck-Token Recovery" section in the
**Advanced** User Guide, after the user has read explanations of:

- What "stuck token" means (and the two ways tokens get stuck —
  user mistake vs third-party dust attack)
- Taint poisoning and why it's not Vaipakam's concern internally
- When NOT to recover (key insight: don't recover dust you didn't
  send — declaring a sanctioned source locks your escrow)
- When TO recover (you sent it yourself, you control the source)
- The recovery flow steps
- The `disown` event-only function for compliance audit trail

The page itself injects `<meta name="robots" content="noindex,nofollow">`
on mount and removes it on unmount, so the URL doesn't get indexed
by search engines. The Asset Viewer still does NOT show the
recovery option even when unsolicited dust is present — by design,
to avoid tempting naive users.

### Page UX

| Section | Behaviour |
|---|---|
| Token contract input | Live-resolves symbol + decimals + computes `unsolicited = max(0, balanceOf(escrow) - tracked)` and shows max-recoverable hint |
| Source address input | Plain hex; small caption explains it must be a wallet the user controls |
| Amount input | Typed with token decimals; Review button disabled until amount ≤ unsolicited |
| Standing warning panel | Three-bullet warning visible always: sanctions consequence, hardcoded recipient, don't recover what you didn't send |
| Review modal | Shows declared values, full warning text, "type CONFIRM" gate to enable Sign button |
| Sign step | Reads live `recoveryNonce(user)` + `recoveryAckTextHash()` from the contract; constructs EIP-712 typed-data via wagmi's `signTypedData`; matches the on-chain `RECOVERY_TYPEHASH` exactly |
| Submit + receipt | Submits the recovery tx; awaits receipt; decodes events from logs to determine outcome |
| Success surface | Green panel with amount + symbol + tx-explorer link |
| Banned surface | Red panel with the declared source + auto-unlock explanation + tx-explorer link |
| Error surface | Generic panel with the wallet/RPC error message; "Try again" button to retry |

### Outcome detection from event logs

The contract's recovery function does NOT revert on the sanctioned-
source path — it returns successfully so the ban-state writes
persist. The frontend distinguishes outcomes by inspecting which
event was emitted in the receipt:

- `StuckERC20Recovered` → success path
- `EscrowBannedFromRecoveryAttempt` → ban-as-outcome path

Both events carry the same `(user, token, declaredSource)` indexed
topics, so the decoder differentiates by `eventName` only. Logs
emitted by addresses other than the diamond are skipped.

### Routing

Route added inside `<AppLayout>` at `app/recover` so the user keeps
the standard app shell (sidebar, top bar, wallet menu). Despite the
shell, the page is intentionally not surfaced in the sidebar nav.

### i18n

`escrowRecover.*` group propagated across all 10 locales
(en/ar/de/es/fr/hi/ja/ko/ta/zh). Translations are best-effort
native phrasings — the EN keys carry the load-bearing meaning
(particularly the warning copy that gates the user's understanding
of the sanctions consequence). Pre-launch the protocol can refine
these with native reviewers without changing any code.

### Verification

- New page: [`frontend/src/pages/EscrowRecover.tsx`](frontend/src/pages/EscrowRecover.tsx).
- Wired into routing: [`frontend/src/App.tsx`](frontend/src/App.tsx) at `/app/recover`.
- Advanced User Guide section appended:
  [`frontend/src/content/userguide/Advanced.en.md`](frontend/src/content/userguide/Advanced.en.md).
- i18n: `escrowRecover.*` group in 10 locale files.
- Frontend `tsc -b --noEmit` clean.

### What's still EN-only

The Advanced User Guide markdown was extended in English only. The 9
non-EN locale variants (`Advanced.{ar,de,es,fr,hi,ja,ko,ta,zh}.md`)
fall back to English for the new "Stuck-Token Recovery" section
until translated. Pre-launch can absorb this; post-launch the
section can be translated alongside any other UG content updates.

### Where this leaves T-054

```
✓ PR-1 — Storage + chokepoint refactor + counter + min-display
✓ PR-2 — Staking-checkpoint min-clamp
✓ PR-3 — recoverStuckERC20 + disown + EIP-712 verifier
✓ PR-4 — frontend /recover page + Advanced User Guide section (this entry)
  PR-5 — post-deploy analytics labeling
```

T-054 is functionally complete. PR-5 is operational (label-
submission to Chainalysis / TRM Labs / Elliptic / Etherscan /
Arkham + verification on the deploy chains) — captured in the
existing `docs/ops/AnalyticsLabelRegistration.md` runbook, not a
code PR.

---

## "Vaipakam Vaults" — user-facing rename

Per user direction, every user-facing reference to "escrow" rebrands to
**"Vaipakam Vaults"** (plural, general audience) or **"Your Vaipakam Vault"**
(singular, addressed to the connected user). Code-level identifiers stay
"escrow" — the rename is a pure-string change, no Solidity / TypeScript /
ABI reshape.

### Rules applied

| Surface | Naming |
|---|---|
| Individual user pages (Dashboard, Asset Viewer, Recovery, etc.) | "Your Vaipakam Vault" |
| General audience (User Guide, Whitepaper, Overview, Hero, Features, FAQ) | "Vaipakam Vaults" / "vault" in body prose |
| Etherscan public tag (implementation contract) | `Vaipakam Vaults` (yields `Implementation: Vaipakam Vaults` on every per-user proxy) |
| Solidity contracts / events / errors | **stays "escrow"** (`EscrowFactoryFacet`, `escrowDepositERC20`, `s.userVaipakamEscrows`, etc.) |
| TypeScript hooks / file names | **stays "escrow"** (`useUserEscrowAddress`, `EscrowAssets.tsx`, `EscrowRecover.tsx`) |
| CSS classes / DOM ids / route URLs | **stays "escrow"** (`/app/escrow`, `/app/recover` URLs unchanged) |
| Code-fenced identifiers in docs (`<c>EscrowFactoryFacet</c>`, `` `EscrowFactoryFacet` ``) | **preserved** — these reference the Solidity contract |

### What changed

| Surface | Files touched |
|---|---|
| **i18n** | All 10 locale files (`en/ar/de/es/fr/hi/ja/ko/ta/zh.json`) — three-pass rename: word-boundary EN rules, locale-specific term replacements (e.g. `حساب محتجز` → `مخزن`, `Ihr Escrow` → `Ihr Vaipakam Vault`, `あなたのエスクロー` → `あなたの Vaipakam Vault`), then a no-boundary safe-replace pass with code-identifier protection for CJK / Indic / Arabic locales where `\b` doesn't anchor between Latin "Escrow" and the local script. |
| **User Guide markdown** | `Basic.{en,ar,de,es,fr,hi,ja,ko,ta,zh}.md` + `Advanced.{en,ar,de,es,fr,hi,ja,ko,ta,zh}.md` — all 20 files. The new "Stuck-Token Recovery" section that landed earlier today now reads in the renamed terminology. |
| **Whitepaper** | `Whitepaper.en.md` (whitepaper is EN-only). |
| **Overview** | All 10 `Overview.*.md` files. |
| **Frontend components** | `Activity.tsx` (event labels), `LoanDetails.tsx` (inline copy), `OfferBook.tsx` (4 inline strings), `BuyVPFI.tsx` (1 inline string), `NftVerifier.tsx` (1 inline label). |
| **Operational runbook** | `docs/ops/AnalyticsLabelRegistration.md` — Etherscan tag suggestion now reads `Vaipakam Vaults`, plus a paragraph explaining the chosen naming yields the cleanest possible display on per-user proxy pages: "Implementation: Vaipakam Vaults" rather than the redundant "Implementation: Vaipakam Vaults Implementation" alternative. |

### Etherscan display

The implementation contract gets the public tag **`Vaipakam Vaults`**. Etherscan's
proxy-detection feature renders `Implementation: <addr> [Vaipakam Vaults]` on every
per-user proxy that points at it — matching the user's preferred display shape.
The same tag also surfaces as just `Vaipakam Vaults` when someone lands directly on
the implementation contract page.

We can't strip Etherscan's hardcoded "Implementation:" prefix on proxy pages — it's
not a per-tag attribute. Per-instance proxy tagging would need manual one-off
submissions and Etherscan has no API for it. The auto-relationship display via the
implementation slot is the practical maximum.

### Verification

- All `[Ee]scrow` references in non-EN locale JSONs are now either:
  (a) code identifiers like `EscrowFactoryFacet` (preserved by the safe-replace's
  CamelCase-protector regex), or (b) eliminated.
- Spot-check on `dashboard.yourEscrow`, `appNav.escrow`, `escrowAssets.pageTitle`,
  `dashboard.escrowAddress` confirms the rename across all 10 locales:
  `Your Vaipakam Vault` (with locale-appropriate possessive — "Tu", "Ihr",
  "Votre", "あなたの", "您的", etc.).
- Frontend `tsc -b --noEmit` clean.
- The route `/app/escrow` stays unchanged; the displayed sidebar label now reads
  "Your Vaipakam Vault" (resolved from `appNav.escrow` i18n key).
- The recovery page route `/app/recover` is unaffected.
- No Solidity changes; `forge build` not re-run for this PR (no contract surface
  edits).

### What stays "escrow" deliberately

- `s.userVaipakamEscrows` storage mapping (already named with `Vaipakam`
  prefix; the rename inside Solidity is not part of this PR).
- `EscrowFactoryFacet` contract name (single point — renaming forces every
  cross-facet selector lookup to update; out of scope for a string-rename PR).
- `useUserEscrowAddress` / `useEscrowUpgrade` / `useEscrowRental` hooks (TS
  identifiers; renaming has no UX effect since the value flowing through
  is what's displayed).
- Page file names (`EscrowAssets.tsx`, `EscrowRecover.tsx`) — internal-only.
- Comments in code that reference internal architecture.
- CSS classes and `data-*` attributes.

These can be cleaned up in a future technical-debt PR if desired, but they
have no user-visible effect.
