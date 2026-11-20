import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Abi } from 'viem';
import { useConfig } from 'wagmi';
import { PositionNFTABI } from '@vaipakam/contracts/abis';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useCopy, type CopyKey } from '../copy/useCopy';
import { refusalFromError, StatedRefusal } from '../eligibility/refusal';
import { positionNftForDiamond, readLiveHolderOrNull } from '../positions/positionNft';
import type { TokenMetaMap } from '../reads/tokens';
import { sendWrite } from '../tx/send';
import type { LegOutcome } from '../tx/outcome';
import { askThrough } from '../tx/simulate';
import { useStoredValue, useTxNote } from '../tx/txStore';
import { useMounted, useReviewRefresh } from '../tx/useReviewRefresh';
import { useTrackedTx } from '../tx/useTrackedTx';
import { ActionFlow, reviewIdentity, type Recheck } from '../ui/ActionFlow';
import { Notice } from '../ui/Notice';
import { giftTransferred } from './giveLog';
import { giveReceipt } from './giveReceipt';
import { checkReceiver, giveBlockers, giveChangedBetween, readGiveReview, transferRefusal, type GiveReview, type ReceiverProblem } from './giveReview';

type Hex = `0x${string}`;

const NFT = PositionNFTABI as Abi;

const RECEIVER_ERRORS: Record<ReceiverProblem, CopyKey> = {
  empty: 'give.errEmpty',
  invalid: 'give.errInvalid',
  self: 'give.errSelf',
  'contract-of-platform': 'give.errPlatform',
};

/** The store key a give keeps its state under: one per loan. */
export function giveKey(loanId: bigint): string {
  return `position.give.${loanId.toString()}`;
}

interface GiveLoanProps {
  loanId: bigint;
  chain: SupportedChain;
  own: OwnStateClient;
  meta: TokenMetaMap | null;
}

/**
 * #3771 — Give this loan: the holder of a running loan's lender side sends
 * the position token to another wallet. The reader names the receiver
 * first; the review then states what the receiver gets and what stays, and
 * the transfer is tried as a simulated call before the wallet is asked.
 */
export function GiveLoanCard({ loanId, chain, own, meta }: GiveLoanProps) {
  const { text } = useCopy();
  const [open, setOpen] = useState(false);
  const [receiver, setReceiver] = useStoredValue<Hex>(`${giveKey(loanId)}:receiver`);
  return (
    <section className="home-section position-give" aria-labelledby="position-give" data-testid="give-loan-card">
      <h2 id="position-give">{text('give.cardTitle')}</h2>
      <p className="tier-b">{text('give.lead')}</p>
      {!open && receiver === null ? (
        <button type="button" className="btn" onClick={() => setOpen(true)} data-testid="give-open">
          {text('give.open')}
        </button>
      ) : receiver === null ? (
        <ReceiverForm giver={own.account} diamond={chain.diamondAddress as Hex} onPick={setReceiver} onCancel={() => setOpen(false)} />
      ) : (
        <GiveLoanFlow
          loanId={loanId}
          chain={chain}
          own={own}
          meta={meta}
          receiver={receiver}
          onClose={() => {
            setReceiver(null);
            setOpen(false);
          }}
        />
      )}
    </section>
  );
}

function ReceiverForm({ giver, diamond, onPick, onCancel }: { giver: Hex; diamond: Hex; onPick: (r: Hex) => void; onCancel: () => void }) {
  const { text } = useCopy();
  const [value, setValue] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<CopyKey | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const c = checkReceiver(value, giver, diamond);
    if (!c.ok) return setError(RECEIVER_ERRORS[c.problem]);
    // Typed twice: a token sent to a wrong address cannot be recalled.
    if (again.trim().toLowerCase() !== value.trim().toLowerCase()) return setError('give.errMismatch');
    setError(null);
    onPick(c.receiver);
  };
  return (
    <form onSubmit={submit} data-testid="give-receiver-form">
      <div className="field">
        <label htmlFor="give-receiver">{text('give.receiverLabel')}</label>
        <input id="give-receiver" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" spellCheck={false} placeholder="0x…" />
      </div>
      <div className="field">
        <label htmlFor="give-receiver-again">{text('give.receiverAgain')}</label>
        <input id="give-receiver-again" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="off" spellCheck={false} placeholder="0x…" />
      </div>
      <p className="tier-b">{text('give.receiverNote')}</p>
      {error !== null && (
        <p className="tier-a" role="alert" data-testid="give-receiver-error">
          {text(error)}
        </p>
      )}
      <div className="position-action-row">
        <button type="submit" className="btn btn-primary" data-testid="give-review">
          {text('give.review')}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          {text('give.cancel')}
        </button>
      </div>
    </form>
  );
}

