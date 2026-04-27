import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createPublicClient, http } from 'viem';
import {
  Activity as ActivityIcon,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  RefreshCw,
} from 'lucide-react';
import { useLogIndex } from '../hooks/useLogIndex';
import { useUserLoans } from '../hooks/useUserLoans';
import { useWallet } from '../context/WalletContext';
import { useReadChain } from '../contracts/useDiamond';
import type { ActivityEvent, ActivityEventKind } from '../lib/logIndex';
import { shortenAddr, formatUnitsPretty } from '../lib/format';
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
  LoanInitiated: 'Loan initiated',
  LoanRepaid: 'Loan repaid',
  LoanDefaulted: 'Loan defaulted',
  LenderFundsClaimed: 'Lender claimed',
  BorrowerFundsClaimed: 'Borrower claimed',
  CollateralAdded: 'Collateral added',
  LoanSold: 'Lender position sold',
  LoanObligationTransferred: 'Borrower position transferred',
  VPFIPurchasedWithETH: 'VPFI bought with ETH',
  VPFIDepositedToEscrow: 'VPFI staked to escrow',
  VPFIWithdrawnFromEscrow: 'VPFI unstaked from escrow',
};

// Kind-kind → primary row accent colour class. Mirrors status accents from the
// old journey-log view so the page still scans visually.
const KIND_ACCENT: Record<ActivityEventKind, string> = {
  OfferCreated: 'info',
  OfferAccepted: 'success',
  OfferCanceled: 'failure',
  LoanInitiated: 'success',
  LoanRepaid: 'success',
  LoanDefaulted: 'failure',
  LenderFundsClaimed: 'info',
  BorrowerFundsClaimed: 'info',
  CollateralAdded: 'info',
  LoanSold: 'info',
  LoanObligationTransferred: 'info',
  VPFIPurchasedWithETH: 'success',
  VPFIDepositedToEscrow: 'success',
  VPFIWithdrawnFromEscrow: 'info',
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
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ms).toLocaleString();
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
  'LoanInitiated',
  'LoanSold',
  'LoanObligationTransferred',
  'OfferAccepted',
  'CollateralAdded',
  'LenderFundsClaimed',
  'BorrowerFundsClaimed',
  'VPFIPurchasedWithETH',
  'VPFIDepositedToEscrow',
  'VPFIWithdrawnFromEscrow',
  'OfferCreated',
  'OfferCanceled',
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
  fallbackConsentFromBoth: 'Dual consent',
  buyer: 'Buyer',
  user: 'User',
  vpfiAmount: 'VPFI',
  ethAmount: 'ETH paid',
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
  const { events, loading: indexLoading, reload } = useLogIndex();
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
      if (ev.participants.includes(me)) return true;
      // LoanDefaulted has no participants — include it if the event's loanId
      // is one the current wallet actually participates in.
      if (ev.kind === 'LoanDefaulted' && typeof ev.args.loanId === 'string') {
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
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={reload}
            disabled={indexLoading}
            data-tooltip={t('activity.rescanTooltip')}
            data-tooltip-placement="below"
          >
            <RefreshCw size={14} className={indexLoading ? 'spin' : ''} />
            {indexLoading ? t('activity.scanning') : t('activity.refresh')}
          </button>
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
                      {loanId && <span className="activity-pill">Loan #{loanId}</span>}
                      {offerId && <span className="activity-pill">Offer #{offerId}</span>}
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
