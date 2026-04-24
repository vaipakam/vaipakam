/**
 * Normalises the grab-bag of error shapes thrown by ethers + injected wallets
 * into a single user-facing string. Order of precedence:
 *
 *   1. `reason`   — ethers decodes this from the revert data for named errors.
 *   2. `shortMessage` — ethers v6 fallback when reason isn't available.
 *   3. `data.message` — some wallets nest the RPC error under `data`.
 *   4. `message`  — last resort; raw JS Error text.
 *   5. `fallback` — caller-supplied default when nothing above is present.
 *
 * Keep this tight: pages should not need to reach into `err?.reason || ...`
 * ladders at the call site anymore.
 */

interface DecodableError {
  reason?: string;
  shortMessage?: string;
  message?: string;
  data?: string | { message?: string; data?: string };
  info?: { error?: { data?: string; message?: string } };
  error?: { data?: string; message?: string };
  revert?: { data?: string; name?: string; args?: unknown[] };
}

/**
 * Human-friendly, user-facing messages for known revert selectors. Falls back
 * to the raw selector name when no friendly copy is defined.
 */
const FRIENDLY_ERROR_MESSAGES: Record<string, string> = {
  // ── ERC-20 (OpenZeppelin) ─────────────────────────────────────────────
  '0xe450d38c':
    'Insufficient token balance. Your wallet does not hold enough of the token for this amount.',
  '0xfb8f41b2':
    'Insufficient token allowance. Approve the token for the required amount and try again.',
  '0x94280d62': 'Invalid sender address for the token transfer.',
  '0xec442f05': 'Invalid recipient address for the token transfer.',

  // ── ERC-721 (LibERC721 / OpenZeppelin-style) ──────────────────────────
  '0x89c62b64': 'Invalid NFT owner.',
  '0x7e273289': 'This NFT does not exist.',
  '0x64283d7b': 'You do not own this NFT.',
  '0x73c6ac6e': 'Invalid sender for NFT transfer.',
  '0x64a0ae92': 'Invalid recipient for NFT transfer.',
  '0x177e802f': 'NFT approval missing — approve the NFT first.',

  // ── Offer lifecycle ───────────────────────────────────────────────────
  '0x7fa19075': 'Invalid offer type — duration must be at least 1 day.',
  '0x2c5211c6': 'Invalid amount — the value must be greater than zero.',
  '0x23654b56': 'Invalid asset type.',
  '0x2ee39802': 'Offer not found or no longer valid.',
  '0x93f1b0b3': 'Offer has already been accepted.',
  '0xe8439f49': 'Only the creator of this offer can perform this action.',

  // ── Compliance / KYC ──────────────────────────────────────────────────
  '0x04a6799c':
    'Counterparty countries are not compatible (sanctions/compliance).',
  '0x83855724':
    'KYC required — complete verification for this transaction size before continuing.',
  '0xe522f8e6': 'Invalid country code.',
  '0x3a81d6fc': 'Country already registered — cannot change after initial set.',
  '0x5d061126': 'Invalid KYC thresholds (Tier0 must be below Tier1).',

  // ── Liquidity / illiquid consent ──────────────────────────────────────
  '0x0bb578c2':
    'Liquidity mismatch — one of the assets is illiquid and you have not consented to the illiquid-asset path.',
  '0x97fe4161':
    'Both parties must explicitly consent before an illiquid-asset offer can be accepted.',
  '0xb87a5be9':
    'One or more assets in this loan are illiquid. Both parties must consent to illiquid terms.',
  '0x96624a75': 'This asset is illiquid (no price feed or DEX pool).',

  // ── Oracle / price feed ───────────────────────────────────────────────
  '0xfb94c4ed':
    'No price feed found for this asset. The token may not be supported on this network.',
  '0x7d5a81eb': 'No DEX liquidity pool found for this asset.',
  '0x355e186c': 'Price data is stale — the oracle has not updated recently.',
  '0xbb55fd27': 'Insufficient on-chain liquidity for this asset.',

  // ── Risk / LTV / Health Factor ────────────────────────────────────────
  '0xc5af7001':
    'Loan-to-value ratio too high. Add more collateral or reduce the borrow amount.',
  '0x62e82dca':
    'Health factor too low. Add collateral to bring it above 1.5.',
  '0xfbfb1a44': 'LTV calculation failed — please retry.',
  '0xfa8b5b08': 'Health factor calculation failed — please retry.',
  '0x32549ba3': 'Health factor is not below the liquidation threshold.',
  '0x045f33d1': 'Invalid loan — loan not found or not in expected state.',
  '0xebb1e0ba': 'Loan has zero collateral.',

  // ── Loan lifecycle ────────────────────────────────────────────────────
  '0x082f7846': 'Loan is not active.',
  '0x8e0f1450': 'Loan is not in the required status for this action.',
  '0xcb1e8f38': 'Only the borrower can perform this action.',
  '0x8c380003': 'Only the lender can perform this action.',
  '0x4088c61c': 'You must own the position NFT to perform this action.',

  // ── Repayment ─────────────────────────────────────────────────────────
  '0xa6f27c4d':
    'Repayment window closed — the grace period has expired. The loan must be defaulted.',
  '0x2f93bdda':
    'Insufficient prepaid rental balance to cover the accrued fees.',
  '0xf9ee54f0':
    'Partial repayment amount is too small (below minimum threshold).',
  '0x1cd92a3c':
    'Daily deduction not yet due — wait until 24 hours have passed.',
  '0x426ad30d': 'This action only applies to NFT rental loans.',

  // ── Default ───────────────────────────────────────────────────────────
  '0xb79cb16c':
    'Loan has not defaulted yet — the grace period has not expired.',
  '0x05c4d8ac': 'Liquidation swap failed — please retry.',
  '0xe8775e4a':
    'Liquidation proceeds were insufficient to cover the loan.',

  // ── Preclose / obligation transfer ────────────────────────────────────
  '0x1fc326a5': 'Invalid new borrower address.',
  '0x944295c4':
    'Replacement offer terms do not meet lender-favorability requirements.',
  '0x3a23d825':
    'New borrower collateral is insufficient (must be ≥ original).',
  '0xcbc34ec5': 'Offset offer is not linked to this loan.',
  '0x2a69fdaf': 'Offset offer has not been accepted yet.',

  // ── Refinance ─────────────────────────────────────────────────────────
  '0xbfa0482c':
    'Invalid refinance offer — must be a borrower offer for the same asset.',
  '0x88be51dc': 'The borrower offer has not been accepted yet.',

  // ── Early withdrawal / loan sale ──────────────────────────────────────
  '0x910fb9b3':
    'Invalid sale offer — must be a lender offer for the same asset type.',
  '0xdce02f61':
    'Interest rate shortfall exceeds allowed limit for this loan sale.',
  '0x492a2b84': 'Sale offer is not linked to this loan.',
  '0x1f5d7665': 'Sale offer has not been accepted yet.',

  // ── Partial withdrawal ────────────────────────────────────────────────
  '0xfd7850ad':
    'Withdrawal amount exceeds the maximum allowed without breaching the health factor.',

  // ── Keeper / third-party execution ────────────────────────────────────
  '0x7583f2aa':
    'Keeper access required — you are not authorized to execute on behalf of this party.',
  '0xf7c08f1e': 'This keeper is already on your whitelist.',
  '0x8ebf27d0': 'This keeper is not on your whitelist.',
  '0x1a7025d1':
    'Keeper whitelist is full — remove an existing keeper before adding a new one.',

  // ── Treasury ──────────────────────────────────────────────────────────
  '0x1f2a2005': 'No treasury balance to claim for this asset.',

  // ── Escrow / NFT infrastructure ───────────────────────────────────────
  '0xb70f4664':
    'Position NFT mint failed — please retry. If it persists, contact support.',
  '0x6154d8fb': 'Position NFT burn failed — please retry.',
  '0xddb59ac0': 'NFT status update failed — please retry.',
  '0x4605c598': 'NFT transfer failed — please retry.',
  '0x667ecf9d': 'Escrow withdraw failed — please retry.',
  '0x650f4007': 'Escrow resolution failed — please retry.',
  '0x601d5b92': 'Escrow transfer failed — please retry.',
  '0x0e373cf8': 'Treasury transfer failed — please retry.',
  '0xb1fb1c95': 'NFT renter update failed — please retry.',
  '0xf367ddf6': 'Loan initiation failed — please retry.',
  '0xd52f4d8a': 'Offer creation failed — please retry.',
  '0x892d90b7': 'Offer acceptance failed — please retry.',
  '0xa9dea49f': 'Lender escrow resolution failed — please retry.',
  '0xe3afb2e8':
    'Could not resolve your user escrow. Try reconnecting your wallet or contact support.',
  '0x3f6cc768': 'Invalid NFT token ID.',
  '0xc24e5557': 'This position NFT has already been burned.',
  '0xe0e54ced': 'Invalid royalty configuration.',

  // ── Access control / authorization ────────────────────────────────────
  '0xea8e4eb5':
    'Not authorized. This action is restricted to a specific role or caller.',
  '0x001accb5':
    'This function can only be called internally by the diamond (cross-facet).',
  '0xa9ad62f8':
    'Function not available on this contract deployment (facet may not be cut in).',
  '0xe2517d3f':
    'Your account does not have the required role for this action.',
  '0x8e848bae': 'This configuration update is not currently allowed.',

  // ── Guards / infrastructure ───────────────────────────────────────────
  '0xd93c0665':
    'The protocol is currently paused for maintenance. Please try again later.',
  '0x3ee5aeb5':
    'Transaction reverted due to reentrancy protection. Please retry.',
  '0xeb1df718':
    'Illegal loan state transition — the loan cannot move to the requested status.',
  '0x573c3147':
    'A cross-facet call inside the transaction failed. Please share the diagnostics export with support.',

  // ── Phase 3.1 / 3.2 — Oracle hardening ────────────────────────────────
  '0x55d2a2a6':
    'L2 sequencer is currently considered unhealthy (down or in the 1h post-recovery grace window). Try again shortly.',
  '0x032b3d00':
    'L2 sequencer is currently down. Price reads are paused until the sequencer is healthy again.',
  '0xb5d44b5c':
    'L2 sequencer just came back up — prices are gated for 1 hour after recovery. Try again shortly.',
  '0x28871998':
    'Chainlink and the secondary oracle (Pyth) disagreed beyond the configured tolerance. The price read is rejected so no action runs against an unverified price.',
  '0x1e7ace9a':
    'Pyth secondary-oracle price is stale, missing, or unavailable. Submit a Pyth update transaction first, then retry the action.',

  // ── Phase 4.1 — Terms of Service gate ─────────────────────────────────
  '0x2a75db7f':
    'The Terms of Service version you signed for is no longer current. Reload the app, review the updated Terms, and re-sign.',
  '0x1b30f0a8':
    'The submitted Terms-of-Service version or content hash is invalid (governance-side configuration error).',

  // ── Phase 4.3 — Address sanctions ─────────────────────────────────────
  '0x80279111':
    'This wallet (or the offer creator) is flagged by the on-chain sanctions oracle. The protocol cannot pair you with a sanctioned address. If you believe this is a mismatch, contact the sanctions-oracle operator directly — Vaipakam does not maintain its own sanctions list.',

  // ── Other facet errors observed in production ─────────────────────────
  '0x8e2218e4':
    'Self-collateralized offer — the principal asset and collateral asset must be different.',
  '0x26e4b25d':
    'This asset is currently paused by governance. Wait for the pause to lift before retrying.',
  '0x515faa71':
    'This position NFT is locked while a strategic flow (preclose / refinance / loan-sale) is mid-flight.',
  '0x3baaf353':
    'Trade between these two countries is not allowed by the current compliance configuration.',
  '0x01d01c9f':
    'This loan is not in a phase where repayment is accepted right now.',
  '0x0857e728':
    'Repayment amount exceeds the remaining principal + interest owed on this loan.',
  '0xf33650bd':
    'This NFT rental loan is not currently active.',
};

