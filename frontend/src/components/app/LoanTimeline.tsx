import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createPublicClient, http } from 'viem';
import {
  ArrowDownCircle,
  ArrowUpCircle,
  CheckCircle,
  ExternalLink,
  ListChecks,
  RefreshCw,
  Repeat,
  ShieldAlert,
  TrendingDown,
  Coins,
} from 'lucide-react';
import { useLogIndex } from '../../hooks/useLogIndex';
import { useReadChain } from '../../contracts/useDiamond';
import type { ActivityEvent, ActivityEventKind } from '../../lib/logIndex';
import { TokenAmount } from './TokenAmount';
import { AddressDisplay } from './AddressDisplay';
import { formatDateTime, formatRelativeTime, shortenAddr } from '../../lib/format';
import './LoanTimeline.css';

interface Props {
  /** Loan ID as a decimal string. Filters the global log-index events array
   *  down to entries whose `args.loanId` matches. */
  loanId: string;
  /** Block-explorer base URL for tx-hash deep links (no trailing slash). */
  blockExplorer: string;
  /** ERC-20 contract addresses involved in this loan. Used to resolve
   *  decimals + symbol for the breakdown amount columns so we never show a
   *  raw 18-decimal value when the asset is, say, USDC (6 decimals). */
  principalAsset: string | null;
  collateralAsset: string | null;
}

/**
 * Friendly label rendered as the headline for each event row. Intentionally
 * second-person and short — the breakdown rows below carry the numbers.
 */
const KIND_LABEL_KEY: Record<ActivityEventKind, string> = {
  OfferCreated: 'loanTimeline.offerCreated',
  OfferAccepted: 'loanTimeline.offerAccepted',
  OfferCanceled: 'loanTimeline.offerCanceled',
  // Companion to OfferCanceled — same user action, just the rich
  // payload variant. Filtered out at render time so it doesn't show
  // up as a duplicate row, but the keymap stays exhaustive.
  OfferCanceledDetails: 'loanTimeline.offerCanceled',
  LoanInitiated: 'loanTimeline.loanInitiated',
  LoanRepaid: 'loanTimeline.loanRepaid',
  LoanDefaulted: 'loanTimeline.loanDefaulted',
  LenderFundsClaimed: 'loanTimeline.lenderClaimed',
  BorrowerFundsClaimed: 'loanTimeline.borrowerClaimed',
  CollateralAdded: 'loanTimeline.collateralAdded',
  LoanSold: 'loanTimeline.lenderSold',
  LoanObligationTransferred: 'loanTimeline.borrowerTransferred',
  LoanSettlementBreakdown: 'loanTimeline.settlementBreakdown',
  LiquidationFallback: 'loanTimeline.liquidationFallback',
  LiquidationFallbackSplit: 'loanTimeline.liquidationFallbackSplit',
  LoanSettled: 'loanTimeline.loanSettled',
  PartialRepaid: 'loanTimeline.partialRepaid',
  ClaimRetryExecuted: 'loanTimeline.claimRetryExecuted',
  BorrowerLifRebateClaimed: 'loanTimeline.lifRebateClaimed',
  // The following kinds aren't loan-scoped (no `args.loanId`) so they're
  // filtered out before rendering, but the keymap stays exhaustive so a
  // future kind addition fails the type-check until it gets a label.
  StakingRewardsClaimed: 'loanTimeline.stakingRewardsClaimed',
  InteractionRewardsClaimed: 'loanTimeline.interactionRewardsClaimed',
  VPFIPurchasedWithETH: 'loanTimeline.vpfiPurchased',
  VPFIDepositedToEscrow: 'loanTimeline.vpfiDeposited',
  VPFIWithdrawnFromEscrow: 'loanTimeline.vpfiWithdrawn',
};

