import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { parseUnits, formatUnits, isHex } from 'viem';
import { Tag, AlertTriangle, X } from 'lucide-react';
import { useDiamondRead } from '../../contracts/useDiamond';
import { useTokenMeta } from '../../lib/tokenMeta';
import { useNFTPrepayListing } from '../../hooks/useNFTPrepayListing';
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
  /** True when listing currently exists (banner shown). Drives the
   *  "Post" vs "Update + Cancel" choice. */
  hasLiveListing: boolean;
  /** Reload callback the parent uses to refresh the loan + indexer view
   *  after a successful action. The hook also reloads its own indexer
   *  fetch internally; this re-pulls the on-chain loan + holders. */
  onActionSuccess: () => void;
}

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
  hasLiveListing,
  onActionSuccess,
}: Props) {
  const { t } = useTranslation();
  const diamond = useDiamondRead();
  const meta = useTokenMeta(principalAsset);
  const decimals = meta?.decimals ?? 18;

  const {
    listing,
    actionLoading,
    actionError,
    txHash,
    postPrepayListing,
    updatePrepayListing,
    cancelPrepayListing,
  } = useNFTPrepayListing(loanId.toString());

  // Min-ask anchor + live floor — both pulled from the diamond rather
  // than re-derived in JS, so the live grace + interest accrual lands
  // on the user without a stale snapshot.
  const [minAsk, setMinAsk] = useState<bigint | null>(null);
  const [floor, setFloor] = useState<bigint | null>(null);
  const [bufferBps, setBufferBps] = useState<number | null>(null);

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
        };
        const asOf = BigInt(Math.floor(Date.now() / 1000));
        const [ctx, buf] = await Promise.all([
          d.getPrepayContext(loanId, asOf),
          d.getPrepayListingBufferBps(),
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
      } catch {
        if (!cancelled) {
          // Older deploy or transient RPC blip — leave anchor fields
          // null; the submit will still revert with the on-chain
          // `AskBelowFloor` if the user picks too low a number.
          setMinAsk(null);
          setFloor(null);
          setBufferBps(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [diamond, loanId, listing?.updatedAt]);

  // Form state. Pre-fill the ask-price input from the live listing when
  // updating; default to minAsk + small headroom on a fresh post.
  const [askPriceInput, setAskPriceInput] = useState<string>('');
  const [conduitKey, setConduitKey] = useState<string>(OPENSEA_CONDUIT_KEY);
  const [saltInput, setSaltInput] = useState<string>('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  useEffect(() => {
    if (hasLiveListing && listing) {
      setAskPriceInput(formatUnits(BigInt(listing.askPrice), decimals));
      setConduitKey(listing.conduit ? OPENSEA_CONDUIT_KEY : OPENSEA_CONDUIT_KEY);
    } else if (minAsk !== null) {
      // Suggest 5 % headroom above the configured buffer-floor as a
      // starting point — same shape the buffer itself takes, doubling
      // up gives the borrower a comfortable signature lifetime.
      const suggested = (minAsk * 10_500n) / 10_000n;
      setAskPriceInput(formatUnits(suggested, decimals));
    }
  }, [hasLiveListing, listing, minAsk, decimals]);

  const conduitKeyValid =
    isHex(conduitKey) && (conduitKey as string).length === 66;

  const parseAskPrice = (): bigint | null => {
    try {
      return parseUnits(askPriceInput, decimals);
    } catch {
      return null;
    }
  };

  const parseSalt = (): bigint => {
    if (saltInput.trim() === '') {
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
    return BigInt(saltInput);
  };

  const ask = parseAskPrice();
  const askBelowMin = ask !== null && minAsk !== null && ask < minAsk;

  const handlePost = async () => {
    if (!ask || !conduitKeyValid) return;
    await postPrepayListing(
      loanId,
      ask,
      parseSalt(),
      conduitKey as `0x${string}`,
    );
    onActionSuccess();
  };

  const handleUpdate = async () => {
    if (!ask || !conduitKeyValid) return;
    await updatePrepayListing(
      loanId,
      ask,
      parseSalt(),
      conduitKey as `0x${string}`,
    );
    onActionSuccess();
  };

  const handleCancel = async () => {
    await cancelPrepayListing(loanId);
    setConfirmingCancel(false);
    onActionSuccess();
  };

  return (
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
        </div>
      )}

      <div className="action-row" style={{ marginTop: 12 }}>
        {hasLiveListing ? (
          <>
            <button
              className="btn btn-primary btn-sm"
              onClick={handleUpdate}
              disabled={
                actionLoading || !ask || askBelowMin || !conduitKeyValid
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
              actionLoading || !ask || askBelowMin || !conduitKeyValid
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
  );
}
