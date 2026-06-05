import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ExternalLink, X } from 'lucide-react';
import { type Hex } from 'viem';
import { L as Link } from '../components/L';
import { useWallet } from '../context/WalletContext';
import { useDiamondContract, useDiamondRead, useReadChain } from '../contracts/useDiamond';
import { DEFAULT_CHAIN } from '../contracts/config';
import {
  fetchActivity,
  fetchOfferById,
  indexedToRawOffer,
  type IndexedOffer,
} from '../lib/indexerClient';
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
import { TokenIcon } from '@vaipakam/ui/TokenIcon';
import { ErrorAlert } from '../components/app/ErrorAlert';
import { decodeContractError } from '@vaipakam/lib/decodeContractError';
import { PerThingKeeperToggles } from '../components/app/PerThingKeeperToggles';

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

/** T-086 Round-8 §19.7e — `consumed_by_sale` is the parallel-sale
 *  Scenario A terminal (buyer fills the offer's NFT collateral before
 *  any lender accepts). Routed here by the MyOffersTable "Sold" row
 *  link via `Link to /app/offers/{offerId}` per Codex round-14 P2. */
type OfferStatus =
  | 'active'
  | 'accepted'
  | 'cancelled'
  | 'expired'
  | 'consumed_by_sale'
  | 'unknown';

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
  // Tx hash of the OfferCreated event. Resolved lazily via the
  // indexer's activity feed (`/activity?offerId=N&kind=OfferCreated`)
  // — the worker already captured the tx hash when it indexed the
  // event into the `activity_events` table, so this is one HTTP
  // call with no chain reads. The previous implementation did a
  // targeted single-block `eth_getLogs` against the user's RPC,
  // which silently returned 0 logs on public providers that throttle
  // or restrict log queries (the row would never appear regardless
  // of how long the user waited).
  const [createdTxHash, setCreatedTxHash] = useState<Hex | null>(null);

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

  // Resolve the OfferCreated tx-hash via the indexer's activity
  // endpoint. The worker captured the hash into D1 at indexing time;
  // a filtered `/activity?offerId=N&kind=OfferCreated&limit=1` call
  // returns it directly. Single HTTP call, zero chain reads, no
  // dependency on the user's RPC honouring topic-filtered log
  // queries (which is what made the earlier `eth_getLogs` approach
  // fail silently on restrictive public RPCs — the row would never
  // appear regardless of wait time).
  useEffect(() => {
    if (!indexed) return;
    if (createdTxHash) return;
    let cancelled = false;
    (async () => {
      try {
        const page = await fetchActivity(chainId, {
          offerId: indexed.offerId,
          kind: 'OfferCreated',
          limit: 1,
        });
        if (cancelled) return;
        const ev = page?.events?.[0];
        if (ev?.txHash) {
          setCreatedTxHash(ev.txHash as Hex);
        }
      } catch {
        // Silent — the explorer link just stays hidden. The page
        // still renders fine without the tx hash; the existing
        // "First seen" block link is the fallback affordance.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [indexed, chainId, createdTxHash]);

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

            {/* Two-column "Label | Value" rows using the existing
                `.data-row` / `.data-label` / `.data-value` chrome
                from AppLayout.css — same shape Loan Details uses,
                so the visual rhythm carries across detail surfaces.
                Earlier iteration used non-existent
                `.loan-detail-*` classes which fell back to the
                default block layout (label-on-its-own-line, value-
                on-its-own-line) — that's the "juggled" appearance
                the screenshot caught. */}
            <div>
              <div className="data-row">
                <span className="data-label">
                  {t('offerDetails.principal', { defaultValue: 'Principal' })}
                </span>
                <span
                  className="data-value"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                >
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
              </div>

              <div className="data-row">
                <span className="data-label">
                  {t('offerDetails.rate', { defaultValue: 'Rate' })}
                </span>
                <span className="data-value">
                  {bpsToPercent(offerForDisplay.interestRateBps)}
                </span>
              </div>

              <div className="data-row">
                <span className="data-label">
                  {t('offerDetails.duration', { defaultValue: 'Duration' })}
                </span>
                <span className="data-value">
                  {offerForDisplay.durationDays.toString()}{' '}
                  {t('loanDetails.daysSuffix', { defaultValue: 'days' })}
                </span>
              </div>

              <div className="data-row">
                <span className="data-label">
                  {t('offerDetails.collateral', { defaultValue: 'Collateral' })}
                </span>
                <span
                  className="data-value"
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
              </div>

              <div className="data-row">
                <span className="data-label">
                  {t('offerDetails.creator', { defaultValue: 'Creator' })}
                </span>
                <span className="data-value">
                  <AddressDisplay address={offerForDisplay.creator} />
                </span>
              </div>

              {offerForDisplay.allowsPartialRepay && (
                <div className="data-row">
                  <span className="data-label">
                    {t('offerDetails.partialRepay', {
                      defaultValue: 'Partial repay',
                    })}
                  </span>
                  <span className="data-value">
                    {t('common.yes', { defaultValue: 'Yes' })}
                  </span>
                </div>
              )}

              {/* Position NFT — minted to the creator at offer
                  creation, transferable. The Diamond itself is the
                  ERC-721 issuer (via VaipakamNFTFacet), so the
                  verifier link points at the Diamond as the
                  contract. Hidden when `positionTokenId` is 0
                  (legacy offers indexed before the field was
                  populated, or fallback path with no indexer data). */}
              {indexed &&
                indexed.positionTokenId &&
                indexed.positionTokenId !== '0' &&
                readChain.diamondAddress && (
                  <div className="data-row">
                    <span className="data-label">
                      {t('offerDetails.positionNft', {
                        defaultValue: 'Position NFT',
                      })}
                    </span>
                    <span
                      className="data-value"
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                      }}
                    >
                      <Link
                        to={`/nft-verifier?contract=${readChain.diamondAddress}&id=${indexed.positionTokenId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={t('offerDetails.positionNftTitle', {
                          defaultValue:
                            'Verify this position NFT in the Vaipakam NFT Verifier (opens in new tab)',
                        })}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                          color: 'inherit',
                          textDecoration: 'none',
                        }}
                      >
                        #{indexed.positionTokenId}
                        <ExternalLink
                          size={12}
                          aria-hidden="true"
                          style={{
                            color: 'var(--brand)',
                            flexShrink: 0,
                          }}
                        />
                      </Link>
                    </span>
                  </div>
                )}

              {/* Principal NFT — only meaningful when the offer's
                  principal is an NFT asset (assetType !== ERC20).
                  Links to the verifier with the underlying NFT
                  contract + tokenId so users can confirm it's the
                  expected asset before accepting. */}
              {indexed &&
                indexed.assetType !== 0 &&
                indexed.tokenId &&
                indexed.tokenId !== '0' && (
                  <div className="data-row">
                    <span className="data-label">
                      {t('offerDetails.principalNft', {
                        defaultValue: 'Principal NFT ID',
                      })}
                    </span>
                    <span
                      className="data-value"
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                      }}
                    >
                      <Link
                        to={`/nft-verifier?contract=${offerForDisplay.lendingAsset}&id=${indexed.tokenId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={t('offerDetails.principalNftTitle', {
                          defaultValue:
                            'Verify the principal NFT in the Vaipakam NFT Verifier (opens in new tab)',
                        })}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                          color: 'inherit',
                          textDecoration: 'none',
                        }}
                      >
                        #{indexed.tokenId}
                        <ExternalLink
                          size={12}
                          aria-hidden="true"
                          style={{
                            color: 'var(--brand)',
                            flexShrink: 0,
                          }}
                        />
                      </Link>
                    </span>
                  </div>
                )}

              {/* Collateral NFT — same shape as Principal NFT, gated
                  on collateralAssetType !== ERC20. */}
              {indexed &&
                indexed.collateralAssetType !== 0 &&
                indexed.collateralTokenId &&
                indexed.collateralTokenId !== '0' && (
                  <div className="data-row">
                    <span className="data-label">
                      {t('offerDetails.collateralNft', {
                        defaultValue: 'Collateral NFT ID',
                      })}
                    </span>
                    <span
                      className="data-value"
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                      }}
                    >
                      <Link
                        to={`/nft-verifier?contract=${offerForDisplay.collateralAsset}&id=${indexed.collateralTokenId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={t('offerDetails.collateralNftTitle', {
                          defaultValue:
                            'Verify the collateral NFT in the Vaipakam NFT Verifier (opens in new tab)',
                        })}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                          color: 'inherit',
                          textDecoration: 'none',
                        }}
                      >
                        #{indexed.collateralTokenId}
                        <ExternalLink
                          size={12}
                          aria-hidden="true"
                          style={{
                            color: 'var(--brand)',
                            flexShrink: 0,
                          }}
                        />
                      </Link>
                    </span>
                  </div>
                )}

              {indexed && (
                <div className="data-row">
                  <span className="data-label">
                    {t('offerDetails.firstSeen', {
                      defaultValue: 'First seen',
                    })}
                  </span>
                  <span
                    className="data-value"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    {formatDate(indexed.firstSeenAt * 1000)}
                    <a
                      href={`${blockExplorer}/block/${indexed.firstSeenBlock}`}
                      target="_blank"
                      rel="noreferrer noopener"
                      title={t('offerDetails.viewBlockExplorer', {
                        defaultValue: 'View block on block explorer',
                      })}
                    >
                      <ExternalLink
                        size={12}
                        aria-hidden="true"
                        style={{
                          color: 'var(--brand)',
                          flexShrink: 0,
                        }}
                      />
                    </a>
                  </span>
                </div>
              )}

              {/* Creation transaction hash — explicit row instead of
                  hiding behind an icon next to "First seen". Renders
                  the redacted hash (`0xabcd…1234`) as the visible
                  link target so users see at a glance what they're
                  navigating to. Resolved lazily via the targeted
                  single-block log scan in the effect above; while
                  pending OR if the lookup failed (RPC ToS rejection,
                  reorg) the row stays hidden — the "First seen"
                  block link above is the fallback affordance. */}
              {createdTxHash && (
                <div className="data-row">
                  <span className="data-label">
                    {t('offerDetails.creationTx', {
                      defaultValue: 'Creation tx',
                    })}
                  </span>
                  <span
                    className="data-value"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    <a
                      href={`${blockExplorer}/tx/${createdTxHash}`}
                      target="_blank"
                      rel="noreferrer noopener"
                      title={t('offerDetails.viewTx', {
                        defaultValue:
                          'View creation transaction on block explorer',
                      })}
                      style={{ fontFamily: 'monospace' }}
                    >
                      {`${createdTxHash.slice(0, 6)}…${createdTxHash.slice(-4)}`}
                    </a>
                    <ExternalLink
                      size={12}
                      aria-hidden="true"
                      style={{
                        color: 'var(--brand)',
                        flexShrink: 0,
                      }}
                    />
                  </span>
                </div>
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
                  <div className="data-row">
                    <span className="data-label">
                      {t('offerDetails.amountFilled', {
                        defaultValue: 'Amount filled',
                      })}
                    </span>
                    <span className="data-value">
                      <TokenAmount
                        amount={BigInt(indexed.amountFilled)}
                        address={offerForDisplay.lendingAsset}
                      />
                      {' '}/{' '}
                      <TokenAmount
                        amount={BigInt(indexed.amountMax)}
                        address={offerForDisplay.lendingAsset}
                      />
                    </span>
                  </div>
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

          {/* Per-offer keeper toggles (gate 3 of the Phase-6 keeper
              auth model). Creator-only, hidden post-acceptance — see
              PerThingKeeperToggles for the full gate-3 rationale.
              The component itself defends against an off-creator
              caller, so the visibility gate here just keeps the
              non-creator UI tight. */}
          {isCreator && offerForDisplay && status === 'active' && (
            <PerThingKeeperToggles
              kind="offer"
              offerId={offerIdBig!}
              ownerAddress={offerForDisplay.creator}
              isAccepted={false}
            />
          )}
        </>
      )}
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
    consumed_by_sale: {
      label: t('myOffersTable.statusSold', { defaultValue: 'Sold' }),
      bg: 'var(--success-bg, var(--surface-2))',
      fg: 'var(--success-fg, var(--text))',
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
