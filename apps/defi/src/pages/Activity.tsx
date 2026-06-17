import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createPublicClient, http } from 'viem';
import { L as Link } from '../components/L';
import {
  Activity as ActivityIcon,
  ChevronDown,
  ChevronRight,
  ExternalLink,
} from 'lucide-react';
import { useLogIndex } from '../hooks/useLogIndex';
import { useIndexedActivity } from '../hooks/useIndexedActivity';
import { useRescanCooldown } from '../hooks/useRescanCooldown';
import { RescanButton } from '../components/app/RescanButton';
import { DataSyncStatus } from '../components/app/DataSyncStatus';
import { indexedToActivityEvent } from '../lib/indexerClient';
import { useUserLoans } from '../hooks/useUserLoans';
import { useWallet } from '../context/WalletContext';
import { useReadChain } from '../contracts/useDiamond';
import type { ActivityEvent, ActivityEventKind } from '../lib/logIndex';
import { shortenAddr, formatUnitsPretty, formatRelativeTime, formatDateTime } from '../lib/format';
import { Pager } from '../components/app/Pager';
import { CardInfo } from '../components/CardInfo';
import './Activity.css';

const PAGE_SIZE = 15;

type KindFilter = 'all' | ActivityEventKind;

// Friendly labels for the event-kind enum surfaced by `useLogIndex`.
const KIND_LABELS: Record<ActivityEventKind, string> = {
  OfferCreated: 'Offer created',
  OfferAccepted: 'Offer accepted',
  OfferCanceled: 'Offer canceled',
  // OfferCanceledDetails is a companion event emitted alongside
  // OfferCanceled — same user action, just with the full offer terms
  // for cancelled-row reconstruction. Hidden from the Activity feed
  // (filtered out below) so it doesn't show up as a duplicate row.
  OfferCanceledDetails: 'Offer canceled (detail)',
  OfferConsumedBySale: 'Offer sold via OpenSea',
  LoanInitiated: 'Loan initiated',
  LoanRepaid: 'Loan repaid',
  LoanDefaulted: 'Loan defaulted',
  LenderFundsClaimed: 'Lender claimed',
  BorrowerFundsClaimed: 'Borrower claimed',
  CollateralAdded: 'Collateral added',
  LoanSold: 'Lender position sold',
  LoanObligationTransferred: 'Borrower position transferred',
  // T-092 Phase 3 (#503).
  LoanExtended: 'Loan extended in place',
  LoanSettlementBreakdown: 'Settlement breakdown',
  LiquidationFallback: 'Liquidation fallback',
  LiquidationFallbackSplit: 'Fallback collateral split',
  LoanSettled: 'Loan settled',
  IntentLoanRolled: 'Auto-rolled & re-lent',
  PartialRepaid: 'Partial repayment',
  // T-090 Sub 3 — borrower-initiated swap-to-repay surface.
  SwapToRepayExecuted: 'Loan repaid via collateral swap',
  SwapToRepayPartialExecuted: 'Partial repayment via collateral swap',
  // T-090 v1.1 (#389) Sub 3 (#418) — intent-based swap-to-repay
  // surface. Solver-fulfilled commit → atomic settlement.
  SwapToRepayIntentCommitted: 'Best-price swap-to-repay intent committed',
  SwapToRepayIntentFilled: 'Loan repaid via best-price intent',
  SwapToRepayIntentCancelled: 'Best-price intent cancelled',
  SwapToRepayIntentForceCancelled: 'Best-price intent force-cancelled (lender protection)',
  ClaimRetryExecuted: 'Claim-time swap retry',
  BorrowerLifRebateClaimed: 'VPFI rebate claimed',
  StakingRewardsClaimed: 'VPFI staking rewards claimed',
  InteractionRewardsClaimed: 'Platform-interaction rewards claimed',
  VPFIPurchasedWithETH: 'VPFI bought with ETH',
  VPFIDepositedToVault: 'VPFI staked to vault',
  VPFIWithdrawnFromVault: 'VPFI unstaked from vault',
};

