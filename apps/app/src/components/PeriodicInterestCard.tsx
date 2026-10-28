/**
 * A periodic-interest loan's current period on the loan page (#2524):
 * its deadline, its grace, what the period expects, what has been paid
 * toward it, and — once the grace is over — what can happen to it and who
 * can make it happen.
 *
 * Every figure and date is the contract's own `previewPeriodicSettle`,
 * read with the chain time it was evaluated at (`periodicInterest.ts`).
 *
 * One action is offered, and only one: recording a period that is already
 * fully paid (`settlePeriodicInterest` with no sale), which moves no funds.
 * A period with something still owed is settled by a collateral SALE whose
 * swap route has to be quoted at the moment it runs; this page does not
 * build one, so it says who can rather than offering a button that would
 * fail.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePublicClient, useWalletClient } from 'wagmi';
import { copy } from '../content/copy';
import { captureTxError } from '../lib/errors';
import { formatDateTime, formatTokenAmountExact } from '../lib/format';
import { useActiveChain } from '../chain/useActiveChain';
import { useDiamondWrite } from '../contracts/diamond';
import { assertWalletNotSanctionedLive } from '../data/sanctions';
import type { PeriodicSettleRoute, PeriodicView } from '../data/periodicInterest';
import {
  periodicInterestKey,
  readPeriodicView,
  usePeriodicInterest,
} from '../data/usePeriodicInterest';

/** `LibVaipakam.PeriodicInterestCadence` as a schedule name. An ordinal
 *  this app does not know reads as unknown, never as a known schedule. */
export function periodicCadenceText(cadence: number): string {
  const t = copy.periodicInterest;
  switch (cadence) {
    case 1:
      return t.cadenceMonthly;
    case 2:
      return t.cadenceQuarterly;
    case 3:
      return t.cadenceSemiAnnual;
    case 4:
      return t.cadenceAnnual;
    default:
      return t.cadenceUnknown;
  }
}

type Role = 'borrower' | 'lender' | 'viewer';

/** The line for a DUE period's route, per role where the collateral and
 *  the payment belong to different people. */
export function periodicRouteText(route: PeriodicSettleRoute, role: Role): string {
  const t = copy.periodicInterest;
  switch (route) {
    case 'record':
      return t.routeRecord;
    case 'sale':
      return role === 'borrower'
        ? t.routeSaleBorrower
        : role === 'lender'
          ? t.routeSaleLender
          : t.routeSaleViewer;
    case 'off':
      return t.routeOff;
    case 'paused':
      return t.routePaused;
    case 'unknown':
      return t.routeUnknown;
  }
}