/** Per-kind icon tint. Matches the Activity-page severity scheme. */
const KIND_ACCENT: Record<ActivityEventKind, 'success' | 'failure' | 'info' | 'warn'> = {
  OfferCreated: 'info',
  OfferAccepted: 'success',
  OfferCanceled: 'failure',
  OfferCanceledDetails: 'failure',
  LoanInitiated: 'success',
  LoanRepaid: 'success',
  LoanDefaulted: 'failure',
  LenderFundsClaimed: 'info',
  BorrowerFundsClaimed: 'info',
  CollateralAdded: 'info',
  LoanSold: 'info',
  LoanObligationTransferred: 'info',
  LoanSettlementBreakdown: 'success',
  LiquidationFallback: 'warn',
  LiquidationFallbackSplit: 'warn',
  LoanSettled: 'success',
  PartialRepaid: 'info',
  ClaimRetryExecuted: 'info',
  BorrowerLifRebateClaimed: 'info',
  StakingRewardsClaimed: 'success',
  InteractionRewardsClaimed: 'success',
  VPFIPurchasedWithETH: 'success',
  VPFIDepositedToEscrow: 'success',
  VPFIWithdrawnFromEscrow: 'info',
};

function iconForKind(kind: ActivityEventKind) {
  switch (kind) {
    case 'LoanInitiated':
    case 'OfferAccepted':
      return Coins;
    case 'LoanRepaid':
    case 'PartialRepaid':
    case 'LoanSettled':
      return CheckCircle;
    case 'LoanDefaulted':
    case 'LiquidationFallback':
    case 'LiquidationFallbackSplit':
      return ShieldAlert;
    case 'LenderFundsClaimed':
    case 'BorrowerFundsClaimed':
    case 'BorrowerLifRebateClaimed':
      return ArrowDownCircle;
    case 'CollateralAdded':
      return ArrowUpCircle;
    case 'LoanSold':
    case 'LoanObligationTransferred':
      return Repeat;
    case 'LoanSettlementBreakdown':
      return ListChecks;
    case 'ClaimRetryExecuted':
      return RefreshCw;
    case 'OfferCanceled':
      return TrendingDown;
    default:
      return Coins;
  }
}

function formatBlockTime(unixSeconds: number | undefined): string {
  if (!unixSeconds) return '';
  const ms = unixSeconds * 1000;
  const diff = Date.now() - ms;
  if (diff < 86_400_000) return formatRelativeTime(ms);
  return formatDateTime(ms);
}

function asBigInt(value: string | number | boolean | undefined): bigint {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return 0n;
  try { return BigInt(value); } catch { return 0n; }
}

