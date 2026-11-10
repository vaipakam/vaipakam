import { useEffect, useRef, useState } from 'react';
import { useConfig } from 'wagmi';
import { writeContract } from 'wagmi/actions';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useCopy } from '../copy/useCopy';
import { refusalFromError, StatedRefusal } from '../eligibility/refusal';
import { WhyLink } from '../help/WhyLink';
import { askThrough } from '../tx/simulate';
import { holdsFlow, useStoredValue, useTxEntry, useTxNote } from '../tx/txStore';
import { useMounted, useReviewRefresh } from '../tx/useReviewRefresh';
import { useTrackedTx } from '../tx/useTrackedTx';
import { ActionFlow, reviewIdentity, type Recheck } from '../ui/ActionFlow';
import { Notice } from '../ui/Notice';
import { formatUtc } from '../ui/format';
import {
  bpsPercent,
  GUARD_BPS_MAX,
  GUARD_BPS_MIN,
  guardBlockers,
  guardCall,
  guardChanged,
  guardReceipt,
  guardRefuses,
  guardStatusLine,
  measureGuard,
  parsePercent,
  readGuardReview,
  type GuardReview,
  type PriceGuard,
} from './priceGuard';

/** The store key one offer's guard change keeps its state under. */
export function guardKey(id: bigint): string {
  return `offers.guard.${id.toString()}`;
}

/** The change open or in flight for an offer's guard: the limit in bps
 *  (0 = clear), or null when none is. */
export function useGuardHeld(id: bigint): { bps: number | null; inFlight: boolean; open: (bps: number | null) => void } {
  const key = guardKey(id);
  const entry = useTxEntry(key);
  const [bps, setBps] = useStoredValue<number>(`${key}:bps`);
  return { bps, inFlight: holdsFlow(entry.phase), open: setBps };
}

interface SectionProps {
  id: bigint;
  /** The guard as the page read it; 'absent' when this network's protocol
   *  has none yet; null when unread. */
  guard: PriceGuard | 'absent' | null;
  /** Whether the reader created the offer and it is open, of an ERC-20
   *  against ERC-20 collateral: the only case the guard can be changed. */
  canChange: boolean;
  /** Whether the reader created the offer. */
  mine: boolean;
  chain: SupportedChain | null;
  own: OwnStateClient | null;
  onDone: () => void;
}

/**
 * #3358 — the price-move guard on an offer's page: where it stands now for
 * everyone who looks (a taker sees why a fill would be refused), and for the
 * creator of an open ERC-20 offer, a way to set, change or remove it. The
 * review says that the offer was unguarded between its post and this change.
 */
