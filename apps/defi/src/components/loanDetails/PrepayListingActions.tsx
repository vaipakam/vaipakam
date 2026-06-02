import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { parseUnits, formatUnits, isHex } from 'viem';
import { Tag, AlertTriangle, X } from 'lucide-react';
import { useDiamondRead } from '../../contracts/useDiamond';
import { useTokenMeta } from '../../lib/tokenMeta';
import type { UseNFTPrepayListingResult } from '../../hooks/useNFTPrepayListing';
import { ErrorAlert } from '../app/ErrorAlert';
import { TokenAmount } from '../app/TokenAmount';

/** OpenSea's canonical conduit key — same value on every Seaport chain.
 *  Tooltip text in the modal lets advanced users override; default is the
 *  OpenSea conduit because that's what >95 % of NFT buyers route through. */
const OPENSEA_CONDUIT_KEY =
  '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000' as const;

interface Props {
  loanId: bigint;
  /** Loan's principal asset address — TokenAmount uses this to render the
   *  min-ask in the right symbol + decimals. */
  principalAsset: string;
  /** Borrower-position NFT id (`loan.borrowerTokenId`) — used to read
   *  the live lock state so we can suppress the post path when the
   *  NFT is already locked by another flow (preclose offset / early
   *  withdrawal). The diamond's `postPrepayListing` reverts
   *  `BorrowerNFTAlreadyLocked` in that case. */
  borrowerTokenId: bigint;
  /** Hook result PASSED IN BY THE PARENT (loan-details page) so a single
   *  `useNFTPrepayListing` instance backs both the page banner and this
   *  action surface. Two separate instances would let banner state go
   *  stale after a successful write — caught by Codex on PR #308. */
  prepayListing: UseNFTPrepayListingResult;
  /** True when listing currently exists (banner shown). Drives the
   *  "Post" vs "Update + Cancel" choice. Derived by the parent from
   *  `prepayListing.listing` so the parent's banner gate and this
   *  child's mode toggle share one source. */
  hasLiveListing: boolean;
  /** True when `now >= endTime + gracePeriod(durationDays)`. Past
   *  grace, post + update revert `PrepayGraceWindowClosed`; cancel
   *  remains callable. The child renders cancel-only mode in that
   *  case instead of disappearing entirely (Codex round-2 P2 fix on
   *  PR #308). */
  pastPrepayGrace: boolean;
  /** True only while the loan is in `Active` status. Post/update on a
   *  non-Active loan revert `PrepayLoanNotActive` on-chain, but
   *  `cancelPrepayListing` intentionally has no status gate — so a
   *  stale post-close listing should still surface its cancel
   *  button. Codex round-3 P2 fix on PR #308. */
  loanIsActive: boolean;
}

/** `LibERC721.LockReason` enum (0 = None). Mirrors the on-chain
 *  ordering, which is the contract's source of truth. */
const LOCK_REASON_NONE = 0;
const LOCK_REASON_PREPAY_COLLATERAL_LISTING = 3;

/**
 * T-086 step 13 — borrower-facing action surface for the prepay-listing
 * flow. Rendered as an `action-group` inside the loan-details Actions
 * card, gated on `isBorrower && loan.allowsPrepayListing`.
 *
 * Two visual modes:
 *
 *   • `hasLiveListing === false` → render the "Post listing" form
 *     (ask-price input + conduit-key picker + optional salt override).
 *   • `hasLiveListing === true`  → render the "Update listing" form
 *     pre-filled from the live values + a "Cancel listing" button.
 *
 * The borrower's vault uses ERC-1271 to authorise the *canonical* order
 * shape the diamond constructs internally — they don't sign a payload
 * here, only set their ask + pick the conduit. The diamond derives the
 * orderHash via `Seaport.getOrderHash` over verified components (#306
 * architectural fix).
 *
 * Min ask = `(lenderLeg + treasuryLeg) × (10000 + bufferBps) / 10000`.
 * Read live from `getPrepayContext` + `getPrepayListingBufferBps`, so a
 * governance buffer rotation between mount + submit is reflected
 * immediately.
 */