/**
 * Known custom-error selectors from the Vaipakam facets. Any selector not
 * listed renders as `<name?> (0xselector)` so support can map it by hand
 * against the contract source. Keep this table literal (selectors computed
 * offline with `cast sig`) to avoid pulling a hash lib into the bundle.
 */
const KNOWN_ERROR_SELECTORS: Record<string, string> = {
  // ── ERC-20 (OpenZeppelin) ─────────────────────────────────────────────
  '0xe450d38c': 'ERC20InsufficientBalance(address,uint256,uint256)',
  '0xfb8f41b2': 'ERC20InsufficientAllowance(address,uint256,uint256)',
  '0x94280d62': 'ERC20InvalidSender(address)',
  '0xec442f05': 'ERC20InvalidReceiver(address)',

  // ── ERC-721 (LibERC721) ───────────────────────────────────────────────
  '0x89c62b64': 'ERC721InvalidOwner(address)',
  '0x7e273289': 'ERC721NonexistentToken(uint256)',
  '0x64283d7b': 'ERC721IncorrectOwner(address,uint256,address)',
  '0x73c6ac6e': 'ERC721InvalidSender(address)',
  '0x64a0ae92': 'ERC721InvalidReceiver(address)',
  '0x177e802f': 'ERC721InsufficientApproval(address,uint256)',

  // ── Offer lifecycle (OfferFacet) ──────────────────────────────────────
  '0x7fa19075': 'InvalidOfferType()',
  '0x2c5211c6': 'InvalidAmount()',
  '0x23654b56': 'InvalidAssetType()',
  '0x2ee39802': 'InvalidOffer()',
  '0x93f1b0b3': 'OfferAlreadyAccepted()',
  '0xe8439f49': 'NotOfferCreator()',
  '0x13be252b': 'InsufficientAllowance()',
  '0x0bb578c2': 'LiquidityMismatch()',
  '0x97fe4161': 'NonLiquidAssetAndNoIlliquidAsset()',

  // ── Compliance (ProfileFacet / IVaipakamErrors) ───────────────────────
  '0x04a6799c': 'CountriesNotCompatible()',
  '0x83855724': 'KYCRequired()',
  '0xe522f8e6': 'InvalidCountry()',
  '0x3a81d6fc': 'AlreadyRegistered()',
  '0x5d061126': 'InvalidThresholds()',

  // ── Oracle (OracleFacet) ──────────────────────────────────────────────
  '0xfb94c4ed': 'NoPriceFeed()',
  '0x7d5a81eb': 'NoDexPool()',
  '0x355e186c': 'StalePriceData()',
  '0xbb55fd27': 'InsufficientLiquidity()',

  // ── Liquidity / illiquid consent ──────────────────────────────────────
  '0xb87a5be9': 'NonLiquidAsset()',
  '0x96624a75': 'IlliquidAsset()',
  '0xc891add2': 'InvalidAsset()',

  // ── Risk / LTV / HF (RiskFacet / IVaipakamErrors) ────────────────────
  '0xc5af7001': 'LTVExceeded()',
  '0x62e82dca': 'HealthFactorTooLow()',
  '0xfbfb1a44': 'LTVCalculationFailed()',
  '0xfa8b5b08': 'HealthFactorCalculationFailed()',
  '0x32549ba3': 'HealthFactorNotLow()',
  '0x045f33d1': 'InvalidLoan()',
  '0xebb1e0ba': 'ZeroCollateral()',

  // ── Loan lifecycle ────────────────────────────────────────────────────
  '0x082f7846': 'LoanNotActive()',
  '0x8e0f1450': 'InvalidLoanStatus()',
  '0xcb1e8f38': 'NotBorrower()',
  '0x8c380003': 'NotLender()',
  '0x4088c61c': 'NotNFTOwner()',

  // ── Repayment (RepayFacet) ────────────────────────────────────────────
  '0xa6f27c4d': 'RepaymentPastGracePeriod()',
  '0x2f93bdda': 'InsufficientPrepay()',
  '0xf9ee54f0': 'InsufficientPartialAmount()',
  '0x1cd92a3c': 'NotDailyYet()',
  '0x426ad30d': 'NotNFTRental()',

  // ── Default (DefaultedFacet) ──────────────────────────────────────────
  '0xb79cb16c': 'NotDefaultedYet()',
  '0x05c4d8ac': 'LiquidationFailed()',
  '0xe8775e4a': 'InsufficientProceeds()',

  // ── Preclose (PrecloseFacet) ──────────────────────────────────────────
  '0x1fc326a5': 'InvalidNewBorrower()',
  '0x944295c4': 'InvalidOfferTerms()',
  '0x3a23d825': 'InsufficientCollateral()',
  '0xcbc34ec5': 'OffsetNotLinked()',
  '0x2a69fdaf': 'OffsetOfferNotAccepted()',

  // ── Refinance (RefinanceFacet) ────────────────────────────────────────
  '0xbfa0482c': 'InvalidRefinanceOffer()',
  '0x88be51dc': 'OfferNotAccepted()',

  // ── Early withdrawal (EarlyWithdrawalFacet) ───────────────────────────
  '0x910fb9b3': 'InvalidSaleOffer()',
  '0xdce02f61': 'RateShortfallTooHigh()',
  '0x492a2b84': 'SaleNotLinked()',
  '0x1f5d7665': 'SaleOfferNotAccepted()',

  // ── Partial withdrawal ────────────────────────────────────────────────
  '0xfd7850ad': 'AmountTooHigh()',

  // ── Keeper (ProfileFacet / IVaipakamErrors) ───────────────────────────
  '0x7583f2aa': 'KeeperAccessRequired()',
  '0xf7c08f1e': 'KeeperAlreadyApproved()',
  '0x8ebf27d0': 'KeeperNotApproved()',
  '0x1a7025d1': 'KeeperWhitelistFull()',

  // ── Treasury (TreasuryFacet) ──────────────────────────────────────────
  '0x1f2a2005': 'ZeroAmount()',

  // ── Escrow / NFT infrastructure (IVaipakamErrors + facets) ────────────
  '0xb70f4664': 'NFTMintFailed()',
  '0x6154d8fb': 'NFTBurnFailed()',
  '0xddb59ac0': 'NFTStatusUpdateFailed()',
  '0x4605c598': 'NFTTransferFailed()',
  '0x667ecf9d': 'EscrowWithdrawFailed()',
  '0x650f4007': 'EscrowResolutionFailed()',
  '0x601d5b92': 'EscrowTransferFailed()',
  '0x0e373cf8': 'TreasuryTransferFailed()',
  '0xb1fb1c95': 'NFTRenterUpdateFailed()',
  '0xf367ddf6': 'LoanInitiationFailed()',
  '0xd52f4d8a': 'OfferCreationFailed()',
  '0x892d90b7': 'OfferAcceptFailed()',
  '0xa9dea49f': 'LenderResolutionFailed()',
  '0xe3afb2e8': 'GetUserEscrowFailed(string)',
  '0x3f6cc768': 'InvalidTokenId()',
  '0xc24e5557': 'NFTAlreadyBurned()',
  '0xe0e54ced': 'InvalidRoyalty()',

  // ── Access control / authorization ────────────────────────────────────
  '0xea8e4eb5': 'NotAuthorized()',
  '0x001accb5': 'UnauthorizedCrossFacetCall()',
  '0xa9ad62f8': 'FunctionDoesNotExist()',
  '0xe2517d3f': 'AccessControlUnauthorizedAccount(address,bytes32)',
  '0xe6c4247b': 'InvalidAddress()',
  '0x8e848bae': 'UpdateNotAllowed()',

  // ── Guards / infrastructure ───────────────────────────────────────────
  '0xd93c0665': 'EnforcedPause()',
  '0x3ee5aeb5': 'ReentrancyGuardReentrantCall()',
  '0xeb1df718': 'IllegalTransition(uint8,uint8)',
  '0x573c3147': 'CrossFacetCallFailed(string)',

  // ── Phase 3 / 4 surface (added when each phase landed) ────────────────
  '0x55d2a2a6': 'SequencerUnhealthy()',
  '0x032b3d00': 'SequencerDown()',
  '0xb5d44b5c': 'SequencerGracePeriod()',
  '0x28871998': 'OraclePriceDivergence()',
  '0x1e7ace9a': 'PythPriceUnavailable()',
  '0x2a75db7f': 'InvalidTosVersion()',
  '0x1b30f0a8': 'InvalidTosParams()',
  '0x80279111': 'SanctionedAddress(address)',

  // ── Misc previously-unmapped facet errors (only entries NOT already
  // listed in this same table above) ───────────────────────────────────
  '0x8e2218e4': 'SelfCollateralizedOffer()',
  '0x01d01c9f': 'LoanNotInRepayablePhase()',
  '0xf33650bd': 'RentalNotActive()',
  '0x26e4b25d': 'AssetPaused(address)',
  '0x3baaf353': 'TradeNotAllowed()',
  '0x515faa71': 'PositionNFTLocked()',
};

