# Browser Positive Flow Findings - 2026-06-30

Scope: Chrome/CDP walkthrough against local Anvil `31337`, guided by `docs/TestScopes/PositiveFlowCoverage.md` and `docs/FunctionalSpecs/ProjectDetailsREADME.md`.

Captured artifacts live under `cdpwalkthrough/`.

## Walkthrough Summary

- PF-040 lender ERC-20 offer creation: passed end-to-end after minting mock assets.
- PF-090 borrower accepts lender ERC-20 offer: passed on-chain after funding borrower collateral.
- Post-loan read surfaces: failed to reflect the active loan consistently.

Local assets/accounts used:

- Diamond: `0xB0D4afd8879eD9F52b28595d31B441D079B2Ca07`
- Lender: `0x90F79bf6EB2c4f870365E785982E1f101E93b906`
- Borrower: `0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65`
- mUSDC: `0x5c74c94173F05dA1720953407cbb920F3DF9f887`
- mWBTC: `0x720472c8ce72c2A2D711333e064ABD3E6BbEAdd3`

On-chain evidence:

- Offer create tx: `0x7b1e761f3ea54e71e7d09d7d7d7eae77f9dec0a3f239c0cf2193c4498680b7ca`
- Accept / loan-init tx: `0xe1da2cf40dd474320b12ed5e0d344e349256784e7aa95a8ace587d54ab6023fa`
- Borrower received `99.9 mUSDC` net proceeds and posted `150 mWBTC` collateral.

## Findings

### F-20260630-001: Accept review shows wrong principal economics

Status: open

Severity: high

Evidence:

- Offer Book row after create shows `100 mUSDC`: `cdpwalkthrough/pf-basic-08-offer-book-after-create.png`
- Accept review modal shows `Principal 10 mUSDC`, `Projected repayment 10.04 mUSDC`, `Loan Initiation Fee 0.01 mUSDC`, and `Net proceeds 9.99 mUSDC`: `cdpwalkthrough/pf-accept2-01-modal-open.png`
- Offer detail direct-chain read also shows `Principal 10 mUSDC` even though the create row and settlement used `100 mUSDC`: `cdpwalkthrough/pf-postloan-connected-05-offer-details.png`
- On-chain settlement actually delivered about `99.9 mUSDC` to borrower.

Why it matters:

The spec requires the accept preview to match the economics that acceptance executes. This is a signing-safety issue because the modal is the last user review surface before accepting the loan.

Suggested fix:

Audit offer-detail and accept-review formatting for token decimals and offer amount source. The direct offer detail read and accept modal are likely formatting a raw offer amount with the wrong decimal scale while the Offer Book row and actual accept path use the correct raw amount.

### F-20260630-002: Create-offer simulation reports revert while the transaction succeeds

Status: open

Severity: high

Evidence:

- Before submission, the create form showed: `This transaction would revert: Execution reverted with reason: custom error 0xfb8f41b2...`
- The same filled form then created the offer successfully: `cdpwalkthrough/pf-basic-06-after-create-click-3s.png`

Why it matters:

A false-negative simulation teaches users to ignore preflight warnings. It also conflicts with the successful write path.

Suggested fix:

Make the simulation use the same final payload, allowance assumptions, and sender context as the actual submit path. Decode `0xfb8f41b2` if it is still reachable, and keep the create button disabled only when the simulation result is trustworthy.

### F-20260630-003: Permit2 accept path submits/reverts before falling back

Status: open

Severity: medium-high

Evidence:

- Console captured: `Permit2 accept failed, falling back to classic: Transaction reverted on-chain ... Tx 0xdcfaa823... mined but did not succeed`
- Classic fallback then succeeded and opened the loan.

Why it matters:

If this occurs in a real wallet, the user may sign a transaction that reverts before the app silently tries the classic path. That is confusing and can cost gas.

Suggested fix:

Gate Permit2 accept with a read-only preflight that reliably detects unsupported/reverting Permit2 paths before asking the wallet to submit. Prefer classic accept directly when Permit2 is unavailable on Anvil/local mocks.

### F-20260630-004: Post-loan read surfaces do not show the active loan

Status: open

Severity: high

Evidence:

