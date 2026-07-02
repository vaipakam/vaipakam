## Thread — Anvil positive-flow UX + accept-offer gas messaging (PR #833 / #780)

A Chrome/CDP walkthrough of the basic local-Anvil lend/borrow flow surfaced a
cluster of frontend rough edges. Triage split them into genuine app bugs (fixed
here) and stale-local-deployment artifacts (the walkthrough ran against an Anvil
diamond built from older contracts than the app's ABIs — those decode errors
resolve by redeploying Anvil, not by app changes, since the current contracts
match the shipped ABIs and every live testnet decodes cleanly).

Fixed in the app:

- **Signing-safety: the accept review and offer-detail views now show the real
  economics.** A lender ERC-20 offer's headline principal is its max-provide
  amount (what accepting actually locks), but two surfaces were reading the
  offer's minimum-partial-fill field — showing, e.g., 10 mUSDC where the loan
  settles 100. A single shared role-aware helper now feeds the principal, rate,
  projected repayment, initiation fee and net-proceeds everywhere, so the last
  screen before signing matches what executes.
- **The create-offer preflight stops crying wolf.** It previously flashed "this
  transaction would revert" because it simulated before the token approval the
  submit path grants first. It now recognises that specific allowance case and
  shows a calm "token approval required first" note instead.
- **The Permit2 accept path no longer asks the wallet to submit a doomed
  transaction.** A free read-only preflight runs first; if Permit2 isn't usable
  on the chain, the app falls straight through to the classic path without
  spending gas on a reverting send.
- **Local-Anvil loan visibility.** The event-index scan no longer refuses to run
  when the local deploy block is unresolved (harmless on a local node), so a
  freshly opened loan shows up on the Dashboard/Activity/loan surfaces in local
  mode.
- **No more mainnet-RPC CORS noise on Anvil.** ENS name resolution is skipped on
  the local chain, so the console isn't flooded with cross-origin errors that
  masked real failures.
- **The cookie banner no longer overlaps transaction dialogs.** Its stacking
  order was lowered so a review modal's backdrop covers it — the "Accept all"
  button can't sit in front of the protocol "Accept".

Accept-offer gas messaging (#780): the historical "exceeds max transaction gas
limit" failure was an old two-argument accept call shape against a contract that
had moved on — the classic estimateGas-fallback artefact. The current typed
accept flow already approves before writing, and the Permit2 preflight above
removes the other doomed-send path. As the remaining piece, the shared error
decoder now recognises that gas-cap phrase and, when it can't decode a real
revert, explains it is usually an approval or stale-build issue rather than a
true gas shortage — so users can tell the two apart.

Stale-Anvil items (protocol-config bundle decode, a loan-detail number-range
decode, and a missing collateral-lien view) are resolved by redeploying the
local Anvil diamond from current contracts; a fresh-Anvil browser
re-walkthrough is the remaining validation for that subset and for end-to-end
loan visibility. The app fixes above are covered by typecheck + unit tests.

Closes #833. Closes #780.
