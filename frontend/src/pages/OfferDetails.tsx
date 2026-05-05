import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ExternalLink, X, Settings } from 'lucide-react';
import { numberToHex, type Address, type Hex } from 'viem';
import { usePublicClient } from 'wagmi';
import { L as Link } from '../components/L';
import { useWallet } from '../context/WalletContext';
import { useDiamondContract, useDiamondRead, useReadChain } from '../contracts/useDiamond';
import { DEFAULT_CHAIN } from '../contracts/config';
import {
  fetchOfferById,
  indexedToRawOffer,
  type IndexedOffer,
} from '../lib/indexerClient';
import { chunkedGetLogs, TOPIC0 } from '../lib/rpcCatchUp';
import {
  toOfferData,
  type OfferData,
  type RawOffer,
  OFFER_TYPE_LABELS,
} from './OfferBook';
import { bpsToPercent, formatDate } from '../lib/format';
import { AddressDisplay } from '../components/app/AddressDisplay';
import { AssetLink } from '../components/app/AssetLink';
import { TokenAmount } from '../components/app/TokenAmount';
import { TokenIcon } from '../components/app/TokenIcon';
import { ErrorAlert } from '../components/app/ErrorAlert';
import { decodeContractError } from '../lib/decodeContractError';

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

type OfferStatus = 'active' | 'accepted' | 'cancelled' | 'expired' | 'unknown';

/**
 * Per-offer detail surface, keyed by offer id. Mirrors `LoanDetails`:
 *
 *   - Indexer-first read (`fetchOfferById`); falls back to a single
 *     `getOffer` chain read only when the worker is unreachable.
 *   - Status badge driven off the indexer's status enum (or
 *     `accepted`/zero-creator on the chain-only path).
 *   - Block-explorer link to the chain where the offer lives — same
 *     deep-link style the LoanDetails timeline already uses.
 *   - Cancel button when the connected wallet is the creator AND the
 *     offer is active.
 *
 * NOT in this first cut: the `OfferCreated` tx-hash deep-link (would
 * need a targeted `eth_getLogs` against `firstSeenBlock`); the
 * fill-history table for partial-fill offers; the keeper-config
 * inline editor (already lives at /app/keepers). All deferred.
 */
