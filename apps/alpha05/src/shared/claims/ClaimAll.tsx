import { Fragment, useEffect, useRef, useState } from 'react';
import { useConfig } from 'wagmi';
import { sendWrite } from '../tx/send';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useCopy } from '../copy/useCopy';
import { refusalFromError, StatedRefusal } from '../eligibility/refusal';
import { WhyLink } from '../help/WhyLink';
import { assetAmount } from '../positions/assetAmount';
import type { Payouts } from '../positions/reads';
import { exactTokenAmount, tokenAmount, useTokenMeta, type TokenMetaMap } from '../reads/tokens';
import { useOwnRead } from '../reads/useOwnRead';
import type { FrozenState } from '../sanctions/posture';
import { askThrough } from '../tx/simulate';
import { holdsFlow, useStoredValue, useTxEntry, useTxNote } from '../tx/txStore';
import { useMounted, useReviewRefresh } from '../tx/useReviewRefresh';
import { useTrackedTx } from '../tx/useTrackedTx';
import { ActionFlow, reviewIdentity, type Recheck } from '../ui/ActionFlow';
import { Notice } from '../ui/Notice';
import { OwnStamp } from '../ui/OwnStamp';
import { shortAddress } from '../ui/format';
import {
  batchCalls,
  batchOf,
  batchStop,
  CLAIM_ALL_MAX_CALLS,
  claimAllBlockers,
  claimAllChanged,
  claimAllReceipt,
  defaultPicked,
  gapText,
  legResults,
  legTitle,
  measureClaimAll,
  claimAllGasLimit,
  optInText,
  payoutLabel,
  type ClaimAllLeg,
  type ClaimAllReview,
  type ClaimAllWords,
  type LegPayout,
} from './claimAll';
import { creditedTo } from '../protection/payout';
import { MULTICALL, readClaimAllList, readClaimAllReview } from './claimAllRead';
import { readClaimantVault } from './claimOutcome';
import { readPendingRewards, remainderAfter } from './rewards';

type Hex = `0x${string}`;

/** The store key Claim everything keeps its state under. */
export const CLAIM_ALL_KEY = 'claim.all';

/** The reader's changes to the default picks, kept per wallet and network:
 *  a leg turned on that is off by default, or off that is on by default. A
 *  leg that appears later takes its default. */
interface Choice {
  identity: string;
  on: string[];
  off: string[];
}

function picks(legs: readonly ClaimAllLeg[], choice: Choice | null, identity: string): Set<string> {
  const base = defaultPicked(legs);
  if (choice === null || choice.identity !== identity) return base;
  for (const k of choice.off) base.delete(k);
  for (const k of choice.on) if (legs.some((l) => l.key === k)) base.add(k);
  return base;
}

function useWords(meta: TokenMetaMap | null): ClaimAllWords {
  const { format } = useCopy();
  return {
    amount: (asset, v) => tokenAmount(v, asset, meta, format),
    exact: (asset, v) => exactTokenAmount(v, asset, meta, format),
    symbol: (asset) => meta?.[asset.toLowerCase()]?.symbol ?? shortAddress(asset),
    nft: (p: LegPayout) => assetAmount({ asset: p.asset, assetType: p.assetType, amount: 0n, tokenId: p.tokenId, quantity: p.amount }, meta, format),
  };
}

function payoutText(p: LegPayout, w: ClaimAllWords): string {
  return p.assetType === 0 ? w.amount(p.asset, p.amount) : w.nft(p);
}

/**
 * Claims › Claim everything (LN-51, RB-CLAIM): every payout this wallet can
 * collect now, each listed with what it pays and a switch to include it or
 * leave it out, collected in one transaction. A source that could not be
 * read is named as left out; the batch is offered only once the list is
 * read; the pause and a flagged wallet stop it before signing, said once.
 * The flow stays on screen until its finish card is closed.
 */