/** Extracts the raw revert data (hex string starting with 0x) from the tangle of shapes ethers/injected wallets surface. */
export function extractRevertData(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as DecodableError;
  const candidates: unknown[] = [
    typeof e.data === 'string' ? e.data : undefined,
    typeof e.data === 'object' ? e.data?.data : undefined,
    e.info?.error?.data,
    e.error?.data,
    e.revert?.data,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.startsWith('0x') && c.length >= 10) return c;
  }
  // Some wallets / RPCs embed the revert bytes directly in the message
  // string (e.g. `... data: 0x08c379a0...`). Fall back to a regex
  // match — but ONLY accept hex blobs that are EITHER a clean 4-byte
  // selector (10 chars) OR a full ABI-encoded revert payload (10
  // chars + multiples of 64 hex chars). This rules out the trap
  // where the message also contains a 40-char address (mistaken for
  // the revert selector by the old `slice(0, 10)`) or a 64-char tx
  // hash.
  const msg = e.message ?? '';
  const matches = msg.match(/0x[0-9a-fA-F]+/g) ?? [];
  for (const m of matches) {
    const len = m.length - 2; // strip 0x
    if (len === 8) return m; // bare 4-byte selector
    if (len >= 8 && (len - 8) % 64 === 0) return m; // selector + N abi-encoded args
  }
  return undefined;
}

