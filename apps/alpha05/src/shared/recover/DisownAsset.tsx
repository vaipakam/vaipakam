import { useEffect, useRef, useState } from 'react';
import type { Log } from 'viem';
import { useConfig } from 'wagmi';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useCopy } from '../copy/useCopy';
import { refusalFromError, StatedRefusal } from '../eligibility/refusal';
import { WhyLink } from '../help/WhyLink';
import { tokenAmount, useTokenMeta, type TokenMetaMap } from '../reads/tokens';
import type { LegOutcome } from '../tx/outcome';
import { sendWrite } from '../tx/send';
import { askThrough } from '../tx/simulate';
import { useStoredValue, useTxNote } from '../tx/txStore';
import { useMounted, useReviewRefresh } from '../tx/useReviewRefresh';
import { useTrackedTx } from '../tx/useTrackedTx';
import { ActionFlow, reviewIdentity, type Recheck } from '../ui/ActionFlow';
import { Notice } from '../ui/Notice';
import { shortAddress } from '../ui/format';
import { disownCall, disownRecorded, disownStops, readRecoverFacts, type RecoverFacts, type RecoverSubject } from './adopt';
import { disownReceipt, subjectName } from './recoverReceipt';

type Hex = `0x${string}`;

/** The store key a disowning keeps its state under: one at a time. */
export const DISOWN_KEY = 'recover.disown';

const same = (a: RecoverSubject, b: RecoverSubject) => a.standard === b.standard && a.asset.toLowerCase() === b.asset.toLowerCase() && a.tokenId === b.tokenId;

interface DisownReview {
  identity: string;
  facts: RecoverFacts;
  readAt: number;
}

/**
 * ACC-26 — disown what sits uncounted in my vault: a public record on the
 * chain that I do not claim it. It moves and credits nothing, asks no
 * declaration, signature or screen, and stays open to a replaced wallet and
 * a barred vault. The finish card says what the transaction's record shows.
 */
export function DisownAsset({ chain, own, subject, onClose }: { chain: SupportedChain; own: OwnStateClient; subject: RecoverSubject; onClose: () => void }) {
  const copy = useCopy();
  const { text, format } = copy;
  const config = useConfig();
  const diamond = chain.diamondAddress;
  const account = own.account;
  const identity = reviewIdentity(own);
  const meta = useTokenMeta([subject.asset]).data;
  const [review, setReview] = useStoredValue<DisownReview>(`${DISOWN_KEY}:review`);
  const [loadError, setLoadError] = useState<string | null>(null);
  const setStep = useTxNote(DISOWN_KEY);
  const nft = subject.standard !== 'erc20';
  const amountText = (v: bigint) => (nft ? v.toString() : tokenAmount(v, subject.asset, meta, format));
  const read = async (who: string): Promise<DisownReview> => {
    const facts = (await own.read((c) => readRecoverFacts(c, diamond, account, subject))).value;
    return { identity: who, facts, readAt: facts.readAt };
  };

  const tx = useTrackedTx({
    key: DISOWN_KEY,
    chainId: chain.chainId,
    account,
    sources: own.sources,
    send: async () => {
      const call = disownCall(subject);
      const dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, ...call, account }));
      const stop = (reason: string): never => {
        throw new StatedRefusal({ code: 'DisownStopped', reason, reopensAt: null, remedy: null });
      };
      if (dry.kind === 'reverted') return stop(format('recover.dryRunRefused', { reason: refusalFromError(dry.error).reason }));
      if (dry.kind === 'unreadable') return stop(format('flow.unreadable', { reason: dry.reason }));
      setStep(format('accept.stepOf', { n: '1', total: '1', what: text('recover.stepDisown') }));
      return sendWrite(config, { address: diamond, ...call, chainId: chain.chainId, account });
    },
    measure: async (receipt) => measure(receipt.logs),
    release: async () => null,
  });

  const measure = (logs: readonly Log[]): LegOutcome[] => {
    const label = format('recover.legDisowned', { what: subjectName(subject, meta, copy) });
    const observed = disownRecorded(logs, diamond, account, subject);
    if (observed === null) return [{ status: 'not-done', label, reason: text('recover.legDisownNone') }];
    return [{ status: 'done', label: format('recover.legDisownedAmount', { what: subjectName(subject, meta, copy), amount: amountText(observed) }) }];
  };

  const mounted = useMounted();
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

  const onReview = tx.phase.kind === 'review' && review !== null && same(review.facts.subject, subject);
  useReviewRefresh<DisownReview>({
    chainId: chain.chainId,
    active: onReview,
    review,
    read: (before) => read(before.identity),
    sameSubject: (a, b) => same(a.facts.subject, b.facts.subject),
    changed: (a, b) => a.facts.untracked !== b.facts.untracked || a.facts.vault !== b.facts.vault,
    setReview,
    onChanged: () => undefined,
  });

  const opened = useRef(false);
  useEffect(() => {
    const open = tx.phase.kind === 'idle' || tx.phase.kind === 'review';
    if (!open) return;
    if (tx.phase.kind === 'idle' && !opened.current) {
      opened.current = true;
      tx.review();
    }
    if (review === null || !same(review.facts.subject, subject) || review.identity !== identity) {
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
    // Opened once per subject; the tracker and the stored review carry the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const recheck = async (current: () => boolean): Promise<Recheck> => {
    if (!review) return { kind: 'unreadable', reason: text('flow.reading') };
    let next: DisownReview;
    try {
      next = await read(review.identity);
    } catch (e) {
      return { kind: 'unreadable', reason: refusalFromError(e).reason };
    }
    if (current()) setReview(next);
    if (next.facts.untracked !== review.facts.untracked) return { kind: 'changed', what: text('recover.changedUntracked') };
    const stops = disownStops(next.facts, copy);
    if (stops.length > 0) return { kind: 'refused', refusal: { code: 'DisownBlocked', reason: stops[0]!, reopensAt: null, remedy: null } };
    return { kind: 'ok' };
  };

  const stops = review ? disownStops(review.facts, copy) : [];
  const gate = review
    ? {
        ready: stops.length === 0,
        node: (
          <div className="repay-gate">
            {stops.map((b) => (
              <Notice key={b} tone="danger" tier="A">
                {b}
              </Notice>
            ))}
            <WhyLink summaryKey="recover.whyDisownSummary" detailKey="recover.whyDisown" />
          </div>
        ),
      }
    : undefined;

  const describeAsset = (a: Hex) => {
    const m = (meta as TokenMetaMap | null)?.[a.toLowerCase()];
    return m && m.decimals !== null ? { symbol: m.symbol ?? shortAddress(a), decimals: m.decimals } : null;
  };

  const close = () => {
    setReview(null);
    setStep(null);
    opened.current = false;
    onClose();
  };

  return (
    <div className="repay-loan" data-testid="recover-disown-panel">
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
        receipt={review ? disownReceipt(review.facts, meta, copy) : null}
        recheck={recheck}
        describeAsset={describeAsset}
        explorer={chain.blockExplorer}
        next={null}
        gate={gate}
        onClose={close}
      />
    </div>
  );
}