// Kind-kind → primary row accent colour class. Mirrors status accents from the
// old journey-log view so the page still scans visually.
const KIND_ACCENT: Record<ActivityEventKind, string> = {
  OfferCreated: 'info',
  OfferAccepted: 'success',
  OfferCanceled: 'failure',
  OfferCanceledDetails: 'failure',
  OfferConsumedBySale: 'success',
  LoanInitiated: 'success',
  LoanRepaid: 'success',
  LoanDefaulted: 'failure',
  LenderFundsClaimed: 'info',
  BorrowerFundsClaimed: 'info',
  CollateralAdded: 'info',
  LoanSold: 'info',
  LoanObligationTransferred: 'info',
  LoanExtended: 'info',
  LoanSettlementBreakdown: 'success',
  LiquidationFallback: 'failure',
  LiquidationFallbackSplit: 'failure',
  LoanSettled: 'success',
  IntentLoanRolled: 'success',
  PartialRepaid: 'info',
  // T-090 Sub 3 — `success` for full close (Active → Repaid),
  // `info` for partial (loan stays Active).
  SwapToRepayExecuted: 'success',
  SwapToRepayPartialExecuted: 'info',
  // v1.1 intent variants — commit/cancel are info (loan still
  // Active), Filled is success (terminal close), ForceCancelled
  // is warning (lender-protection action drove it).
  SwapToRepayIntentCommitted: 'info',
  SwapToRepayIntentFilled: 'success',
  SwapToRepayIntentCancelled: 'info',
  SwapToRepayIntentForceCancelled: 'warning',
  ClaimRetryExecuted: 'info',
  BorrowerLifRebateClaimed: 'info',
  StakingRewardsClaimed: 'success',
  InteractionRewardsClaimed: 'success',
  VPFIPurchasedWithETH: 'success',
  VPFIDepositedToVault: 'success',
  VPFIWithdrawnFromVault: 'info',
};

interface TxGroup {
  txHash: string;
  blockNumber: number;
  primaryKind: ActivityEventKind;
  events: ActivityEvent[];
}

/**
 * Formats a unix-seconds block timestamp as a relative / absolute time string
 * using the same scale as the previous journey-log renderer (just now → Nm ago
 * → Nh ago → absolute).
 */