- Offer details correctly show Offer `#1` as `Filled`: `cdpwalkthrough/pf-postloan-connected-05-offer-details.png`
- Dashboard still shows `0 Active Loans` and `No Loans Yet`: `cdpwalkthrough/pf-postloan-connected-01-dashboard.png`
- Activity shows `No on-chain activity yet`: `cdpwalkthrough/pf-postloan-connected-02-activity.png`
- `/loans/1` shows `Loan Not Found`: `cdpwalkthrough/pf-postloan-connected-04-loan-details.png`
- Diagnostics drawer shows repeated `LOG-INDEX loadLoanIndex FAILURE scan-events`: `logIndex scan skipped: chain config not resolved (deployBlock=0, diamond=0xB0D4...Ca07). Likely a missing VITE_DEFAULT_CHAIN_ID / deployments.json mismatch in this build — reload to the latest bundle. Scanning from genesis would rate-limit the RPC.`
- Diagnostics drawer shows `LOAN-VIEW getLoanDetails FAILURE read · loan #1`: `Number "354506025007866000451621705862825872723932854195n" is not in safe integer range (-9007199254740991 to 9007199254740991)`.
- Diagnostics drawer shows `LOAN-VIEW getLoanCollateralLien FAILURE read · loan #1`: `Function not available on this contract deployment (facet may not be cut in).`
- Diagnostic capture: `cdpwalkthrough/pf-diagnostics-02-drawer-open.png` and `cdpwalkthrough/pf-diagnostics-02-drawer-open.json`.

Why it matters:

The user completes the loan-initiation flow but cannot see or manage the loan from the main surfaces. This blocks follow-on PF-110/PF-112/PF-113 style repayment and claim journeys.

Suggested fix:

Trace the local Anvil fallback index/read path after `OfferAccepted` / loan initiation. The diagnostics point to at least three concrete blockers: local chain config/deployment metadata resolution is failing, `getLoanDetails` response normalization is attempting a JavaScript safe-integer conversion on a large address-like bigint, and the collateral-lien read is calling a function absent from this Anvil deployment.

### F-20260630-005: Console repeatedly calls Ethereum public RPC while on Anvil

Status: open

Severity: medium

Evidence:

- Repeated console errors in `cdpwalkthrough/pf-basic-console.json`, `pf-accept2-console.json`, and `pf-postloan-connected-console.json`:
  `Access to fetch at 'https://eth.llamarpc.com/' from origin 'http://localhost:5173' has been blocked by CORS policy`

Why it matters:

The app is connected to Anvil Local Testnet, but still probes a public Ethereum RPC endpoint. This creates noisy console errors and can mask real wallet/chain failures.

Suggested fix:

Review wagmi/public-client transport setup so unused/default mainnet transports are not initialized for local Anvil pages, or ensure those reads are not browser-CORS-blocked.

### F-20260630-006: Cookie banner interferes with transaction walkthroughs

Status: open

Severity: low-medium

Evidence:

- The cookie banner appears over connected protocol screens and puts `Accept all` before the offer `Accept` action in DOM/button traversal: `cdpwalkthrough/pf-accept-03-borrower-offers.png`

Why it matters:

It is easy for browser automation, keyboard users, or rushed users to hit the cookie action instead of the protocol action. It also adds noise to every captured transaction screen until dismissed.

Suggested fix:

Consider making the cookie banner less intrusive on connected app transaction pages, or ensure primary protocol CTAs remain visually and semantically dominant.

### F-20260630-007: Protocol config bundle decode fails on local deployment

Status: open

Severity: medium-high

Evidence:

- Diagnostics drawer repeatedly shows `CONFIG useProtocolConfig FAILURE getProtocolConfigBundle`.
- Error text: `Bytes value "9,96" is not a valid boolean. The bytes array must contain a single byte of either a 0 or 1 value.`
- Diagnostic capture: `cdpwalkthrough/pf-diagnostics-02-drawer-open.png` and `cdpwalkthrough/pf-diagnostics-02-drawer-open.json`.

Why it matters:

Several Create Offer, Dashboard, fee, discount, and lifecycle surfaces depend on live protocol config. A decode mismatch can lead to fallback defaults, false warnings, disabled controls, or inconsistent copy.

Suggested fix:

Compare the frontend ABI/type expected by `useProtocolConfig()` with the currently deployed `getProtocolConfigBundle()` return tuple in the Anvil diamond. This looks like ABI drift or tuple field ordering/type drift where bytes are being decoded as a boolean.

## Screenshots Of Key States

- Create offer ready: `cdpwalkthrough/pf-basic-05-consented-ready.png`
- Create offer success: `cdpwalkthrough/pf-basic-06-after-create-click-3s.png`
- Offer Book after create: `cdpwalkthrough/pf-basic-08-offer-book-after-create.png`
- Borrower sees accept action: `cdpwalkthrough/pf-accept-03-borrower-offers.png`
- Accept review modal: `cdpwalkthrough/pf-accept2-01-modal-open.png`
- Accept submitted / open book empty: `cdpwalkthrough/pf-accept2-04-after-confirm-17s.png`
- Dashboard after loan: `cdpwalkthrough/pf-postloan-connected-01-dashboard.png`
- Activity after loan: `cdpwalkthrough/pf-postloan-connected-02-activity.png`
- Loan details after loan: `cdpwalkthrough/pf-postloan-connected-04-loan-details.png`
- Offer details after loan: `cdpwalkthrough/pf-postloan-connected-05-offer-details.png`
- Diagnostics drawer: `cdpwalkthrough/pf-diagnostics-02-drawer-open.png`