export function ClaimAll({
  own,
  chain,
  payouts,
  payoutsFailed = false,
  frozen,
}: {
  own: OwnStateClient;
  chain: SupportedChain;
  payouts: Payouts | null;
  /** The position book could not be read: the loans are named as left out
   *  and every other source is still read and offered. */
  payoutsFailed?: boolean;
  frozen?: FrozenState;
}) {
  const copy = useCopy();
  const { text, format } = copy;
  const diamond = chain.diamondAddress;
  const identity = reviewIdentity(own);
  const ids = payouts ? [...payouts.rows, ...payouts.unlisted].map((p) => `${p.side}:${p.loanId}`).join(',') : 'unread';
  const list = useOwnRead(['claimAll', diamond, ids], (c) => readClaimAllList(c, diamond, own.account, payouts, copy), { enabled: payouts !== null || payoutsFailed });
  const [choice, setChoice] = useStoredValue<Choice>(`${CLAIM_ALL_KEY}:choice`);
  const [open, setOpen] = useStoredValue<boolean>(`${CLAIM_ALL_KEY}:open`);
  const entry = useTxEntry(CLAIM_ALL_KEY);
  const held = open === true || holdsFlow(entry.phase);
  const data = list.data;
  const legs = data?.legs ?? [];
  const picked = picks(legs, choice, identity);
  const assets: Hex[] = legs.flatMap((l) => [...l.payouts.map((p) => p.asset), ...(l.subject.kind === 'intent' ? [l.subject.collateralAsset] : [])]);
  const meta = useTokenMeta(assets).data;
  const w = useWords(meta);
  const { now, later } = batchOf(legs, picked);
  const stop = data ? batchStop({ paused: data.paused, frozen: frozen ?? data.frozen }, copy) : null;

  const toggle = (l: ClaimAllLeg, on: boolean) => {
    const current = choice !== null && choice.identity === identity ? choice : { identity, on: [], off: [] };
    const without = (xs: string[]) => xs.filter((k) => k !== l.key);
    const byDefault = !l.optIn;
    setChoice({
      identity,
      on: on && !byDefault ? [...without(current.on), l.key] : without(current.on),
      off: !on && byDefault ? [...without(current.off), l.key] : without(current.off),
    });
  };

  return (
    <section className="home-section" aria-labelledby="claims-all">
      <h2 id="claims-all">{text('claimAll.sectionTitle')}</h2>
      {payouts !== null && <OwnStamp reads={[list]} />}
      {data === null && list.state !== 'failed' && <p className="tier-b">{text('claimAll.reading')}</p>}
      {list.state === 'failed' && data === null && (
        <p className="tier-a" data-testid="claim-all-failed">
          {format('claimAll.failed', { reason: list.error ?? '' })}
        </p>
      )}
      {data !== null && legs.length === 0 && !held && (
        <p className="tier-b home-empty" data-testid="claim-all-empty">
          {text(data.gaps.length === 0 ? 'claimAll.empty' : 'claimAll.emptyGaps')}
        </p>
      )}
      {legs.length > 0 && (
        <ul className="rows" data-testid="claim-all-legs">
          {legs.map((l) => {
            const note = optInText(l, copy);
            return (
              <li key={l.key} className="card" data-claim-leg={l.key}>
                <label className="choice">
                  <input type="checkbox" checked={picked.has(l.key)} disabled={held} onChange={(e) => toggle(l, e.target.checked)} data-testid={`claim-all-pick-${l.key}`} />
                  <span className="row-head">{legTitle(l, copy, w.symbol)}</span>
                </label>
                <dl className="facts">
                  {l.payouts.map((p, n) => (
                    <Fragment key={n}>
                      <dt className="tier-b">{payoutLabel(l, p, copy) ?? text(l.route === 'reward-vault' ? 'claimAll.rowToVault' : 'claimAll.rowPays')}</dt>
                      <dd data-testid={`claim-all-amount-${l.key}`}>{payoutText(p, w)}</dd>
                    </Fragment>
                  ))}
                </dl>
                {note !== null && <p className="tier-b">{note}</p>}
              </li>
            );
          })}
        </ul>
      )}
      {data !== null &&
        data.gaps.map((g) => (
          <p key={`${g.kind}:${g.why}:${g.side ?? ''}:${g.loanId ?? ''}`} className="tier-a" data-testid={`claim-all-gap-${g.kind}`}>
            {gapText(g, copy)}
          </p>
        ))}
      {held ? (
        <ClaimAllFlow chain={chain} own={own} payouts={payouts} picked={[...picked]} meta={meta} onClose={() => setOpen(null)} />
      ) : (
        legs.length > 0 && (
          <>
            {later.length > 0 && <p className="tier-b">{format('claimAll.remainderNow', { n: String(later.length), max: String(CLAIM_ALL_MAX_CALLS) })}</p>}
            {stop !== null ? (
              <p className={stop.code === 'Unread' ? 'tier-a' : 'tier-b'} data-code={stop.code} data-testid="claim-all-stop">
                {stop.reason}
              </p>
            ) : (
              <div className="form-actions">
                <button type="button" className="btn btn-primary" disabled={now.length === 0} onClick={() => setOpen(true)} data-testid="claim-all-review">
                  {now.length === 0 ? text('claimAll.chooseOne') : format(now.length === 1 ? 'claimAll.actionOne' : 'claimAll.action', { n: String(now.length) })}
                </button>
              </div>
            )}
          </>
        )
      )}
      <WhyLink summaryKey="claimAll.whySummary" detailKey="claimAll.why" />
    </section>
  );
}