function formatBlockTime(unixSeconds: number | undefined): string {
  if (!unixSeconds) return '';
  const ms = unixSeconds * 1000;
  const diff = Date.now() - ms;
  // Within the last 24h: locale-aware relative-time string ("2 minutes
  // ago" / "il y a 5 heures" / "5분 전"). Beyond 24h: absolute date+time
  // in the locale's standard short format.
  if (diff < 86_400_000) return formatRelativeTime(ms);
  return formatDateTime(ms);
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-8)}`;
}

/**
 * Pick the "headline" event for a tx that emitted several. A single accept of
 * a borrow offer, for instance, fires `OfferAccepted` + `LoanInitiated` +
 * several `Transfer`s — `LoanInitiated` is the one worth surfacing. Ordering
 * is by semantic importance, not log index.
 */
const KIND_PRIORITY: ActivityEventKind[] = [
  'LoanDefaulted',
  'LoanRepaid',
  'SwapToRepayExecuted',
  // T-090 Sub 3 — periodic-interest loans emit
  // `RepayPartialPeriodAdvanced` + `PeriodicInterestSettled` in the
  // same tx as `swapToRepayPartial`. Without the partial kind in this
  // priority list, `pickPrimary` would fall back to the first
  // periodic event (which isn't in the priority list either) and
  // surface a less-meaningful headline for the row. Put it just
  // below the full-close kind so the partial reduction itself is
  // the headline, not its periodic side-effect.
  'SwapToRepayPartialExecuted',
  // T-090 v1.1 (#389) Sub 3 (#418) — intent-fill terminal close
  // is the headline of any tx that emits it (same priority as
  // `SwapToRepayExecuted`); commit / cancel / force-cancel are
  // worth surfacing as the headline when they're the only
  // intent-related event, but they don't carry a loan terminal so
  // they sit below the close kinds.
  'SwapToRepayIntentFilled',
  'SwapToRepayIntentForceCancelled',
  'SwapToRepayIntentCommitted',
  'SwapToRepayIntentCancelled',
  'LoanInitiated',
  'LoanSold',
  'LoanObligationTransferred',
  'LoanExtended',
  'OfferAccepted',
  'CollateralAdded',
  'LenderFundsClaimed',
  'BorrowerFundsClaimed',
  'VPFIPurchasedWithETH',
  'VPFIDepositedToVault',
  'VPFIWithdrawnFromVault',
  'OfferCreated',
  'OfferCanceled',
  // T-086 Round-8 §19.7e + Codex round-20 P3 — parallel-sale
  // Scenario A terminal. Both `pickPrimary` (drives the rolled-up
  // tx headline) and the filter-chip generator
  // (`KIND_PRIORITY.filter(... kindsPresent)`) read this list, so
  // the entry surfaces the sold-via-OpenSea kind in the toolbar
  // filter without an extra config.
  'OfferConsumedBySale',
];

function pickPrimary(events: ActivityEvent[]): ActivityEventKind {
  for (const kind of KIND_PRIORITY) {
    if (events.some((e) => e.kind === kind)) return kind;
  }
  return events[0].kind;
}

/**
 * Render one argument row in the expanded details panel. Bigint-ish fields
 * (principal / amount / collateralAmount) are formatted with 18-decimal ETH-
 * style pretty-printing; addresses are shortened; booleans and offer-type
 * enums pass through as strings.
 */
function renderArgValue(key: string, value: string | number | boolean): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') return String(value);
  // Address heuristic: 0x + 40 hex chars.
  if (typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value)) {
    return shortenAddr(value);
  }
  // Treat string-encoded bigints as token amounts if the key hints that way.
  const amountKeys = new Set([
    'principal',
    'collateralAmount',
    'amount',
    'amountAdded',
    'newCollateralAmount',
    'interestPaid',
    'lateFeePaid',
    'vpfiAmount',
    'ethAmount',
    // T-090 Sub 3 — `collateralIn` / `principalOut` /
    // `partialPrincipal` are deliberately NOT included here, because
    // the Activity row doesn't have the loan's asset addresses in
    // scope and so can't resolve the per-token decimals. The
    // hardcoded `formatUnitsPretty(..., 18)` path the other entries
    // use would mis-render a 6-decimal token (USDC, USDT) as a
    // sub-femto value (Codex PR #405 round-1 P2 #2). Per-token
    // decimal awareness across the whole Activity formatter is a
    // separate refactor (the same gap exists for the existing
    // `principal` / `collateralAmount` keys); for swap-to-repay
    // the LoanTimeline `Breakdown` renders these fields with
    // proper TokenAmount decimal lookup. Activity rows show the
    // raw integers for now, which is at worst hard-to-read but
    // never wrong-by-a-decimal.
  ]);
  if (amountKeys.has(key) && /^\d+$/.test(String(value))) {
    try {
      return formatUnitsPretty(BigInt(String(value)), 18);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

const ARG_LABELS: Record<string, string> = {
  offerId: 'Offer',
  loanId: 'Loan',
  creator: 'Creator',
  acceptor: 'Acceptor',
  lender: 'Lender',
  borrower: 'Borrower',
  repayer: 'Repayer',
  claimant: 'Claimant',
  asset: 'Asset',
  amount: 'Amount',
  principal: 'Principal',
  collateralAmount: 'Collateral',
  amountAdded: 'Added',
  newCollateralAmount: 'New collateral',
  interestPaid: 'Interest',
  lateFeePaid: 'Late fee',
  offerType: 'Type',
  riskAndTermsConsentFromBoth: 'Dual consent',
  buyer: 'Buyer',
  user: 'User',
  vpfiAmount: 'VPFI',
  ethAmount: 'ETH paid',
  // T-090 Sub 3 — labels for swap-to-repay event args.
  collateralIn: 'Collateral swapped',
  principalOut: 'Principal received',
  partialPrincipal: 'Principal retired',
};

/**
 * Activity page — reverse-chronological timeline of on-chain events the
 * connected wallet participated in. Events stream from `useLogIndex`'s
 * persistent event cache (paginated `eth_getLogs` over the Diamond, keyed
 * off the topic0 allow-list) rather than the in-session journey buffer,
 * so the history survives reloads and reflects actual settled state.
 *
 * Multiple events from the same transaction are grouped into one card —
 * a single "Accept borrow offer" flow emits OfferAccepted + LoanInitiated
 * + position-NFT Transfers, and surfacing them as one row keeps the
 * timeline readable while the expanded panel exposes per-event detail.
 */
export default function Activity() {
  const { t } = useTranslation();
  const { address } = useWallet();
  const chain = useReadChain();
  // T-041 — prefer the worker-cached activity ledger; fall through to
  // the per-browser log scan when the worker is unreachable. Both
  // sources expose the same `ActivityEvent`-shaped feed via the
  // `indexedToActivityEvent` adapter, so all downstream filtering
  // (kind / participant / loanId) is shape-agnostic.
  const { events: clientEvents, loading: indexLoading, reload } = useLogIndex();
  const { events: indexedEvents, source: indexedSource } = useIndexedActivity();
  const rescanCooldown = useRescanCooldown({ loading: indexLoading });
  const events =
    indexedSource === 'indexer' && indexedEvents
      ? (indexedEvents.map(indexedToActivityEvent) as typeof clientEvents)
      : clientEvents;
  // `useUserLoans` drives the LoanDefaulted fallback — that event carries no
  // indexed user, so we match the event's loanId against the user's known
  // loans to decide whether to show it.
  const { loans: userLoans } = useUserLoans(address);

  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [blockTimes, setBlockTimes] = useState<Record<number, number>>({});
  const [page, setPage] = useState(0);

  // Set of loan IDs (as decimal strings) the connected wallet participates in.
  // Needed because `LoanDefaulted` emits no indexed participant, so the
  // participant-filter pass would otherwise drop it for every wallet.
  const userLoanIds = useMemo(() => {
    const set = new Set<string>();
    for (const l of userLoans) set.add(l.id.toString());
    return set;
  }, [userLoans]);

  const userEvents = useMemo(() => {
    if (!address) return [] as ActivityEvent[];
    const me = address.toLowerCase();
    return events.filter((ev) => {
      // OfferCanceledDetails is a hydrate-only companion to
      // OfferCanceled (same user action, richer payload). Skip from
      // the Activity feed so cancellations don't double up.
      if (ev.kind === 'OfferCanceledDetails') return false;
      if (ev.participants.includes(me)) return true;
      // LoanDefaulted has no participants — include it if the event's loanId
      // is one the current wallet actually participates in.
      //
      // T-090 v1.2 #429 — SwapToRepayIntentForceCancelled is the
      // same shape: deliberately system-attributed (`actor = null`
      // in the indexer participants resolver; empty participants
      // in the browser-fallback decoder), with only the diamond
      // `source` in the args. Without this branch the borrower
      // never sees the row that explains why their pending intent
      // disappeared right before a liquidation / time-default.
      // Same loanId-membership check as the LoanDefaulted branch
      // since both events carry `args.loanId` as the loan-scope
      // key.
      if (
        (ev.kind === 'LoanDefaulted' ||
          ev.kind === 'SwapToRepayIntentForceCancelled' ||
          // T-092 Phase 3 (#503) — `LoanExtended` participants
          // contain only the `caller` (the keeper, or the borrower-
          // NFT owner). The borrower + lender wallets are NOT in
          // event args. Fall back to loan-membership the same way
          // LoanDefaulted does so both parties see the extension on
          // their per-wallet activity feed.
          ev.kind === 'LoanExtended') &&
        typeof ev.args.loanId === 'string'
      ) {
        return userLoanIds.has(ev.args.loanId);
      }
      return false;
    });
  }, [events, address, userLoanIds]);

  // Group events by transaction hash. One card per tx; most-recent tx first.
  const groups: TxGroup[] = useMemo(() => {
    const byTx = new Map<string, ActivityEvent[]>();
    for (const ev of userEvents) {
      const bucket = byTx.get(ev.txHash) ?? [];
      bucket.push(ev);
      byTx.set(ev.txHash, bucket);
    }
    const list: TxGroup[] = [];
    for (const [txHash, evs] of byTx.entries()) {
      evs.sort((a, b) => a.logIndex - b.logIndex);
      list.push({
        txHash,
        blockNumber: evs[0].blockNumber,
        primaryKind: pickPrimary(evs),
        events: evs,
      });
    }
    // Newest first — then by logIndex desc within a tied block as a tiebreaker,
    // though same-block same-tx already collapsed into one group above.
    list.sort((a, b) => b.blockNumber - a.blockNumber);
    return list;
  }, [userEvents]);

  const filteredGroups = useMemo(() => {
    if (kindFilter === 'all') return groups;
    return groups.filter((g) => g.events.some((e) => e.kind === kindFilter));
  }, [groups, kindFilter]);

  // Reset to the first page whenever the filter changes so the view doesn't
  // land on an out-of-range page (e.g. selecting a chip with only 2 matches
  // while page=3 would render an empty list).
  useEffect(() => {
    setPage(0);
  }, [kindFilter]);

  const pagedGroups = useMemo(
    () => filteredGroups.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    [filteredGroups, page],
  );

  // Kinds actually present in the user's tx stream — drives the filter chips
  // so a wallet that's only ever lent never sees "Collateral added".
  const kindsPresent = useMemo(() => {
    const seen = new Set<ActivityEventKind>();
    for (const g of groups) for (const e of g.events) seen.add(e.kind);
    return Array.from(seen);
  }, [groups]);

  // Lazy-fetch block timestamps for the blocks currently rendered. One RPC
  // `getBlock` call per unseen block — cached by blockNumber for the session.
  // The ref tracks in-flight block numbers so a re-render during fetch doesn't
  // stack duplicate requests.
  const inflight = useRef<Set<number>>(new Set());
  useEffect(() => {
    const needed = new Set<number>();
    for (const g of pagedGroups) {
      if (blockTimes[g.blockNumber] == null && !inflight.current.has(g.blockNumber)) {
        needed.add(g.blockNumber);
      }
    }
    if (needed.size === 0) return;
    const rpc = chain.rpcUrl;
    if (!rpc) return;
    const publicClient = createPublicClient({ transport: http(rpc) });
    for (const bn of needed) inflight.current.add(bn);
    (async () => {
      const updates: Record<number, number> = {};
      await Promise.all(
        Array.from(needed).map(async (bn) => {
          try {
            const b = await publicClient.getBlock({ blockNumber: BigInt(bn) });
            if (b?.timestamp != null) updates[bn] = Number(b.timestamp);
          } catch {
            // Swallow — a missing timestamp just renders as the blockNumber.
          } finally {
            inflight.current.delete(bn);
          }
        }),
      );
      if (Object.keys(updates).length > 0) {
        setBlockTimes((prev) => ({ ...prev, ...updates }));
      }
    })();
  }, [pagedGroups, blockTimes, chain.rpcUrl]);

  const toggle = (txHash: string) =>
    setExpanded((prev) => ({ ...prev, [txHash]: !prev[txHash] }));

  const explorerTxUrl = (hash: string) =>
    `${chain.blockExplorer}/tx/${hash}`;

  return (
    <div className="activity-page">
      <div className="page-header">
        <h1 className="page-title">
          <ActivityIcon
            size={22}
            style={{ verticalAlign: 'middle', marginRight: 8 }}
          />
          {t('appNav.activity')}
          <CardInfo id="activity.feed" />
        </h1>
        <p className="page-subtitle">
          {t('activity.pageSubtitle', { chain: chain.name ?? '' })}
        </p>
      </div>

      <div className="activity-toolbar">
        <div className="activity-chips" role="group" aria-label="Event filter">
          <button
            type="button"
            className={`activity-chip ${kindFilter === 'all' ? 'active' : ''}`}
            onClick={() => setKindFilter('all')}
          >
            {t('activity.filterAll')}
          </button>
          {KIND_PRIORITY.filter((k) => kindsPresent.includes(k)).map((k) => (
            <button
              key={k}
              type="button"
              className={`activity-chip ${kindFilter === k ? 'active' : ''}`}
              onClick={() => setKindFilter(k)}
            >
              {KIND_LABELS[k]}
            </button>
          ))}
        </div>

        <div className="activity-toolbar-right">
          <DataSyncStatus />
          <RescanButton
            cooldown={rescanCooldown}
            onRescan={() => {
              void reload();
            }}
            tooltip={t('activity.rescanTooltip')}
          />
        </div>
      </div>

      {!address ? (
        <div className="activity-empty">
          <ActivityIcon size={28} />
          <h3>{t('activity.connectTitle')}</h3>
          <p>{t('activity.connectBody')}</p>
        </div>
      ) : filteredGroups.length === 0 ? (
        <div className="activity-empty">
          <ActivityIcon size={28} />
          <h3>
            {groups.length === 0
              ? indexLoading
                ? t('activity.scanningLogs')
                : t('activity.noActivity')
              : t('activity.noFilterMatch')}
          </h3>
          <p>
            {groups.length === 0
              ? t('activity.noActivityBody')
              : t('activity.noFilterMatchBody')}
          </p>
        </div>
      ) : (
        <ul className="activity-list">
          {pagedGroups.map((g) => {
            const isOpen = !!expanded[g.txHash];
            const ts = blockTimes[g.blockNumber];
            const accent = KIND_ACCENT[g.primaryKind];
            const loanId = g.events.find(
              (e) => typeof e.args.loanId === 'string',
            )?.args.loanId as string | undefined;
            const offerId = g.events.find(
              (e) => typeof e.args.offerId === 'string',
            )?.args.offerId as string | undefined;
            return (
              <li key={g.txHash} className={`activity-row status-${accent}`}>
                <div className="activity-row-main">
                  <button
                    type="button"
                    className="activity-expand-btn"
                    onClick={() => toggle(g.txHash)}
                    aria-expanded={isOpen}
                    aria-label={isOpen ? 'Collapse details' : 'Expand details'}
                  >
                    {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  </button>
                  <div className="activity-row-body">
                    <div className="activity-row-title">
                      {KIND_LABELS[g.primaryKind]}
                      {g.events.length > 1 && (
                        <span className="activity-pill" style={{ marginLeft: 8 }}>
                          +{g.events.length - 1} more
                        </span>
                      )}
                    </div>
                    <div className="activity-row-meta">
                      <span
                        className="activity-time"
                        data-tooltip={ts ? new Date(ts * 1000).toISOString() : undefined}
                      >
                        {ts ? formatBlockTime(ts) : `block ${g.blockNumber}`}
                      </span>
                      {loanId && (
                        <Link
                          to={`/app/loans/${loanId}`}
                          className="activity-pill activity-pill--link"
                          aria-label={t('activity.viewLoan', { id: loanId })}
                        >
                          Loan #{loanId}
                        </Link>
                      )}
                      {offerId && (
                        <Link
                          to={`/app/offers/${offerId}`}
                          className="activity-pill activity-pill--link"
                          aria-label={t('activity.viewOffer', {
                            id: offerId,
                            defaultValue: 'View offer #{{id}}',
                          })}
                        >
                          Offer #{offerId}
                        </Link>
                      )}
                    </div>

                    {isOpen && (
                      <div className="activity-details">
                        {g.events.map((ev) => (
                          <div
                            key={`${ev.txHash}:${ev.logIndex}`}
                            className="activity-detail-event"
                          >
                            <div className="activity-detail-kind">
                              {KIND_LABELS[ev.kind]}
                            </div>
                            <dl className="activity-detail-args">
                              {Object.entries(ev.args).map(([k, v]) => (
                                <div key={k} className="activity-detail-arg">
                                  <dt>{ARG_LABELS[k] ?? k}</dt>
                                  <dd>{renderArgValue(k, v)}</dd>
                                </div>
                              ))}
                            </dl>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <a
                  href={explorerTxUrl(g.txHash)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="activity-row-link"
                  aria-label={`Open transaction ${shortHash(g.txHash)} on block explorer`}
                  data-tooltip={g.txHash}
                >
                  <ExternalLink size={12} />
                  <span className="mono">{shortHash(g.txHash)}</span>
                </a>
              </li>
            );
          })}
        </ul>
      )}

      <Pager
        total={filteredGroups.length}
        pageSize={PAGE_SIZE}
        page={page}
        onPageChange={setPage}
        unit="transaction"
      />
    </div>
  );
}
