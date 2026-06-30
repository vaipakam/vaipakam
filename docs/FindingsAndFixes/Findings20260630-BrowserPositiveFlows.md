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
