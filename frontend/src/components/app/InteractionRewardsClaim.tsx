import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, CheckCircle, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { L as Link } from '../L';
import { useDiamondContract } from '../../contracts/useDiamond';
import { useInteractionRewards } from '../../hooks/useInteractionRewards';
import {
  useInteractionRewardEntries,
  type InteractionRewardEntry,
} from '../../hooks/useInteractionRewardEntries';
import { useLogIndex } from '../../hooks/useLogIndex';
import { decodeContractError } from '../../lib/decodeContractError';
import { beginStep } from '../../lib/journeyLog';
import { TokenAmount } from './TokenAmount';
import { ErrorAlert } from './ErrorAlert';

interface Props {
  /** Connected wallet address. Disconnected wallets see nothing. */
  address: string | null | undefined;
  /** Connected wallet's chainId, threaded through to journeyLog. */
  chainId: number | null | undefined;
  /** Block-explorer base URL for tx-hash deep links (no trailing slash). */
  blockExplorer: string;
}

/**
 * Inline claim card for the platform-interaction VPFI reward stream.
 * Lives at the top of Claim Center alongside the per-loan claim rows.
 *
 * Hides itself when the wallet has zero pending and isn't waiting on a
 * cross-chain finalization — a fresh user who hasn't yet engaged with
 * the platform doesn't see a "0 VPFI" prompt. When the spec §4a
 * finalization gate is open (claimability returns
 * `finalizedPrefix === false && waitingForDay > 0`), the card surfaces
 * a "waiting on day X" status instead of a claim button so the user
 * understands a click would revert. Once finalization lands, the card
 * flips to an active Claim button driven by `previewInteractionRewards`.
 */