export function PriceGuardSection({ id, guard, canChange, mine, chain, own, onDone }: SectionProps) {
  const copy = useCopy();
  const { text, format } = copy;
  const held = useGuardHeld(id);
  const [input, setInput] = useState('');
  const g = guard !== null && guard !== 'absent' ? guard : null;
  const on = g !== null && g.maxMoveBps > 0;
  const typed = parsePercent(input);
  const inRange = typed !== null && typed >= GUARD_BPS_MIN && typed <= GUARD_BPS_MAX;

  if (guard === 'absent') {
    return mine ? (
      <p className="tier-b" data-testid="guard-absent">
        {text('priceGuard.absent')}
      </p>
    ) : null;
  }
  if (!on && !canChange && held.bps === null && !held.inFlight) return null;
  return (
    <section className="home-section" aria-labelledby="guard-title" data-testid="guard" data-on={String(on)} data-status={g?.status ?? 'unread'}>
      <h2 id="guard-title">{text('priceGuard.title')}</h2>
      {guard === null && <p className="tier-a">{text('priceGuard.guardUnread')}</p>}
      {g !== null && !on && <p className="tier-b">{text('priceGuard.none')}</p>}
      {g !== null && on && (
        <>
          <p className="tier-a" data-testid="guard-limit">
            {format('priceGuard.limitLine', { limit: bpsPercent(g.maxMoveBps), at: formatUtc(g.setAt) })}
          </p>
          {guardRefuses(g) ? (
            <Notice tone="warn" tier="A">
              <span data-testid="guard-status">{guardStatusLine(g, copy)}</span>
            </Notice>
          ) : (
            <p className="tier-b" data-testid="guard-status">
              {guardStatusLine(g, copy)}
            </p>
          )}
        </>
      )}
      <p className="tier-b">{text('priceGuard.lead')}</p>
      {held.bps !== null && chain !== null && own !== null ? (
        <GuardActionFlow
          id={id}
          chain={chain}
          own={own}
          bps={held.bps}
          onClose={() => {
            held.open(null);
            onDone();
          }}
        />
      ) : (
        canChange && (
          <div className="guard-form">
            <label htmlFor={`guard-input-${id}`}>{text(on ? 'priceGuard.inputChange' : 'priceGuard.inputSet')}</label>
            <p className="tier-b">{format('priceGuard.inputHint', { min: bpsPercent(GUARD_BPS_MIN), max: bpsPercent(GUARD_BPS_MAX) })}</p>
            <input
              id={`guard-input-${id}`}
              data-testid="guard-input"
              inputMode="decimal"
              autoComplete="off"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              aria-invalid={input !== '' && !inRange}
            />
            {input !== '' && !inRange && (
              <p className="tier-a">{format('priceGuard.outOfRange', { min: bpsPercent(GUARD_BPS_MIN), max: bpsPercent(GUARD_BPS_MAX) })}</p>
            )}
            <p className="actions">
              <button type="button" className="btn btn-primary" disabled={!inRange} onClick={() => typed !== null && held.open(typed)} data-testid="guard-set">
                {text(on ? 'priceGuard.change' : 'priceGuard.set')}
              </button>
              {on && (
                <button type="button" className="btn" onClick={() => held.open(0)} data-testid="guard-clear">
                  {text('priceGuard.clear')}
                </button>
              )}
            </p>
          </div>
        )
      )}
      <WhyLink summaryKey="priceGuard.whySummary" detailKey="priceGuard.why" />
    </section>
  );
}

interface FlowProps {
  id: bigint;
  chain: SupportedChain;
  own: OwnStateClient;
  bps: number;
  onClose: () => void;
}

/** The creator's guard change: review, the protocol's dry run, sign, and the
 *  finish card from the transaction's own logs. */