interface FlowProps {
  chain: SupportedChain;
  own: OwnStateClient;
  payouts: Payouts | null;
  picked: string[];
  meta: TokenMetaMap | null;
  onClose: () => void;
}

/**
 * The batch's review and transaction. The review states every payout it
 * sends, those the protocol's dry run refuses (left out, each with its
 * reason), the remainder past the batch bound, where each payment lands and
 * every consequence; it is sent only after the dry run, and its outcome is
 * measured from the transaction's own logs, leg by leg. Nothing leaves the
 * wallet and no approval is asked.
 */
function ClaimAllFlow({ chain, own, payouts, picked, meta, onClose }: FlowProps) {
  const copy = useCopy();
  const { text, format } = copy;
  const config = useConfig();
  const diamond = chain.diamondAddress;
  const account = own.account;
  const identity = reviewIdentity(own);
  const [review, setReview] = useStoredValue<ClaimAllReview>(`${CLAIM_ALL_KEY}:review`);
  // Whether the batch credited the vault: the finish card then offers the
  // withdrawal.
  const [credited, setCredited] = useStoredValue<boolean>(`${CLAIM_ALL_KEY}:credited`);
  const [loadError, setLoadError] = useState<string | null>(null);
  const setStep = useTxNote(CLAIM_ALL_KEY);
  const w = useWords(meta);
  const tx = useTrackedTx({
    key: CLAIM_ALL_KEY,
    chainId: chain.chainId,
    account,
    sources: own.sources,
    send: async () => {
      if (!review || review.send.length === 0) throw new Error('no batch under review');
      const stop = (reason: string): never => {
        throw new StatedRefusal({ code: 'ClaimAllStopped', reason, reopensAt: null, remedy: null });
      };
      // The dry run again, at send, of exactly the calls the review states:
      // a payout it now refuses means the review no longer holds.
      const calls = batchCalls(review.send, account);
      const dry = await askThrough(own, (c) =>
        c
          .simulateContract({ address: diamond, abi: MULTICALL, functionName: 'multicall', args: [calls], account })
          .then((x) => x.result as readonly { success: boolean; returnData: Hex }[]),
      );
      if (dry.kind === 'reverted') return stop(format('repay.dryRunRefused', { reason: refusalFromError(dry.error).reason }));
      if (dry.kind === 'unreadable') return stop(format('flow.unreadable', { reason: dry.reason }));
      const refused = [...legResults(review.send, dry.value).entries()].find(([, r]) => r !== null);
      if (refused) {
        const l = review.send.find((x) => x.key === refused[0])!;
        return stop(format('claimAll.refusedAtSend', { what: legTitle(l, copy, w.symbol), reason: refused[1]!.reason }));
      }
      // The gas limit comes from the same calls each required to succeed:
      // an estimate of the batch as sent could stop where a payout runs out
      // of gas and is skipped rather than reverting the transaction.
      const required = batchCalls(review.send, account, false);
      const est = await askThrough(own, (c) => c.estimateContractGas({ address: diamond, abi: MULTICALL, functionName: 'multicall', args: [required], account }));
      if (est.kind === 'reverted') return stop(format('repay.dryRunRefused', { reason: refusalFromError(est.error).reason }));
      if (est.kind === 'unreadable') return stop(format('flow.unreadable', { reason: est.reason }));
      setStep(format('accept.stepOf', { n: '1', total: '1', what: text('claimAll.stepSend') }));
      return sendWrite(config, {
        address: diamond,
        abi: MULTICALL,
        functionName: 'multicall',
        args: [calls],
        chainId: chain.chainId,
        account,
        gas: claimAllGasLimit(est.value),
      });
    },
    measure: async (receipt, at) => {
      if (!review) return [];
      const vault = await readClaimantVault(at, diamond, account);
      setCredited(vault !== null && creditedTo(receipt.logs, diamond, vault));
      // A rewards claim pays a bounded run of days: whether more remains is
      // read at the claim's own block or later.
      let more: boolean | null = null;
      if (review.send.some((l) => l.subject.kind === 'rewards')) {
        const now = await own
          .read((c) => readPendingRewards(c, diamond, account))
          .then((x) => x.value)
          .catch(() => null);
        more = remainderAfter(now, receipt.blockNumber);
      }
      return measureClaimAll(review, receipt.logs, diamond, account, vault, w, copy, more);
    },
    release: async () => null,
  });

  const mounted = useMounted();
  const read = (who: string, keys: readonly string[]) => readClaimAllReview(own, diamond, payouts, keys, who, copy);
  const load = async () => {
    try {
      const next = await read(identity, picked);
      if (!mounted.current) return;
      setLoadError(null);
      setReview(next);
    } catch (e) {
      setLoadError(refusalFromError(e).reason);
    }
  };

  // RB-RAILS: read again each block while the review is on screen.
  const onReview = tx.phase.kind === 'review' && review !== null;
  useReviewRefresh<ClaimAllReview>({
    chainId: chain.chainId,
    active: onReview,
    review,
    read: (before) => read(before.identity, before.picked),
    sameSubject: (a, b) => a.picked.join('|') === b.picked.join('|'),
    changed: (before, next) => claimAllChanged(before, next, copy) !== null,
    setReview,
    onChanged: () => undefined,
  });

  const reviewOpened = useRef(false);
  useEffect(() => {
    const isOpen = tx.phase.kind === 'idle' || tx.phase.kind === 'review';
    if (!isOpen) return;
    if (tx.phase.kind === 'idle' && !reviewOpened.current) {
      reviewOpened.current = true;
      tx.review();
    }
    if (review === null || review.identity !== identity || review.picked.join('|') !== picked.join('|')) {
      setReview(null);
      let live = true;
      read(identity, picked).then(
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
    // Opened once; the tracker and the stored review carry the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const recheck = async (current: () => boolean): Promise<Recheck> => {
    if (!review) return { kind: 'unreadable', reason: text('flow.reading') };
    let next: ClaimAllReview;
    try {
      next = await read(review.identity, review.picked);
    } catch (e) {
      return { kind: 'unreadable', reason: refusalFromError(e).reason };
    }
    const what = claimAllChanged(review, next, copy);
    if (current()) setReview(next);
    if (what !== null) return { kind: 'changed', what };
    const blockers = claimAllBlockers(next, copy);
    if (blockers.length > 0) {
      const stop = batchStop(next.list, copy);
      return {
        kind: 'refused',
        refusal: {
          code: stop?.code ?? (next.dryRun !== null && typeof next.dryRun === 'object' ? next.dryRun.code : 'ClaimAllBlocked'),
          reason: blockers[0]!,
          reopensAt: null,
          remedy: null,
        },
      };
    }
    return { kind: 'ok' };
  };

  const blockers = review ? claimAllBlockers(review, copy) : [];
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
            <WhyLink summaryKey="claimAll.whySummary" detailKey="claimAll.why" />
          </div>
        ),
      }
    : undefined;

  const describeAsset = (a: Hex) => {
    const m = meta?.[a.toLowerCase()];
    return m && m.decimals !== null ? { symbol: m.symbol ?? shortAddress(a), decimals: m.decimals } : null;
  };

  const close = () => {
    setReview(null);
    setStep(null);
    reviewOpened.current = false;
    onClose();
  };

  return (
    <div className="repay-loan" data-testid="claim-all-panel">
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
        receipt={review ? claimAllReceipt(review, copy, { symbol: w.symbol, nft: w.nft }) : null}
        recheck={recheck}
        describeAsset={describeAsset}
        explorer={chain.blockExplorer}
        next={credited === true ? { label: text('payout.withdrawNext'), to: '/vault' } : null}
        gate={gate}
        onClose={close}
      />
    </div>
  );
}