/** Returns the 4-byte selector of a revert (0x + 8 hex chars) if present. */
export function extractRevertSelector(err: unknown): string | undefined {
  const data = extractRevertData(err);
  if (!data) return undefined;
  return data.slice(0, 10).toLowerCase();
}

/** Maps a 4-byte selector to a human-readable error name (e.g. `NFTMintFailed()`). */
export function namedRevertSelector(err: unknown): string | undefined {
  const sel = extractRevertSelector(err);
  if (!sel) return undefined;
  const name = KNOWN_ERROR_SELECTORS[sel];
  return name ? `${name} (${sel})` : sel;
}

export function decodeContractError(err: unknown, fallback = 'Transaction failed'): string {
  if (!err || typeof err !== 'object') return fallback;
  const e = err as DecodableError;

  // Prefer a human-friendly message when the revert selector is known. This
  // takes precedence over ethers' raw "unknown custom error" text so users
  // see "Insufficient token balance" instead of a hex blob.
  const sel = extractRevertSelector(err);
  if (sel && FRIENDLY_ERROR_MESSAGES[sel]) {
    return FRIENDLY_ERROR_MESSAGES[sel];
  }

  const base =
    e.reason ??
    e.shortMessage ??
    (typeof e.data === 'object' ? e.data?.message : undefined) ??
    e.message ??
    fallback;

  // Unknown custom error + no friendly copy: append the selector name so
  // support can triage without shipping an ABI fix first.
  if (/unknown custom error/i.test(base)) {
    const named = namedRevertSelector(err);
    if (named) return `${base} — ${named}`;
  }
  return base;
}