export function InteractionRewardsClaim({ address, chainId, blockExplorer }: Props) {
  const { t } = useTranslation();
  const diamond = useDiamondContract();
  const { pending, finalizedPrefix, waitingForDay, stale, reload, loading } =
    useInteractionRewards(address ?? null);
  const { entries, reload: reloadEntries } = useInteractionRewardEntries(address ?? null);
  // Lifetime claimed VPFI is summed from `InteractionRewardsClaimed`
  // events in the log-index — no on-chain getter exists for that
  // running total, but the events carry the full history. Filter to
  // events touching the connected wallet.
  const { events } = useLogIndex();
  const lifetimeClaimed = useMemo(() => {
    if (!address) return 0n;
    const me = address.toLowerCase();
    let sum = 0n;
    for (const ev of events) {
      if (ev.kind !== 'InteractionRewardsClaimed') continue;
      if (typeof ev.args.user !== 'string' || ev.args.user !== me) continue;
      if (typeof ev.args.amount !== 'string') continue;
      try { sum += BigInt(ev.args.amount); } catch { /* skip malformed */ }
    }
    return sum;
  }, [events, address]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  if (!address) return null;
  if (stale) return null;
  // Render when ANY of: pending > 0, waiting on finalization, lifetime
  // claimed > 0 (so historical claimers still see their lifetime
  // total), or there's at least one contributing loan recorded
  // on-chain (so an active participant who hasn't yet claimed sees
  // the breakdown). Hide entirely for fresh users with none of the
  // above to avoid a "0 VPFI" promo.
  const isWaiting = !finalizedPrefix && waitingForDay > 0n;
  const hasAnything =
    pending > 0n || isWaiting || lifetimeClaimed > 0n || entries.length > 0;
  if (!hasAnything) return null;

  const handleClaim = async () => {
    if (pending === 0n) return;
    setSubmitting(true);
    setError(null);
    setTxHash(null);
    const step = beginStep({
      area: 'rewards',
      flow: 'claimInteractionRewards',
      step: 'submit-tx',
      wallet: address,
      chainId,
    });
    try {
      const tx = await diamond.claimInteractionRewards();
      setTxHash(tx.hash);
      await tx.wait();
      reload();
      reloadEntries();
      step.success({ note: `tx ${tx.hash}` });
    } catch (err) {
      setError(decodeContractError(err, t('interactionRewards.claimFailed')));
      step.failure(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="card"
      style={{
        marginBottom: 16,
        borderColor: 'var(--brand)',
        background: 'rgba(79, 70, 229, 0.06)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 36,
            height: 36,
            borderRadius: '50%',
            background: 'rgba(79, 70, 229, 0.15)',
            color: 'var(--brand)',
            flexShrink: 0,
          }}
        >
          <Activity size={18} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {t('interactionRewards.title')}
          </div>
          <p className="stat-label" style={{ margin: 0 }}>
            {t('interactionRewards.subtitle')}
          </p>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              flexWrap: 'wrap',
              marginTop: 12,
            }}
          >
            <div>
              <div style={{ fontSize: '0.78rem', color: 'var(--text-tertiary)' }}>
                {t('interactionRewards.pendingLabel')}
              </div>
              <div style={{ fontSize: '1.2rem', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                <TokenAmount amount={pending} address="vpfi" decimals={18} /> VPFI
              </div>
            </div>
            {/* Lifetime claimed total — sums every InteractionRewardsClaimed
                event in the log-index that's keyed to this wallet. Hidden
                when zero so a first-time claimer sees only "Pending". */}
            {lifetimeClaimed > 0n && (
              <div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-tertiary)' }}>
                  {t('interactionRewards.lifetimeClaimedLabel')}
                </div>
                <div style={{ fontSize: '1.05rem', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                  <TokenAmount amount={lifetimeClaimed} address="vpfi" decimals={18} /> VPFI
                </div>
              </div>
            )}
            {isWaiting ? (
              <span
                className="status-badge"
                data-tooltip={t('interactionRewards.waitingTooltip', {
                  day: waitingForDay.toString(),
                })}
                style={{
                  background: 'rgba(245, 158, 11, 0.12)',
                  color: 'var(--accent-orange, #f59e0b)',
                }}
              >
                {t('interactionRewards.waiting', { day: waitingForDay.toString() })}
              </span>
            ) : (
              <button
                className="btn btn-primary btn-sm"
                onClick={handleClaim}
                disabled={submitting || pending === 0n || loading}
              >
                {submitting ? t('interactionRewards.claiming') : t('interactionRewards.claim')}
              </button>
            )}
          </div>

          {/* Contributing-loans expandable list. Each row links to the
              loan's full Loan Details page where the user can see the
              underlying interest accrual. Rewards aren't directly
              attributable to a per-loan VPFI amount (they're daily-
              normalised by the global denominator), so the row shows
              cumulative interest contribution in 18-decimal USD rather
              than a fictitious "earned X VPFI on loan Y" figure. */}
          {entries.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="btn btn-ghost btn-sm"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 8px' }}
                aria-expanded={expanded}
              >
                {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                {t('interactionRewards.contributingLoans', { count: entries.length })}
              </button>
              {expanded && (
                <ul className="reward-entries-list" style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {entries.map((e, i) => (
                    <RewardEntryRow key={`${e.loanId.toString()}-${e.side}-${i}`} entry={e} />
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>

      {error && <div style={{ marginTop: 12 }}><ErrorAlert message={error} /></div>}
      {txHash && (
        <div className="alert alert-success" style={{ marginTop: 12 }}>
          <CheckCircle size={16} />
          <span>
            {t('interactionRewards.submitted')}{' '}
            <a href={`${blockExplorer}/tx/${txHash}`} target="_blank" rel="noreferrer">
              {txHash.slice(0, 16)}…<ExternalLink size={11} style={{ verticalAlign: 'middle' }} />
            </a>
          </span>
        </div>
      )}
    </div>
  );
}

interface RewardEntryRowProps {
  entry: InteractionRewardEntry;
}

/**
 * One row in the "Contributing loans" expandable list. Renders the loan
 * id (clickable → /app/loans/X), the side (lender / borrower), and the
 * cumulative USD interest contribution computed as
 * `perDayUSD18 * (endDay || open) - startDay`. Forfeited entries (e.g.
 * defaulted-borrower side) are visually de-emphasised since they no
 * longer feed the user's daily share.
 */
function RewardEntryRow({ entry }: RewardEntryRowProps) {
  const { t } = useTranslation();
  // For open entries (`endDay === 0`) the row labels the contribution
  // as "ongoing" rather than computing a moving total — `today` would
  // need an on-chain read and the user can navigate to Loan Details
  // for the full picture anyway. Closed entries get the snapshot
  // contribution in 18-decimal USD.
  const isOpen = entry.endDay === 0;
  const days = isOpen ? 0 : Math.max(0, entry.endDay - entry.startDay);
  const totalContribUsd18 = isOpen ? 0n : entry.perDayUSD18 * BigInt(days);
  return (
    <li
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 8px',
        border: '1px solid var(--border)',
        borderRadius: 6,
        background: 'var(--bg-card)',
        opacity: entry.forfeited ? 0.55 : 1,
      }}
    >
      <Link
        to={`/app/loans/${entry.loanId.toString()}`}
        style={{ color: 'var(--brand)', fontWeight: 600 }}
      >
        {t('interactionRewards.entryLoanLink', { id: entry.loanId.toString() })}
      </Link>
      <span className="status-badge" style={{ textTransform: 'capitalize' }}>
        {t(`interactionRewards.side.${entry.side}`)}
      </span>
      <span className="stat-label" style={{ marginLeft: 'auto', fontSize: '0.8rem' }}>
        {entry.forfeited
          ? t('interactionRewards.entryForfeited')
          : isOpen
            ? t('interactionRewards.entryOngoing', {
                rate: (Number(entry.perDayUSD18) / 1e18).toFixed(2),
              })
            : t('interactionRewards.entryClosed', {
                total: (Number(totalContribUsd18) / 1e18).toFixed(2),
                days,
              })}
      </span>
    </li>
  );
}