## Resolution — #833 (frontend) + #780 (accept-offer gas messaging)

Root-cause triage split these findings into two classes: **genuine frontend
bugs** (fixed in code) and **stale local Anvil deployment** artifacts (the
walkthrough ran against an Anvil diamond built from older contracts than the
frontend ABIs; the current `src/` ABI matches the shipped frontend ABI, and the
Base/Arb/BNB testnets — freshly deployed from current contracts — decode
cleanly). The latter are resolved by redeploying the local Anvil diamond from
current contracts, not by frontend workarounds (which would mask a contract
that no longer exists).

| Finding | Class | Resolution |
| --- | --- | --- |
| **F-001** accept/detail economics (10 vs 100 mUSDC) | frontend bug | **Fixed.** New pure `offerHeadline()` helper (`apps/defi/src/lib/offerHeadline.ts`) applies the #183 canonical role-aware mapping (lender ERC-20 → `amountMax`/`interestRateBps`; borrower → `amount`/`interestRateBpsMax`; NFT → `amount`/`interestRateBps`) — the same endpoints `useAcceptTermsSigning` and the Offer Book row use. Wired into `AcceptReviewModal` (principal, projected repayment, LIF, net proceeds, rate) and `OfferDetails` (principal, rate). Unit-tested. |
| **F-002** create-offer sim false-revert | frontend bug | **Fixed.** `useTxSimulation` gained an opt-in `allowAllowanceRevert` flag + benign `approval-needed` verdict; the create-offer preview sets it, so the pre-approval `ERC20InsufficientAllowance` (0xfb8f41b2) shows "Token approval required first" instead of an alarming "would revert". |
| **F-003** Permit2 submits a doomed tx before fallback | frontend bug | **Fixed.** A read-only `publicClient.call` preflight now runs the `acceptOfferWithPermit` calldata before the wallet broadcast; on revert it falls through to the classic path without ever prompting a doomed on-chain send. |
| **F-004** post-loan reads not visible (log-index deployBlock=0) | frontend robustness | **Fixed** for the local case: the log-index scan no longer bails when `deployBlock ≤ 0` on chain 31337 (a genesis scan is cheap on a local node) — it clamps to genesis and scans. (The `getLoanDetails` bigint + `getLoanCollateralLien`-missing sub-items are stale-Anvil — see below.) |
| **F-005** llamarpc CORS on Anvil | frontend bug | **Fixed.** `useEnsName` skips ENS resolution entirely on chain 31337, so no mainnet public-RPC probe fires on local Anvil. |
| **F-006** cookie banner over protocol CTAs | frontend UX | **Fixed.** Consent banner `z-index` lowered 9500 → 999 so transaction review modals (z-index 1000, full-screen backdrop) cover it — the "Accept all" no longer precedes the protocol "Accept". |
| **F-007** `getProtocolConfigBundle` bool-decode | **stale Anvil** | The current `ConfigFacet.getProtocolConfigBundle` returns 15 fields (…`maxOfferDurationDays`), matching the frontend ABI; the walkthrough's Anvil diamond predated `maxOfferDurationDays`, so a 14-field response mis-decoded against the 15-field ABI. **Resolved by redeploying Anvil from current contracts.** No frontend change. |
| F-004 `getLoanDetails` bigint safe-integer throw | **stale Anvil** | Same cause class — the stale Anvil `getLoanDetails` tuple shape no longer matches the current ABI, so an address-holding slot decoded into a small-int field. Resolved by fresh Anvil redeploy. |
| F-004 `getLoanCollateralLien` "function not available" | **stale Anvil** | `MetricsFacet.getLoanCollateralLien` isn't cut into the stale Anvil diamond. Already degrades gracefully (lien → null, single diagnostic; no hard failure). Resolved by fresh Anvil redeploy that cuts the current facet set. |

**#780** (historical `acceptOffer` "exceeds max transaction gas limit"): the
historical trace shows the pre-typed-terms 2-arg `acceptOffer(uint256,bool)`
call shape — a stale ABI against a diamond that had moved on, which is exactly
the estimateGas-fallback failure mode. The current typed
`acceptOffer(uint256,AcceptTerms,bytes)` flow already runs `ensureAllowance`
before the write (the direct mitigation), and F-003's Permit2 preflight removes
the other doomed-tx path. As the remaining preflight-messaging deliverable,
`decodeContractError` now recognises the "exceeds max transaction gas limit"
phrase and, when no concrete revert selector is decodable, rewrites it to
explain it is usually an approval/stale-ABI artefact rather than a real gas
shortage — so users can tell a gas cap from a true revert. Unit-tested.

**Remaining validation**: a fresh-Anvil browser re-walkthrough of the
create → accept → post-loan flow is the gold-standard confirmation for the
stale-Anvil subset (F-007 + the two F-004 decode sub-items) and for the
end-to-end visibility criterion; the frontend code fixes above are covered by
typecheck + unit tests.