function GuardActionFlow({ id, chain, own, bps, onClose }: FlowProps) {
  const copy = useCopy();
  const { text, format } = copy;
  const config = useConfig();
  const diamond = chain.diamondAddress;
  const identity = reviewIdentity(own);
  const key = guardKey(id);
  const [review, setReview] = useStoredValue<GuardReview>(`${key}:review`);
  const [loadError, setLoadError] = useState<string | null>(null);
  const setStep = useTxNote(key);
  const sameChoice = (r: GuardReview | null) => r !== null && r.bps === bps && r.facts.offerId === id;

  const tx = useTrackedTx({
    key,
    chainId: chain.chainId,
    account: own.account,
    sources: own.sources,
    send: async () => {
      if (!review) throw new Error('no guard change under review');
      const stop = (reason: string): never => {
        throw new StatedRefusal({ code: 'GuardStopped', reason, reopensAt: null, remedy: null });
      };
      const call = guardCall(id, bps);
      const dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, ...call, account: own.account }));
      if (dry.kind === 'reverted') return stop(format('safety.dryRunRefused', { reason: refusalFromError(dry.error).reason }));
      if (dry.kind === 'unreadable') return stop(format('flow.unreadable', { reason: dry.reason }));
      setStep(format('accept.stepOf', { n: '1', total: '1', what: text(bps === 0 ? 'priceGuard.stepClear' : 'priceGuard.stepSet') }));
      return writeContract(config, { address: diamond, ...call, chainId: chain.chainId, account: own.account });
    },
    measure: async (receipt) => (review ? measureGuard(review, receipt.logs, diamond, copy) : []),
    release: async () => null,
  });

  const mounted = useMounted();
  const read = (who: string) => readGuardReview(own, diamond, id, bps, who, copy);
  const load = async () => {
    try {
      const next = await read(identity);
      if (!mounted.current) return;
      setLoadError(null);
      setReview(next);
    } catch (e) {
      setLoadError(refusalFromError(e).reason);
    }
  };

  // RB-RAILS: read again each block while the review is on screen.
  const onReview = tx.phase.kind === 'review' && sameChoice(review);
  useReviewRefresh<GuardReview>({
    chainId: chain.chainId,
    active: onReview,
    review,
    read: (before) => read(before.identity),
    sameSubject: (a, b) => a.bps === b.bps && a.facts.offerId === b.facts.offerId,
    changed: (before, next) => guardChanged(before, next, copy) !== null,
    setReview,
    onChanged: () => undefined,
  });

  const reviewOpened = useRef(false);
  useEffect(() => {
    const open = tx.phase.kind === 'idle' || tx.phase.kind === 'review';
    if (!open) return;
    if (tx.phase.kind === 'idle' && !reviewOpened.current) {
      reviewOpened.current = true;
      tx.review();
    }
    if (!sameChoice(review) || review!.identity !== identity) {
      setReview(null);
      let live = true;
      read(identity).then(
        (next) => {
          if (!live) return;
          setLoadError(null);
          setReview(next);
        },
        (e: unknown) => {
          if (live) setLoadError(refusalFromError(e).reason);
        },
      );
      return () => {
        live = false;
      };
    }
    // Opened once per choice; the tracker and the stored review carry the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, bps]);

  const recheck = async (current: () => boolean): Promise<Recheck> => {
    if (!review) return { kind: 'unreadable', reason: text('flow.reading') };
    let next: GuardReview;
    try {
      next = await read(review.identity);
    } catch (e) {
      return { kind: 'unreadable', reason: refusalFromError(e).reason };
    }
    const what = guardChanged(review, next, copy);
    if (current()) setReview(next);
    if (what !== null) return { kind: 'changed', what };
    const blockers = guardBlockers(next, copy);
    if (blockers.length > 0)
      return {
        kind: 'refused',
        refusal: {
          code: next.dryRun !== null && next.dryRun !== 'unread' ? next.dryRun.code : 'GuardBlocked',
          reason: blockers[0]!,
          reopensAt: null,
          remedy: null,
        },
      };
    return { kind: 'ok' };
  };

  const blockers = review ? guardBlockers(review, copy) : [];
  const gate = review
    ? {
        ready: blockers.length === 0,
        node: (
          <div className="repay-gate">
            {blockers.map((b) => (
              <Notice key={b} tone="danger" tier="A">
                {b}
              </Notice>
            ))}
          </div>
        ),
      }
    : undefined;

  const close = () => {
    setReview(null);
    setStep(null);
    reviewOpened.current = false;
    onClose();
  };

  return (
    <div className="repay-loan" data-testid="guard-panel" data-bps={bps}>
      {loadError !== null && (
        <Notice tone="warn" tier="A">
          {format('flow.unreadable', { reason: loadError })}{' '}
          <button type="button" className="btn" onClick={() => void load()}>
            {text('consent.retry')}
          </button>
        </Notice>
      )}
      <ActionFlow
        tx={tx}
        identity={identity}
        reviewedFor={review?.identity ?? tx.frozen?.identity ?? identity}
        receipt={review && sameChoice(review) ? guardReceipt(review, copy) : null}
        recheck={recheck}
        describeAsset={() => null}
        explorer={chain.blockExplorer}
        next={null}
        gate={gate}
        onClose={close}
      />
    </div>
  );
}