export function LoanTimeline({
  loanId,
  blockExplorer,
  principalAsset,
  collateralAsset,
}: Props) {
  const { t } = useTranslation();
  const { events, loading } = useLogIndex();
  const chain = useReadChain();
  const [blockTimes, setBlockTimes] = useState<Record<number, number>>({});

  // Filter to events touching this specific loan. Most loan-lifecycle events
  // carry `args.loanId` as a decimal string; the few that don't (`Transfer`,
  // VPFI buy/stake, staking rewards) are intentionally excluded.
  const loanEvents = useMemo<ActivityEvent[]>(() => {
    return events
      .filter((ev) => typeof ev.args.loanId === 'string' && ev.args.loanId === loanId)
      .slice()
      .sort((a, b) => {
        if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
        return a.logIndex - b.logIndex;
      });
  }, [events, loanId]);

  // Lazy block-time lookup. Activity uses the same pattern: collect the
  // distinct block numbers in view, fetch their timestamps in parallel, cache.
  useEffect(() => {
    if (loanEvents.length === 0) return;
    const missing = Array.from(new Set(loanEvents.map((e) => e.blockNumber))).filter(
      (n) => blockTimes[n] === undefined,
    );
    if (missing.length === 0) return;
    let cancelled = false;
    const client = createPublicClient({ transport: http(chain.rpcUrl) });
    (async () => {
      const out: Record<number, number> = {};
      await Promise.all(
        missing.map(async (n) => {
          try {
            const block = await client.getBlock({ blockNumber: BigInt(n) });
            out[n] = Number(block.timestamp);
          } catch {
            // tolerate: row will render without a timestamp
          }
        }),
      );
      if (!cancelled && Object.keys(out).length > 0) {
        setBlockTimes((prev) => ({ ...prev, ...out }));
      }
    })();
    return () => { cancelled = true; };
  }, [loanEvents, chain.rpcUrl, blockTimes]);

  if (loading && loanEvents.length === 0) {
    return (
      <div className="loan-timeline-empty">{t('loanTimeline.loading')}</div>
    );
  }
  if (loanEvents.length === 0) {
    return (
      <div className="loan-timeline-empty">{t('loanTimeline.noEvents')}</div>
    );
  }

  return (
    <ol className="loan-timeline">
      {loanEvents.map((ev) => {
        const Icon = iconForKind(ev.kind);
        const accent = KIND_ACCENT[ev.kind];
        const ts = blockTimes[ev.blockNumber];
        return (
          <li
            key={`${ev.txHash}:${ev.logIndex}`}
            className={`loan-timeline-row loan-timeline-row--${accent}`}
          >
            <div className="loan-timeline-icon" aria-hidden="true">
              <Icon size={16} />
            </div>
            <div className="loan-timeline-body">
              <div className="loan-timeline-headline">
                <span className="loan-timeline-label">{t(KIND_LABEL_KEY[ev.kind])}</span>
                <span
                  className="loan-timeline-time"
                  data-tooltip={ts ? new Date(ts * 1000).toISOString() : undefined}
                >
                  {ts ? formatBlockTime(ts) : `block ${ev.blockNumber}`}
                </span>
              </div>
              <Breakdown
                ev={ev}
                principalAsset={principalAsset}
                collateralAsset={collateralAsset}
              />
              <a
                className="loan-timeline-tx"
                href={`${blockExplorer}/tx/${ev.txHash}`}
                target="_blank"
                rel="noreferrer"
              >
                {shortenAddr(ev.txHash)} <ExternalLink size={12} />
              </a>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

interface BreakdownProps {
  ev: ActivityEvent;
  principalAsset: string | null;
  collateralAsset: string | null;
}

/**
 * Per-event-kind breakdown rendering. Each kind picks the fields that
 * matter for a non-engineer reader and labels them in plain English.
 * Falls back to "no extra detail" for kinds whose headline is enough.
 */
function Breakdown({ ev, principalAsset, collateralAsset }: BreakdownProps) {
  const { t } = useTranslation();
  const args = ev.args;

  const principalAddr = principalAsset ?? '0x0000000000000000000000000000000000000000';
  const collateralAddr = collateralAsset ?? '0x0000000000000000000000000000000000000000';

  switch (ev.kind) {
    case 'LoanInitiated': {
      const principal = asBigInt(args.principal);
      const collateralAmount = asBigInt(args.collateralAmount);
      return (
        <dl className="loan-timeline-grid">
          <Row label={t('loanTimeline.lblPrincipal')}>
            <TokenAmount amount={principal} address={principalAddr} withSymbol />
          </Row>
          <Row label={t('loanTimeline.lblCollateral')}>
            <TokenAmount amount={collateralAmount} address={collateralAddr} withSymbol />
          </Row>
          {typeof args.lender === 'string' && (
            <Row label={t('loanTimeline.lblLender')}>
              <AddressDisplay address={args.lender as string} copyable />
            </Row>
          )}
          {typeof args.borrower === 'string' && (
            <Row label={t('loanTimeline.lblBorrower')}>
              <AddressDisplay address={args.borrower as string} copyable />
            </Row>
          )}
        </dl>
      );
    }
    case 'OfferAccepted': {
      return (
        <dl className="loan-timeline-grid">
          {typeof args.acceptor === 'string' && (
            <Row label={t('loanTimeline.lblAcceptor')}>
              <AddressDisplay address={args.acceptor as string} copyable />
            </Row>
          )}
        </dl>
      );
    }
    case 'PartialRepaid': {
      const amountRepaid = asBigInt(args.amountRepaid);
      const newPrincipal = asBigInt(args.newPrincipal);
      return (
        <dl className="loan-timeline-grid">
          <Row label={t('loanTimeline.lblAmountRepaid')}>
            <TokenAmount amount={amountRepaid} address={principalAddr} withSymbol />
          </Row>
          <Row label={t('loanTimeline.lblPrincipalRemaining')}>
            <TokenAmount amount={newPrincipal} address={principalAddr} withSymbol />
          </Row>
        </dl>
      );
    }
    case 'LoanRepaid': {
      const interestPaid = asBigInt(args.interestPaid);
      const lateFeePaid = asBigInt(args.lateFeePaid);
      return (
        <dl className="loan-timeline-grid">
          <Row label={t('loanTimeline.lblInterestPaid')}>
            <TokenAmount amount={interestPaid} address={principalAddr} withSymbol />
          </Row>
          {lateFeePaid > 0n && (
            <Row label={t('loanTimeline.lblLateFee')}>
              <TokenAmount amount={lateFeePaid} address={principalAddr} withSymbol />
            </Row>
          )}
          {typeof args.repayer === 'string' && (
            <Row label={t('loanTimeline.lblRepayer')}>
              <AddressDisplay address={args.repayer as string} />
            </Row>
          )}
        </dl>
      );
    }
    case 'LoanSettlementBreakdown': {
      const principal = asBigInt(args.principal);
      const interest = asBigInt(args.interest);
      const lateFee = asBigInt(args.lateFee);
      const treasuryShare = asBigInt(args.treasuryShare);
      const lenderShare = asBigInt(args.lenderShare);
      return (
        <dl className="loan-timeline-grid">
          <Row label={t('loanTimeline.lblPrincipalReturned')}>
            <TokenAmount amount={principal} address={principalAddr} withSymbol />
          </Row>
          <Row label={t('loanTimeline.lblInterest')}>
            <TokenAmount amount={interest} address={principalAddr} withSymbol />
          </Row>
          {lateFee > 0n && (
            <Row label={t('loanTimeline.lblLateFee')}>
              <TokenAmount amount={lateFee} address={principalAddr} withSymbol />
            </Row>
          )}
          <Row label={t('loanTimeline.lblLenderShare')}>
            <TokenAmount amount={lenderShare} address={principalAddr} withSymbol />
          </Row>
          <Row label={t('loanTimeline.lblTreasuryShare')}>
            <TokenAmount amount={treasuryShare} address={principalAddr} withSymbol />
          </Row>
        </dl>
      );
    }
    case 'LoanDefaulted': {
      return (
        <dl className="loan-timeline-grid">
          <Row label={t('loanTimeline.lblDualConsent')}>
            {args.fallbackConsentFromBoth ? t('shared.yes') : t('shared.no')}
          </Row>
        </dl>
      );
    }
    case 'LiquidationFallback': {
      const collateralAmount = asBigInt(args.collateralAmount);
      return (
        <dl className="loan-timeline-grid">
          <Row label={t('loanTimeline.lblCollateralEnteringFallback')}>
            <TokenAmount amount={collateralAmount} address={collateralAddr} withSymbol />
          </Row>
        </dl>
      );
    }
    case 'LiquidationFallbackSplit': {
      const lenderColl = asBigInt(args.lenderCollateral);
      const treasuryColl = asBigInt(args.treasuryCollateral);
      const borrowerColl = asBigInt(args.borrowerCollateral);
      return (
        <dl className="loan-timeline-grid">
          <Row label={t('loanTimeline.lblLenderCollateral')}>
            <TokenAmount amount={lenderColl} address={collateralAddr} withSymbol />
          </Row>
          <Row label={t('loanTimeline.lblTreasuryCollateral')}>
            <TokenAmount amount={treasuryColl} address={collateralAddr} withSymbol />
          </Row>
          <Row label={t('loanTimeline.lblBorrowerCollateral')}>
            <TokenAmount amount={borrowerColl} address={collateralAddr} withSymbol />
          </Row>
        </dl>
      );
    }
    case 'LenderFundsClaimed':
    case 'BorrowerFundsClaimed': {
      const amount = asBigInt(args.amount);
      const asset = typeof args.asset === 'string' ? args.asset : principalAddr;
      return (
        <dl className="loan-timeline-grid">
          <Row label={t('loanTimeline.lblAmountClaimed')}>
            <TokenAmount amount={amount} address={asset} withSymbol />
          </Row>
          {typeof args.claimant === 'string' && (
            <Row label={t('loanTimeline.lblClaimant')}>
              <AddressDisplay address={args.claimant as string} />
            </Row>
          )}
        </dl>
      );
    }
    case 'BorrowerLifRebateClaimed': {
      const amount = asBigInt(args.amount);
      // VPFI is always 18-decimals; render as bare number with unit.
      return (
        <dl className="loan-timeline-grid">
          <Row label={t('loanTimeline.lblVpfiRebate')}>
            <TokenAmount amount={amount} address="vpfi" decimals={18} /> VPFI
          </Row>
        </dl>
      );
    }
    case 'CollateralAdded': {
      const amountAdded = asBigInt(args.amountAdded);
      const newCollateralAmount = asBigInt(args.newCollateralAmount);
      return (
        <dl className="loan-timeline-grid">
          <Row label={t('loanTimeline.lblAdded')}>
            <TokenAmount amount={amountAdded} address={collateralAddr} withSymbol />
          </Row>
          <Row label={t('loanTimeline.lblNewCollateralTotal')}>
            <TokenAmount amount={newCollateralAmount} address={collateralAddr} withSymbol />
          </Row>
        </dl>
      );
    }
    case 'LoanSold': {
      return (
        <dl className="loan-timeline-grid">
          {typeof args.originalLender === 'string' && (
            <Row label={t('loanTimeline.lblOriginalLender')}>
              <AddressDisplay address={args.originalLender as string} />
            </Row>
          )}
          {typeof args.newLender === 'string' && (
            <Row label={t('loanTimeline.lblNewLender')}>
              <AddressDisplay address={args.newLender as string} />
            </Row>
          )}
        </dl>
      );
    }
    case 'LoanObligationTransferred': {
      return (
        <dl className="loan-timeline-grid">
          {typeof args.originalBorrower === 'string' && (
            <Row label={t('loanTimeline.lblOriginalBorrower')}>
              <AddressDisplay address={args.originalBorrower as string} />
            </Row>
          )}
          {typeof args.newBorrower === 'string' && (
            <Row label={t('loanTimeline.lblNewBorrower')}>
              <AddressDisplay address={args.newBorrower as string} />
            </Row>
          )}
          {typeof args.shortfallPaid === 'string' && asBigInt(args.shortfallPaid) > 0n && (
            <Row label={t('loanTimeline.lblShortfallPaid')}>
              <TokenAmount amount={asBigInt(args.shortfallPaid)} address={principalAddr} withSymbol />
            </Row>
          )}
        </dl>
      );
    }
    case 'ClaimRetryExecuted': {
      const proceeds = asBigInt(args.proceeds);
      return (
        <dl className="loan-timeline-grid">
          <Row label={t('loanTimeline.lblRetryOutcome')}>
            {args.succeeded ? t('loanTimeline.retrySucceeded') : t('loanTimeline.retryFailed')}
          </Row>
          {proceeds > 0n && (
            <Row label={t('loanTimeline.lblRetryProceeds')}>
              <TokenAmount amount={proceeds} address={principalAddr} withSymbol />
            </Row>
          )}
        </dl>
      );
    }
    case 'LoanSettled':
    case 'OfferCreated':
    case 'OfferCanceled':
    default:
      return null;
  }
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}