export function PrepayListingActions({
  loanId,
  principalAsset,
  borrowerTokenId,
  prepayListing,
  hasLiveListing,
  pastPrepayGrace,
  loanIsActive,
}: Props) {
  const { t } = useTranslation();
  const diamond = useDiamondRead();
  const meta = useTokenMeta(principalAsset);
  // We delay form initialization until `meta` is non-null so a
  // non-18-decimal principal (USDC=6, etc.) gets seeded with the
  // correct units. Until then `decimals` is the 18-default and any
  // pre-fill would mis-format the ask. Codex round-4 P2 fix on PR
  // #308.
  const metaLoaded = meta !== null;
  const decimals = meta?.decimals ?? 18;

  const {
    listing,
    actionLoading,
    actionError,
    txHash,
    postPrepayListing,
    updatePrepayListing,
    cancelPrepayListing,
  } = prepayListing;

  // Periodic refresh tick — bumps every 60s so the on-chain floor /
  // min-ask read below stays current while the form sits open and
  // interest accrues. Without this, a borrower could craft an ask
  // the UI presents as valid but the on-chain `_requireAskCoversFloor`
  // now rejects with `AskBelowFloor`. Codex round-4 P3 fix on PR
  // #308.
  const [floorTick, setFloorTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFloorTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  // Min-ask anchor + live floor + kill-switch + lock state — all pulled
  // from the diamond rather than re-derived in JS, so the live grace,
  // interest accrual, master kill-switch, buffer config, and borrower-
  // NFT lock all land on the user without a stale snapshot.
  const [minAsk, setMinAsk] = useState<bigint | null>(null);
  const [floor, setFloor] = useState<bigint | null>(null);
  const [bufferBps, setBufferBps] = useState<number | null>(null);
  const [prepayEnabled, setPrepayEnabled] = useState<boolean | null>(null);
  const [borrowerLock, setBorrowerLock] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = diamond as unknown as {
          getPrepayContext: (
            id: bigint,
            asOf: bigint,
          ) => Promise<{
            lenderLeg: bigint;
            treasuryLeg: bigint;
          } | unknown[]>;
          getPrepayListingBufferBps: () => Promise<bigint>;
          getPrepayListingEnabled: () => Promise<boolean>;
          positionLock: (tokenId: bigint) => Promise<number>;
        };
        const asOf = BigInt(Math.floor(Date.now() / 1000));
        const [ctx, buf, enabled, lock] = await Promise.all([
          d.getPrepayContext(loanId, asOf),
          d.getPrepayListingBufferBps(),
          d.getPrepayListingEnabled(),
          d.positionLock(borrowerTokenId),
        ]);
        if (cancelled) return;
        // `getPrepayContext` returns a struct; viem decodes it as an
        // object keyed by field name. Tolerant pull either way so the
        // code survives a viem-shape change.
        const lender = (ctx as { lenderLeg?: bigint }).lenderLeg ?? 0n;
        const treasury = (ctx as { treasuryLeg?: bigint }).treasuryLeg ?? 0n;
        const f = lender + treasury;
        const bps = Number(buf);
        setFloor(f);
        setBufferBps(bps);
        setMinAsk((f * BigInt(10_000 + bps)) / 10_000n);
        setPrepayEnabled(Boolean(enabled));
        setBorrowerLock(Number(lock));
      } catch {
        if (!cancelled) {
          // Older deploy or transient RPC blip — leave anchor fields
          // null; the submit will still revert with the on-chain
          // `AskBelowFloor` if the user picks too low a number.
          setMinAsk(null);
          setFloor(null);
          setBufferBps(null);
          setPrepayEnabled(null);
          setBorrowerLock(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [diamond, loanId, borrowerTokenId, listing?.updatedAt, floorTick]);

  // Gate status — disable the post path when any of:
  //   • master kill-switch is OFF
  //   • buffer is 0 (storage default — `_requireAskCoversFloor`
  //     reverts `PrepayListingBufferNotConfigured`)
  //   • borrower NFT is locked by another flow (preclose offset /
  //     early withdrawal) — its own PrepayCollateralListing lock is
  //     OK during update; that's the EXPECTED state for a live
  //     listing being re-signed.
  const featureDisabled = prepayEnabled === false;
  const bufferUnconfigured = bufferBps === 0;
  const lockedByOtherFlow =
    borrowerLock !== null &&
    borrowerLock !== LOCK_REASON_NONE &&
    borrowerLock !== LOCK_REASON_PREPAY_COLLATERAL_LISTING;
  const unavailableReason: 'feature' | 'buffer' | 'other-lock' | null =
    featureDisabled
      ? 'feature'
      : bufferUnconfigured
        ? 'buffer'
        : lockedByOtherFlow
          ? 'other-lock'
          : null;

  // Form state. Pre-fill the ask-price input from the live listing when
  // updating; default to minAsk + small headroom on a fresh post.
  const [askPriceInput, setAskPriceInput] = useState<string>('');
  // Empty string in update mode means "borrower hasn't entered a
  // conduitKey yet" — we don't auto-default to OPENSEA when the live
  // listing's actual conduit isn't necessarily OpenSea (we only know
  // the address, not the key it was derived from). Borrower must
  // consciously re-enter the conduitKey on update.
  const [conduitKey, setConduitKey] = useState<string>(OPENSEA_CONDUIT_KEY);
  const [saltInput, setSaltInput] = useState<string>('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  // One-shot init flags so subsequent live-listing updates from the
  // hook's indexer reload don't trample borrower-typed values mid-edit.
  // Reset when the listing IDENTITY changes (new listing posted,
  // cancelled, or replaced by an update) — without this reset, a fresh
  // post form after a cancel would keep the old ask and the deliberately
  // blank update-mode conduit input. Codex round-3 P2 fix on PR #308.
  const [askInitialized, setAskInitialized] = useState(false);
  const [conduitInitialized, setConduitInitialized] = useState(false);

  // Identity key — combination of loanId + listing.orderHash (or a
  // sentinel for "no listing") + decimals. `decimals` is in the key
  // so a late-arriving `useTokenMeta` resolution (USDC=6 catching up
  // from the 18-default) triggers a re-init of the ask field with
  // the correct unit. Codex round-4 P2 fix on PR #308.
  const listingIdentity = `${loanId.toString()}::${listing?.orderHash ?? '<none>'}::${decimals}`;
  const [seenIdentity, setSeenIdentity] = useState<string | null>(null);
  useEffect(() => {
    if (seenIdentity !== listingIdentity) {
      setAskInitialized(false);
      setConduitInitialized(false);
      setSeenIdentity(listingIdentity);
    }
  }, [listingIdentity, seenIdentity]);

  useEffect(() => {
    // Delay init until token metadata has resolved so the ask
    // pre-fill uses the right decimals from the first paint.
    if (!metaLoaded) return;
    if (hasLiveListing && listing) {
      if (!askInitialized) {
        setAskPriceInput(formatUnits(BigInt(listing.askPrice), decimals));
        setAskInitialized(true);
      }
      // Update-mode conduit: we know the listing's resolved conduit
      // ADDRESS (`listing.conduit`) but NOT the conduitKey it was
      // derived from (the event emits only the resolved address).
      // Auto-defaulting to OPENSEA_CONDUIT_KEY in update mode would
      // silently re-route any update to OpenSea even if the original
      // listing used a different approved conduit. Force the advanced
      // expander open + clear the input so the borrower types the key
      // they used. Codex P3 fix round 3 on PR #308.
      if (!conduitInitialized) {
        setConduitKey('');
        setShowAdvanced(true);
        setConduitInitialized(true);
      }
    } else if (!hasLiveListing && minAsk !== null && !askInitialized) {
      // Fresh post mode after a cancel/none state — reset conduit to
      // the OpenSea default so the borrower starts from the
      // happy-path input instead of inheriting the deliberately-blank
      // update-mode value.
      setConduitKey(OPENSEA_CONDUIT_KEY);
      setConduitInitialized(true);
      // Suggest 5 % headroom above the configured buffer-floor as a
      // starting point — same shape the buffer itself takes, doubling
      // up gives the borrower a comfortable signature lifetime.
      const suggested = (minAsk * 10_500n) / 10_000n;
      setAskPriceInput(formatUnits(suggested, decimals));
      setAskInitialized(true);
    }
  }, [
    metaLoaded,
    hasLiveListing,
    listing,
    minAsk,
    decimals,
    askInitialized,
    conduitInitialized,
  ]);

  const conduitKeyValid =
    isHex(conduitKey) && (conduitKey as string).length === 66;

  const parseAskPrice = (): bigint | null => {
    try {
      return parseUnits(askPriceInput, decimals);
    } catch {
      return null;
    }
  };

  // Salt input validation. Empty → auto-generated random uint256;
  // non-empty → must parse as a uint256 hex or decimal. Returning
  // `null` (rather than letting `BigInt('abc')` throw inside the
  // submit handler) lets us surface the failure inline like the
  // conduit-key check — Codex P3 fix round 3 on PR #308.
  const parseSalt = (): bigint | null => {
    const trimmed = saltInput.trim();
    if (trimmed === '') {
      // Auto-derive a random uint256 if the user didn't override. Uses
      // crypto.getRandomValues so the value is non-guessable; a salt
      // collision against this borrower's prior listing on the same
      // loan would just revert with `PrepayListingAlreadyExists`.
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      let hex = '0x';
      for (const b of bytes) hex += b.toString(16).padStart(2, '0');
      return BigInt(hex);
    }
    try {
      const v = BigInt(trimmed);
      // uint256 bounds — `BigInt(...)` accepts arbitrary precision.
      if (v < 0n || v > (1n << 256n) - 1n) return null;
      return v;
    } catch {
      return null;
    }
  };

  const ask = parseAskPrice();
  const askBelowMin = ask !== null && minAsk !== null && ask < minAsk;
  const saltValid = parseSalt() !== null;

  // The hook's action functions return `true` on success, `false`
  // otherwise. The hook ALSO runs its own indexer-reload + the
  // parent's `onAfterSuccess` (which the parent wires to `loadLoan`)
  // inside the same try/catch, so no follow-up refresh is needed
  // here — we only adjust local view state (close the cancel
  // confirm) on success.
  const handlePost = async () => {
    if (!ask || !conduitKeyValid) return;
    const salt = parseSalt();
    if (salt === null) return;
    // T-086 Round-5 Block A (#313) — empty feeLegs default. Fee-
    // enforced collections will populate this from the agent's
    // /opensea/collection/{slug} response in a follow-up UI pass
    // (the dapp's collection-aware fee picker is tracked
    // separately; the hook's typed array makes the contract right
    // today so the UX layer can land independently without
    // breaking the post path).
    await postPrepayListing(loanId, ask, salt, conduitKey as `0x${string}`, []);
  };

  const handleUpdate = async () => {
    if (!ask || !conduitKeyValid) return;
    const salt = parseSalt();
    if (salt === null) return;
    // T-086 Round-5 Block A (#313) — same empty-default rationale
    // as the post path. The §15.3 errata's "re-fetch fees against
    // newAskPrice" rule applies once the fee picker UI lands.
    await updatePrepayListing(loanId, ask, salt, conduitKey as `0x${string}`, []);
  };

  const handleCancel = async () => {
    const ok = await cancelPrepayListing(loanId);
    if (ok) setConfirmingCancel(false);
  };

  // ─── Hide surface entirely when nothing is actionable ─────────────
  // Past grace OR loan no longer Active without a live listing means
  // post/update are both forbidden by the diamond and there's
  // nothing to cancel — render null so the page doesn't show an
  // empty card. Codex round-3 P2 fix on PR #308.
  if ((pastPrepayGrace || !loanIsActive) && !hasLiveListing) {
    return null;
  }

  // ─── Cancel-only mode ─────────────────────────────────────────────
  // Live listing + (past-grace OR feature unavailable OR loan no
  // longer Active) → only the cancel path stays open on-chain.
  // Show the cancel button + a contextual reason instead of the
  // full form. The borrower-cancel diamond entry has no loan-status
  // gate so a stale post-close listing can always be unwound.
  const cancelOnly =
    hasLiveListing &&
    (pastPrepayGrace || !loanIsActive || unavailableReason !== null);

  if (cancelOnly) {
    return (
      <div id="prepay-listing-card" className="card loan-actions-card">
        <div className="action-group">
        <h4
          className="action-title"
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}
        >
          <Tag size={16} />
          {t('prepayListing.actions.cancelOnlyTitle')}
        </h4>
        <div
          className="alert alert-warning"
          style={{ marginTop: 8, marginBottom: 8, fontSize: '0.9rem' }}
        >
          <AlertTriangle size={16} />
          <span>
            {!loanIsActive
              ? t('prepayListing.actions.cancelOnlyLoanClosed')
              : pastPrepayGrace
                ? t('prepayListing.actions.cancelOnlyPastGrace')
                : unavailableReason === 'feature'
                  ? t('prepayListing.actions.unavailableFeatureDisabledCanCancel')
                  : unavailableReason === 'buffer'
                    ? t('prepayListing.actions.unavailableBufferUnconfiguredCanCancel')
                    : t('prepayListing.actions.unavailableNftLockedCanCancel')}
          </span>
        </div>
        <div className="action-row">
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => setConfirmingCancel(true)}
            disabled={actionLoading}
          >
            <X size={14} style={{ marginRight: 4, verticalAlign: 'middle' }} />
            {t('prepayListing.actions.cancelCta')}
          </button>
        </div>

        {confirmingCancel && (
          <div
            className="alert alert-warning"
            style={{ marginTop: 12, display: 'block' }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                marginBottom: 8,
              }}
            >
              <AlertTriangle size={16} />
              <strong>{t('prepayListing.actions.cancelConfirmTitle')}</strong>
            </div>
            <p style={{ fontSize: '0.9rem' }}>
              {t('prepayListing.actions.cancelConfirmBody')}
            </p>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button
                className="btn btn-primary btn-sm"
                onClick={handleCancel}
                disabled={actionLoading}
              >
                {actionLoading
                  ? t('loanDetails.processing')
                  : t('prepayListing.actions.cancelConfirmCta')}
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => setConfirmingCancel(false)}
                disabled={actionLoading}
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        )}

        {actionError && (
          <ErrorAlert message={actionError} style={{ marginTop: 8 }} />
        )}
        {txHash && (
          <p
            className="action-desc"
            style={{ marginTop: 8, fontSize: '0.8rem' }}
          >
            {t('prepayListing.actions.txSubmitted', { hash: txHash })}
          </p>
        )}
        </div>
      </div>
    );
  }

  // ─── Unavailable state (no live listing yet) ─────────────────────
  // Feature master-disabled / buffer-unconfigured / borrower NFT
  // locked by another in-progress flow → inline explainer, no form.
  // Codex P2 fix round 3 on PR #308.
  if (unavailableReason !== null && !hasLiveListing) {
    return (
      <div id="prepay-listing-card" className="card loan-actions-card">
        <div className="action-group">
        <h4
          className="action-title"
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}
        >
          <Tag size={16} />
          {t('prepayListing.actions.postTitle')}
        </h4>
        <div
          className="alert alert-warning"
          style={{ marginTop: 8, fontSize: '0.9rem' }}
        >
          <AlertTriangle size={16} />
          <span>
            {unavailableReason === 'feature' &&
              t('prepayListing.actions.unavailableFeatureDisabled')}
            {unavailableReason === 'buffer' &&
              t('prepayListing.actions.unavailableBufferUnconfigured')}
            {unavailableReason === 'other-lock' &&
              t('prepayListing.actions.unavailableNftLocked')}
          </span>
        </div>
        </div>
      </div>
    );
  }

  return (
    <div id="prepay-listing-card" className="card loan-actions-card">
    <div className="action-group">
      <h4
        className="action-title"
        style={{ display: 'flex', alignItems: 'center', gap: 6 }}
      >
        <Tag size={16} />
        {hasLiveListing
          ? t('prepayListing.actions.updateTitle')
          : t('prepayListing.actions.postTitle')}
      </h4>
      <p className="action-desc">
        {hasLiveListing
          ? t('prepayListing.actions.updateDesc')
          : t('prepayListing.actions.postDesc')}
      </p>
      {/* Note: the "feature unavailable while live listing exists"
          + "past grace while live listing exists" cases are handled
          earlier by the `cancelOnly` branch which renders a
          cancel-only surface. By the time we get here both
          `unavailableReason === null` AND `!pastPrepayGrace`. */}

      {/* Live anchor block */}
      <div className="data-row">
        <span className="data-label">
          {t('prepayListing.actions.liveFloor')}
        </span>
        <span className="data-value">
          {floor !== null ? (
            <TokenAmount
              amount={floor}
              address={principalAsset}
              withSymbol
            />
          ) : (
            '—'
          )}
        </span>
      </div>
      <div className="data-row">
        <span className="data-label">
          {t('prepayListing.actions.minAsk')}
          {bufferBps !== null && (
            <span style={{ marginLeft: 4, opacity: 0.7, fontSize: '0.85em' }}>
              (+{(bufferBps / 100).toFixed(2)}%)
            </span>
          )}
        </span>
        <span className="data-value">
          {minAsk !== null ? (
            <TokenAmount
              amount={minAsk}
              address={principalAsset}
              withSymbol
            />
          ) : (
            '—'
          )}
        </span>
      </div>

      {/* Ask price input */}
      <label
        className="form-label"
        htmlFor="prepay-ask-price"
        style={{ display: 'block', marginTop: 12, fontSize: '0.85rem' }}
      >
        {t('prepayListing.actions.askPriceLabel')}
      </label>
      <input
        id="prepay-ask-price"
        className="form-input"
        type="number"
        step="any"
        min="0"
        value={askPriceInput}
        onChange={(e) => setAskPriceInput(e.target.value)}
        placeholder={t('prepayListing.actions.askPricePlaceholder')}
        disabled={actionLoading}
      />
      {askBelowMin && (
        <div
          className="alert alert-warning"
          style={{
            marginTop: 6,
            fontSize: '0.85rem',
            display: 'flex',
            gap: 6,
            alignItems: 'center',
          }}
        >
          <AlertTriangle size={14} />
          <span>{t('prepayListing.actions.askBelowMinWarning')}</span>
        </div>
      )}

      <button
        type="button"
        className="btn btn-link btn-xs"
        onClick={() => setShowAdvanced((v) => !v)}
        style={{ marginTop: 8, fontSize: '0.85rem' }}
      >
        {showAdvanced
          ? t('prepayListing.actions.hideAdvanced')
          : t('prepayListing.actions.showAdvanced')}
      </button>

      {showAdvanced && (
        <div style={{ marginTop: 8 }}>
          {/* Update-mode conduit hint — we can't reverse-derive the
              conduitKey from the resolved conduit address that the
              event emitted, so the borrower must consciously re-enter
              the same conduitKey they used on the original post. The
              live listing's resolved conduit address is shown for
              cross-reference. */}
          {hasLiveListing && listing && (
            <div
              className="alert"
              style={{
                marginBottom: 8,
                fontSize: '0.8rem',
                background: 'rgba(245,158,11,0.08)',
                border: '1px solid rgba(245,158,11,0.3)',
              }}
            >
              <AlertTriangle size={14} />
              <span>
                {t('prepayListing.actions.updateConduitHint', {
                  conduit: listing.conduit,
                })}
              </span>
            </div>
          )}

          <label
            className="form-label"
            htmlFor="prepay-conduit-key"
            style={{ display: 'block', fontSize: '0.85rem' }}
          >
            {t('prepayListing.actions.conduitKeyLabel')}
          </label>
          <input
            id="prepay-conduit-key"
            className="form-input"
            type="text"
            value={conduitKey}
            onChange={(e) => setConduitKey(e.target.value)}
            placeholder={OPENSEA_CONDUIT_KEY}
            disabled={actionLoading}
            style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}
          />
          {!conduitKeyValid && (
            <div
              className="alert alert-error"
              style={{
                marginTop: 4,
                fontSize: '0.8rem',
                display: 'flex',
                gap: 6,
                alignItems: 'center',
              }}
            >
              <AlertTriangle size={14} />
              <span>{t('prepayListing.actions.invalidConduitKey')}</span>
            </div>
          )}

          <label
            className="form-label"
            htmlFor="prepay-salt"
            style={{ display: 'block', marginTop: 8, fontSize: '0.85rem' }}
          >
            {t('prepayListing.actions.saltLabel')}
          </label>
          <input
            id="prepay-salt"
            className="form-input"
            type="text"
            value={saltInput}
            onChange={(e) => setSaltInput(e.target.value)}
            placeholder={t('prepayListing.actions.saltPlaceholder')}
            disabled={actionLoading}
            style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}
          />
          {!saltValid && (
            <div
              className="alert alert-error"
              style={{
                marginTop: 4,
                fontSize: '0.8rem',
                display: 'flex',
                gap: 6,
                alignItems: 'center',
              }}
            >
              <AlertTriangle size={14} />
              <span>{t('prepayListing.actions.invalidSalt')}</span>
            </div>
          )}
        </div>
      )}

      <div className="action-row" style={{ marginTop: 12 }}>
        {hasLiveListing ? (
          <>
            <button
              className="btn btn-primary btn-sm"
              onClick={handleUpdate}
              disabled={
                actionLoading ||
                !ask ||
                askBelowMin ||
                !conduitKeyValid ||
                !saltValid ||
                unavailableReason !== null
              }
            >
              {actionLoading
                ? t('loanDetails.processing')
                : t('prepayListing.actions.updateCta')}
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setConfirmingCancel(true)}
              disabled={actionLoading}
              style={{ marginLeft: 8 }}
            >
              <X size={14} style={{ marginRight: 4, verticalAlign: 'middle' }} />
              {t('prepayListing.actions.cancelCta')}
            </button>
          </>
        ) : (
          <button
            className="btn btn-primary btn-sm"
            onClick={handlePost}
            disabled={
              actionLoading ||
              !ask ||
              askBelowMin ||
              !conduitKeyValid ||
              !saltValid ||
              unavailableReason !== null
            }
          >
            {actionLoading
              ? t('loanDetails.processing')
              : t('prepayListing.actions.postCta')}
          </button>
        )}
      </div>

      {confirmingCancel && (
        <div
          className="alert alert-warning"
          style={{ marginTop: 12, display: 'block' }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              marginBottom: 8,
            }}
          >
            <AlertTriangle size={16} />
            <strong>{t('prepayListing.actions.cancelConfirmTitle')}</strong>
          </div>
          <p style={{ fontSize: '0.9rem' }}>
            {t('prepayListing.actions.cancelConfirmBody')}
          </p>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button
              className="btn btn-primary btn-sm"
              onClick={handleCancel}
              disabled={actionLoading}
            >
              {actionLoading
                ? t('loanDetails.processing')
                : t('prepayListing.actions.cancelConfirmCta')}
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setConfirmingCancel(false)}
              disabled={actionLoading}
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {actionError && (
        <ErrorAlert message={actionError} style={{ marginTop: 8 }} />
      )}
      {txHash && (
        <p
          className="action-desc"
          style={{ marginTop: 8, fontSize: '0.8rem' }}
        >
          {t('prepayListing.actions.txSubmitted', { hash: txHash })}
        </p>
      )}
    </div>
    </div>
  );
}