export function PeriodicInterestCard({
  loanId,
  role,
  principal,
  enabled,
  scheduled,
  busy,
  setBusy,
}: {
  loanId: number;
  role: Role;
  /** The lending asset's metadata, for the amounts. `undefined` while it
   *  loads: the amounts then read as checking, not as raw units. */
  principal: { decimals: number; symbol: string } | undefined;
  /** Mount the read: an active loan not already known to have no
   *  schedule. */
  enabled: boolean;
  /** The page already knows this loan IS on a schedule. Until it does,
   *  a loading or failed read renders nothing rather than a card about a
   *  schedule the loan may not have. */
  scheduled: boolean;
  /** The PAGE's shared write lock. */
  busy: boolean;
  setBusy: (b: boolean) => void;
}) {
  const t = copy.periodicInterest;
  const { onSupportedChain, readChain, address } = useActiveChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  const { write } = useDiamondWrite();
  const queryClient = useQueryClient();
  const read = usePeriodicInterest({ loanId, enabled });
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // The deadline of the period this page recorded, so the button stays
  // away until the refetch shows the next period, and comes back if a
  // later period is recordable in the same visit.
  const [recordedFor, setRecordedFor] = useState<number | null>(null);
  const [recording, setRecording] = useState(false);

  if (!enabled) return null;
  const view = read.view;
  if (view?.kind === 'none' || view?.kind === 'inactive') return null;

  if (view === undefined) {
    if (!scheduled) return null;
    return (
      <section className="card" data-testid="periodic-interest-card">
        <h3>{t.title}</h3>
        <p className="muted">{read.unread ? t.unread : t.checking}</p>
      </section>
    );
  }

  const amount = (raw: bigint) =>
    principal ? `${formatTokenAmountExact(raw, principal.decimals)} ${principal.symbol}` : '…';
  const walletReady = onSupportedChain && Boolean(walletClient) && Boolean(address);

  async function record(periodEndAt: number) {
    if (!publicClient || !address) return;
    setBusy(true);
    setRecording(true);
    setError(null);
    setDone(null);
    try {
      // The route is re-read at the moment of signing: a period that was
      // paid and settleable a poll ago may have been recorded by somebody
      // else since, or turned into one with something owed.
      const fresh = await readPeriodicView(publicClient, readChain.diamondAddress, loanId);
      if (fresh?.kind !== 'period' || fresh.route !== 'record') {
        setError(t.recordGone);
        await queryClient.invalidateQueries({
          queryKey: periodicInterestKey(readChain.chainId, loanId),
        });
        return;
      }
      // The settlement screens its caller (a Tier-1 gate); asking first
      // turns a flagged wallet's revert into a sentence.
      await assertWalletNotSanctionedLive(publicClient, readChain.diamondAddress, address);
      // No sale: a zero sale size and an empty route list, which the
      // contract ignores on a fully paid period.
      await write('settlePeriodicInterest', [BigInt(loanId), 0n, []]);
      setDone(t.recorded);
      setRecordedFor(periodEndAt);
      await queryClient.invalidateQueries({
        queryKey: periodicInterestKey(readChain.chainId, loanId),
      });
    } catch (err) {
      setError(captureTxError(err));
    } finally {
      setRecording(false);
      setBusy(false);
    }
  }

  return (
    <section className="card" data-testid="periodic-interest-card">
      <h3>{t.title}</h3>
      <PeriodRows view={view} amount={amount} />
      <p className="muted" style={{ marginTop: 8 }}>
        {view.phase === 'open' ? t.phaseOpen : view.phase === 'grace' ? t.phaseGrace : t.phaseDue}
      </p>
      {view.phase !== 'due' ? (
        <p className="muted">
          {role === 'borrower'
            ? t.payHintBorrower
            : role === 'lender'
              ? t.payHintLender
              : t.payHintViewer}
        </p>
      ) : view.route !== undefined ? (
        <div
          className={`banner ${view.route === 'sale' ? 'banner-warn' : 'banner-info'}`}
          role="status"
          data-testid="periodic-interest-route"
        >
          <span className="banner-body">{periodicRouteText(view.route, role)}</span>
        </div>
      ) : null}
      {view.phase === 'due' && view.route === 'record' && view.periodEndAt !== recordedFor ? (
        <button
          type="button"
          className="btn btn-secondary"
          style={{ marginTop: 8 }}
          disabled={busy || !walletReady}
          onClick={() => void record(view.periodEndAt)}
        >
          {recording ? t.recording : t.recordButton}
        </button>
      ) : null}
      <p className="muted" style={{ marginTop: 8, fontSize: '0.85em' }}>
        {t.readAt(view.block.toString())}
      </p>
      {done ? (
        <div className="banner banner-info" role="status" style={{ marginTop: 12 }}>
          <span className="banner-body">{done}</span>
        </div>
      ) : null}
      {error ? (
        <div className="banner banner-danger" role="alert" style={{ marginTop: 12 }}>
          <span className="banner-body">{error}</span>
        </div>
      ) : null}
    </section>
  );
}

function PeriodRows({
  view,
  amount,
}: {
  view: Extract<PeriodicView, { kind: 'period' }>;
  amount: (raw: bigint) => string;
}) {
  const t = copy.periodicInterest;
  return (
    <>
      <dl className="receipt" style={{ margin: 0 }}>
        <div className="receipt-row">
          <dt>{t.labels.schedule}</dt>
          <dd>{periodicCadenceText(view.cadence)}</dd>
        </div>
        <div className="receipt-row">
          <dt>{t.labels.deadline}</dt>
          <dd>{formatDateTime(view.periodEndAt)}</dd>
        </div>
        <div className="receipt-row">
          <dt>{t.labels.graceEnds}</dt>
          <dd>{formatDateTime(view.graceEndsAt)}</dd>
        </div>
        <div className="receipt-row">
          <dt>{t.labels.expected}</dt>
          <dd>{amount(view.expected)}</dd>
        </div>
        <div className="receipt-row">
          <dt>{t.labels.paid}</dt>
          <dd>{amount(view.paid)}</dd>
        </div>
        <div className="receipt-row">
          <dt>{t.labels.owed}</dt>
          <dd data-testid="periodic-interest-owed">{amount(view.shortfall)}</dd>
        </div>
      </dl>
      <p className="muted" style={{ marginTop: 8, fontSize: '0.85em' }}>
        {t.expectedNote}
      </p>
    </>
  );
}