export default function OfferDetails() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { offerId: offerIdParam } = useParams();
  const { address, activeChain, isCorrectChain } = useWallet();
  const readChain = useReadChain();
  const diamondRead = useDiamondRead();
  const diamondWrite = useDiamondContract();

  const chainId = readChain.chainId ?? DEFAULT_CHAIN.chainId;
  const blockExplorer =
    (activeChain && isCorrectChain ? activeChain.blockExplorer : null) ??
    DEFAULT_CHAIN.blockExplorer;

  const offerIdBig = useMemo(() => {
    if (!offerIdParam) return null;
    try {
      return BigInt(offerIdParam);
    } catch {
      return null;
    }
  }, [offerIdParam]);

  const [indexed, setIndexed] = useState<IndexedOffer | null>(null);
  const [chainOffer, setChainOffer] = useState<OfferData | null>(null);
  const [status, setStatus] = useState<OfferStatus>('unknown');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refetchTick, setRefetchTick] = useState(0);
  // Tx hash of the OfferCreated event. Resolved lazily after the
  // indexer payload lands so the explorer-link affordance only
  // appears once we actually have the hash. Empty when the lookup is
  // pending OR the worker is unreachable AND the chain-only fallback
  // is in use (no firstSeenBlock to anchor the targeted log scan).
  const [createdTxHash, setCreatedTxHash] = useState<Hex | null>(null);
  const publicClient = usePublicClient();

  // Indexer-first read. The worker's `/offers/:id` endpoint returns
  // every field the page renders, including the `firstSeenBlock` that
  // anchors the explorer deep-link. Chain read happens only when the
  // worker is unreachable — exactly the "no unnecessary RPC spam"
  // discipline applied across the rest of the app.
  useEffect(() => {
    if (offerIdBig === null) {
      setError(
        t('offerDetails.invalidId', { defaultValue: 'Invalid offer id.' }),
      );
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const id = Number(offerIdBig);
        const fromIndexer = await fetchOfferById(chainId, id);
        if (cancelled) return;
        if (fromIndexer) {
          setIndexed(fromIndexer);
          setChainOffer(toOfferData(indexedToRawOffer(fromIndexer)));
          setStatus(fromIndexer.status as OfferStatus);
          setLoading(false);
          return;
        }
        // Worker unreachable — fall back to a single direct chain
        // read. `getOffer` returns a zero-creator struct for cancelled
        // ids (the storage slot was deleted at cancel time); we use
        // that signal to render the cancelled state without a richer
        // event lookup. Recently-cancelled offers will look "unknown"
        // until the indexer catches up.
        const raw = (await diamondRead.getOffer(offerIdBig)) as RawOffer;
        if (cancelled) return;
        if (!raw || raw.creator?.toLowerCase() === ZERO_ADDR) {
          setStatus('cancelled');
          setChainOffer(null);
          setLoading(false);
          return;
        }
        const od = toOfferData(raw);
        setChainOffer(od);
        setStatus(od.accepted ? 'accepted' : 'active');
        setIndexed(null);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof Error
            ? err.message
            : t('offerDetails.loadError', {
                defaultValue: 'Failed to load offer.',
              }),
        );
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chainId, offerIdBig, diamondRead, refetchTick, t]);

  // Resolve the OfferCreated tx-hash via a targeted single-block
  // `eth_getLogs` against the indexer-supplied `firstSeenBlock`.
  // Filter is `(diamond, OfferCreated, offerId-as-bytes32)` — exactly
  // one log matches per offer, so this is one-block, one-result, one
  // RPC. Skipped entirely on the chain-only fallback (no
  // `firstSeenBlock` available) and on a re-render where we've
  // already resolved the hash.
  useEffect(() => {
    if (!indexed || !publicClient || !readChain.diamondAddress) return;
    if (createdTxHash) return;
    let cancelled = false;
    (async () => {
      const block = BigInt(indexed.firstSeenBlock);
      const offerIdHex = numberToHex(BigInt(indexed.offerId), { size: 32 });
      try {
        const logs = await chunkedGetLogs(publicClient, {
          fromBlock: block,
          toBlock: block,
          address: readChain.diamondAddress as Address,
          topics: [TOPIC0.OFFER_CREATED, offerIdHex],
        });
        if (cancelled || logs.length === 0) return;
        setCreatedTxHash(logs[0].transactionHash);
      } catch {
        // Silent — the explorer link just stays hidden. No fallback
        // needed; the page still renders fine without the tx hash.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [indexed, publicClient, readChain.diamondAddress, createdTxHash]);

  const offerForDisplay: OfferData | null = chainOffer;

  const isCreator =
    offerForDisplay && address
      ? offerForDisplay.creator.toLowerCase() === address.toLowerCase()
      : false;
  const canCancel = isCreator && status === 'active';

  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const onCancel = useCallback(async () => {
    if (!offerIdBig || cancelling) return;
    setCancelling(true);
    setCancelError(null);
    try {
      const tx = await diamondWrite.cancelOffer(offerIdBig);
      await tx.wait();
      setRefetchTick((n) => n + 1);
    } catch (err) {
      setCancelError(decodeContractError(err));
    } finally {
      setCancelling(false);
    }
  }, [offerIdBig, cancelling, diamondWrite]);

  const linkedLoanId =
    indexed && indexed.status === 'accepted' && indexed.positionTokenId
      ? indexed.positionTokenId
      : null;

  return (
    <div className="loan-details-page">
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => navigate(-1)}
        style={{ marginBottom: 12 }}
      >
        <ArrowLeft size={14} style={{ marginRight: 4 }} />
        {t('common.back', { defaultValue: 'Back' })}
      </button>

      <h1 style={{ marginTop: 0, marginBottom: 8 }}>
        {t('offerDetails.title', {
          defaultValue: 'Offer #{{id}}',
          id: offerIdParam,
        })}
      </h1>

      {loading ? (
        <div className="card" style={{ marginTop: 16 }}>
          <p style={{ color: 'var(--text-secondary)' }}>
            {t('offerDetails.loading', { defaultValue: 'Loading offer…' })}
          </p>
        </div>
      ) : error ? (
        <ErrorAlert message={error} />
      ) : !offerForDisplay && status === 'cancelled' ? (
        <div className="card" style={{ marginTop: 16 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginBottom: 12,
            }}
          >
            <span
              className="status-badge"
              style={{
                background: 'var(--surface-2)',
                color: 'var(--muted)',
              }}
            >
              {t('myOffersTable.statusCancelled', {
                defaultValue: 'Cancelled',
              })}
            </span>
          </div>
          <p style={{ color: 'var(--text-secondary)' }}>
            {t('offerDetails.cancelledNoData', {
              defaultValue:
                'This offer was cancelled. The on-chain storage has been cleared and the indexer does not have the historical struct cached.',
            })}
          </p>
        </div>
      ) : !offerForDisplay ? (
        <div className="card" style={{ marginTop: 16 }}>
          <p style={{ color: 'var(--text-secondary)' }}>
            {t('offerDetails.notFound', {
              defaultValue: 'Offer not found on this chain.',
            })}
          </p>
        </div>
      ) : (
        <>
          {/* Header — status badge + key actions on the right. */}
          <div className="card" style={{ marginTop: 16 }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 12,
                flexWrap: 'wrap',
                marginBottom: 16,
              }}
            >
              <div
                style={{ display: 'flex', alignItems: 'center', gap: 12 }}
              >
                <span
                  className={`status-badge ${
                    offerForDisplay.offerType === 0 ? 'lender' : 'borrower'
                  }`}
                >
                  {OFFER_TYPE_LABELS[offerForDisplay.offerType]}
                </span>
                <StatusBadge status={status} t={t} />
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {/* Creator-only "Manage keepers" deep-link mirroring
                    the OfferBook row affordance. Today this lands on
                    the generic /app/keepers page rather than a per-
                    offer route — the page itself surfaces every
                    offer the wallet owns. */}
                {isCreator && status === 'active' && (
                  <Link to="/app/keepers" className="btn btn-secondary btn-sm">
                    <Settings size={14} style={{ marginRight: 4 }} />
                    {t('offerDetails.manageKeepers', {
                      defaultValue: 'Manage keepers',
                    })}
                  </Link>
                )}
                {canCancel && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={cancelling}
                    onClick={onCancel}
                  >
                    <X size={14} style={{ marginRight: 4 }} />
                    {cancelling
                      ? t('offerDetails.cancelling', {
                          defaultValue: 'Cancelling…',
                        })
                      : t('offerDetails.cancel', {
                          defaultValue: 'Cancel offer',
                        })}
                  </button>
                )}
                {linkedLoanId && (
                  <Link
                    to={`/app/loans/${linkedLoanId}`}
                    className="btn btn-primary btn-sm"
                  >
                    {t('offerDetails.viewLoan', {
                      defaultValue: 'View loan #{{id}}',
                      id: linkedLoanId,
                    })}
                  </Link>
                )}
              </div>
            </div>

            {cancelError && (
              <div style={{ marginBottom: 12 }}>
                <ErrorAlert message={cancelError} />
              </div>
            )}

            <div className="loan-details-grid">
              <Field label={t('offerDetails.principal', { defaultValue: 'Principal' })}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <TokenIcon
                    chainId={chainId}
                    address={offerForDisplay.lendingAsset}
                  />
                  <TokenAmount
                    amount={offerForDisplay.amount}
                    address={offerForDisplay.lendingAsset}
                  />{' '}
                  <AssetLink
                    kind="erc20"
                    chainId={chainId}
                    address={offerForDisplay.lendingAsset}
                  />
                </span>
              </Field>

              <Field label={t('offerDetails.rate', { defaultValue: 'Rate' })}>
                {bpsToPercent(offerForDisplay.interestRateBps)}
              </Field>

              <Field label={t('offerDetails.duration', { defaultValue: 'Duration' })}>
                {offerForDisplay.durationDays.toString()}{' '}
                {t('loanDetails.daysSuffix', { defaultValue: 'days' })}
              </Field>

              <Field
                label={t('offerDetails.collateral', { defaultValue: 'Collateral' })}
              >
                <span
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                >
                  {offerForDisplay.collateralAsset !== ZERO_ADDR && (
                    <TokenIcon
                      chainId={chainId}
                      address={offerForDisplay.collateralAsset}
                    />
                  )}
                  <TokenAmount
                    amount={offerForDisplay.collateralAmount}
                    address={offerForDisplay.collateralAsset}
                  />{' '}
                  <AssetLink
                    kind="erc20"
                    chainId={chainId}
                    address={offerForDisplay.collateralAsset}
                  />
                </span>
              </Field>

              <Field label={t('offerDetails.creator', { defaultValue: 'Creator' })}>
                <AddressDisplay address={offerForDisplay.creator} />
              </Field>

              {offerForDisplay.allowsPartialRepay && (
                <Field
                  label={t('offerDetails.partialRepay', {
                    defaultValue: 'Partial repay',
                  })}
                >
                  {t('common.yes', { defaultValue: 'Yes' })}
                </Field>
              )}

              {indexed && (
                <Field
                  label={t('offerDetails.firstSeen', {
                    defaultValue: 'First seen',
                  })}
                >
                  <span
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                  >
                    {formatDate(indexed.firstSeenAt * 1000)}
                    {/* Tx-hash link is preferred — points at the
                        OfferCreated transaction directly so the user
                        lands on the calldata that matched their
                        offer. Falls back to the block-link when the
                        targeted log scan is still pending OR returned
                        nothing (RPC ToS rejection, log gone after
                        reorg, etc.). */}
                    {createdTxHash ? (
                      <a
                        href={`${blockExplorer}/tx/${createdTxHash}`}
                        target="_blank"
                        rel="noreferrer noopener"
                        title={t('offerDetails.viewTx', {
                          defaultValue: 'View creation transaction on block explorer',
                        })}
                      >
                        <ExternalLink size={12} />
                      </a>
                    ) : (
                      <a
                        href={`${blockExplorer}/block/${indexed.firstSeenBlock}`}
                        target="_blank"
                        rel="noreferrer noopener"
                        title={t('offerDetails.viewBlockExplorer', {
                          defaultValue: 'View block on block explorer',
                        })}
                      >
                        <ExternalLink size={12} />
                      </a>
                    )}
                  </span>
                </Field>
              )}

              {/* Partial-fill indicator. Only renders when the indexer
                  actually reports a non-trivial fill (`amountFilled`
                  > 0 AND < `amountMax`). Pre-Phase-1 partial-fill
                  rollout, every offer is single-fill so this branch
                  is dormant. Forward-compatible — once the partial-
                  fill plan ships, the indexer's `amountFilled`
                  starts populating and this surface lights up
                  without any code change here. */}
              {indexed &&
                BigInt(indexed.amountFilled) > 0n &&
                BigInt(indexed.amountFilled) < BigInt(indexed.amountMax) && (
                  <Field
                    label={t('offerDetails.amountFilled', {
                      defaultValue: 'Amount filled',
                    })}
                  >
                    <TokenAmount
                      amount={BigInt(indexed.amountFilled)}
                      address={offerForDisplay.lendingAsset}
                    />
                    {' '}/{' '}
                    <TokenAmount
                      amount={BigInt(indexed.amountMax)}
                      address={offerForDisplay.lendingAsset}
                    />
                  </Field>
                )}
            </div>

            {/* Indexer / fallback provenance — small print. Helps the
                user (and us, debugging in the field) figure out which
                source the row's data came from. */}
            <div
              style={{
                marginTop: 16,
                fontSize: '0.7rem',
                opacity: 0.55,
              }}
            >
              {indexed
                ? t('offerDetails.sourceIndexer', {
                    defaultValue: 'Source: indexer cache',
                  })
                : t('offerDetails.sourceChain', {
                    defaultValue: 'Source: direct chain read',
                  })}
            </div>
          </div>

          {/* Phase 2 placeholder — partial-fill history, keeper config
              inline editor, accept-button surface for the OFFER side
              (today users accept from OfferBook only). */}
        </>
      )}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="loan-detail-field">
      <div className="loan-detail-label">{label}</div>
      <div className="loan-detail-value">{children}</div>
    </div>
  );
}

function StatusBadge({
  status,
  t,
}: {
  status: OfferStatus;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const map: Record<OfferStatus, { label: string; bg: string; fg: string }> = {
    active: {
      label: t('myOffersTable.statusActive', { defaultValue: 'Active' }),
      bg: 'var(--brand-bg, rgba(34,197,94,0.15))',
      fg: 'var(--brand, #22c55e)',
    },
    accepted: {
      label: t('myOffersTable.statusFilled', { defaultValue: 'Filled' }),
      bg: 'var(--surface-2)',
      fg: 'var(--text-primary)',
    },
    cancelled: {
      label: t('myOffersTable.statusCancelled', { defaultValue: 'Cancelled' }),
      bg: 'var(--surface-2)',
      fg: 'var(--muted)',
    },
    expired: {
      label: t('offerDetails.statusExpired', { defaultValue: 'Expired' }),
      bg: 'var(--surface-2)',
      fg: 'var(--muted)',
    },
    unknown: {
      label: t('offerDetails.statusUnknown', { defaultValue: 'Unknown' }),
      bg: 'var(--surface-2)',
      fg: 'var(--muted)',
    },
  };
  const m = map[status];
  return (
    <span
      className="status-badge"
      style={{ background: m.bg, color: m.fg }}
    >
      {m.label}
    </span>
  );
}