function GiveLoanFlow({ loanId, chain, own, meta, receiver, onClose }: GiveLoanProps & { receiver: Hex; onClose: () => void }) {
  const copy = useCopy();
  const { text, format } = copy;
  const config = useConfig();
  const diamond = chain.diamondAddress as Hex;
  const account = own.account;
  const identity = reviewIdentity(own);
  const flowKey = giveKey(loanId);
  const [review, setReview] = useStoredValue<GiveReview>(`${flowKey}:review`);
  const [loadError, setLoadError] = useState<string | null>(null);
  const setStep = useTxNote(flowKey);
  const nft = positionNftForDiamond(diamond).nft;

  const tx = useTrackedTx({
    key: flowKey,
    chainId: chain.chainId,
    account,
    sources: own.sources,
    send: async () => {
      if (!review) throw new Error('no give under review');
      const args = [account, review.receiver, review.tokenId] as const;
      // The dry run: the token's own transfer and the protocol's check, now.
      const dry = await askThrough(own, (c) => c.simulateContract({ address: nft, abi: NFT, functionName: 'safeTransferFrom', args, account }));
      if (dry.kind === 'reverted') throw new StatedRefusal(transferRefusal(dry.error, copy));
      if (dry.kind === 'unreadable') throw new StatedRefusal({ code: 'GiveStopped', reason: format('flow.unreadable', { reason: dry.reason }), reopensAt: null, remedy: null });
      setStep(text('give.stepSend'));
      return sendWrite(config, { address: nft, abi: NFT, functionName: 'safeTransferFrom', args, chainId: chain.chainId, account });
    },
    unwind: async () => null,
    // The gift is read from its own transaction's transfer log; who holds
    // the token at the end of the block is said apart, since the receiver
    // may already have passed it on.
    measure: async (receipt, at): Promise<LegOutcome[]> => {
      if (!review) return [];
      const label = format('give.legMoved', { id: loanId.toString() });
      if (!giftTransferred(receipt.logs, nft, account, review.receiver, review.tokenId)) return [{ status: 'not-done', label, reason: text('give.notMoved') }];
      const legs: LegOutcome[] = [{ status: 'done', label }];
      // A fact read after the gift, never a condition of it: a token the
      // receiver already passed on is said, and a read that fails adds
      // nothing, since the gift itself is settled by the log above.
      try {
        const holder = await at.read((c, b) => readLiveHolderOrNull(c, diamond, review.tokenId, b.blockNumber));
        if (holder !== null && holder.toLowerCase() !== review.receiver.toLowerCase()) legs.push({ status: 'done', label: format('give.heldAfterOther', { holder }) });
      } catch {
        /* the gift's outcome stands on its log */
      }
      return legs;
    },
    release: async () => null,
  });

  const mounted = useMounted();
  const load = async () => {
    try {
      const next = await readGiveReview(own, diamond, loanId, receiver, identity, copy);
      if (!mounted.current) return;
      setLoadError(null);
      setReview(next);
    } catch (e) {
      setLoadError(refusalFromError(e).reason);
    }
  };

  const onReview = tx.phase.kind === 'review' && review !== null && review.loanId === loanId;
  useReviewRefresh<GiveReview>({
    chainId: chain.chainId,
    active: onReview,
    review,
    read: (before) => readGiveReview(own, diamond, before.loanId, before.receiver, before.identity, copy),
    sameSubject: (a, b) => a.loanId === b.loanId && a.receiver === b.receiver,
    changed: (before, next) => giveChangedBetween(before, next, copy) !== null,
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
    if (review === null || review.loanId !== loanId || review.receiver !== receiver || review.identity !== identity) {
      setReview(null);
      let live = true;
      readGiveReview(own, diamond, loanId, receiver, identity, copy).then(
        (next) => {
          if (live) {
            setLoadError(null);
            setReview(next);
          }
        },
        (e: unknown) => {
          if (live) setLoadError(refusalFromError(e).reason);
        },
      );
      return () => {
        live = false;
      };
    }
    // Opened once per loan and receiver; the tracker and the stored review carry the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loanId, receiver]);

  const recheck = async (current: () => boolean): Promise<Recheck> => {
    if (!review) return { kind: 'unreadable', reason: text('flow.reading') };
    let next: GiveReview;
    try {
      next = await readGiveReview(own, diamond, loanId, review.receiver, review.identity, copy);
    } catch (e) {
      return { kind: 'unreadable', reason: refusalFromError(e).reason };
    }
    const what = giveChangedBetween(review, next, copy);
    if (current()) setReview(next);
    if (what !== null) return { kind: 'changed', what };
    if (next.dryRun.kind === 'refused') return { kind: 'refused', refusal: next.dryRun.refusal };
    const blockers = giveBlockers(next, account, copy);
    if (blockers.length > 0) return { kind: 'refused', refusal: { code: 'GiveStopped', reason: blockers[0]!, reopensAt: null, remedy: null } };
    return { kind: 'ok' };
  };

  const blockers = review ? giveBlockers(review, account, copy) : [];
  const gate = review
    ? {
        ready: blockers.length === 0,
        node: (
          <div className="repay-gate" data-testid="give-gate">
            {blockers.map((b) => (
              <Notice key={b} tone="danger" tier="A">
                {b}
              </Notice>
            ))}
          </div>
        ),
      }
    : undefined;

  const describeAsset = (a: Hex) => {
    const m = meta?.[a.toLowerCase()];
    return m && m.decimals !== null ? { symbol: m.symbol ?? a, decimals: m.decimals } : null;
  };

  const close = () => {
    setReview(null);
    setStep(null);
    reviewOpened.current = false;
    onClose();
  };

  return (
    <div className="repay-loan" data-testid="give-panel">
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
        receipt={review ? giveReceipt(review, meta, copy) : null}
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
