import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { Log } from 'viem';
import { useConfig } from 'wagmi';
import { signTypedDataFor } from '../tx/walletGuard';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useCopy } from '../copy/useCopy';
import { refusalFromError, StatedRefusal } from '../eligibility/refusal';
import { WhyLink } from '../help/WhyLink';
import { MAX_1155_QUANTITY, parseQuantity } from '../nft/nft';
import { parsePasted } from '../offers/assets';
import { parseAmount } from '../post/postModel';
import { answerOrNull } from '../reads/answer';
import { exactTokenAmount, tokenAmount, useTokenMeta, type TokenMetaMap } from '../reads/tokens';
import { chainValidUntil } from '../tx/deadline';
import type { LegOutcome } from '../tx/outcome';
import { sendWrite } from '../tx/send';
import { askThrough } from '../tx/simulate';
import { holdsFlow, useStoredValue, useTxEntry, useTxNote } from '../tx/txStore';
import { useMounted, useReviewRefresh } from '../tx/useReviewRefresh';
import { useTrackedTx } from '../tx/useTrackedTx';
import { ActionFlow, reviewIdentity, type Recheck } from '../ui/ActionFlow';
import { FormField } from '../ui/FormField';
import { Notice } from '../ui/Notice';
import { shortAddress } from '../ui/format';
import { VaultDepositoryFacetABI } from '@vaipakam/contracts/abis';
import type { Abi } from 'viem';
import {
  ADOPTION_ACK_TEXT,
  ADOPTION_TYPES,
  CONFIRM_WORD,
  adoptAmount,
  adoptBlockers,
  adoptCall,
  adoptChanged,
  adoptionDomain,
  adoptionMessage,
  adoptRecorded,
  readAdoptReview,
  readSourceScreen,
  sourceScreenStop,
  type AdoptDraft,
  type AdoptReview,
  type RecoverFacts,
  type RecoverSubject,
} from './adopt';
import { adoptReceipt, recoverName } from './recoverReceipt';

type Hex = `0x${string}`;

/** The store key an adoption keeps its state under: one at a time. */
export const ADOPT_KEY = 'recover.adopt';

const same = (a: RecoverSubject, b: RecoverSubject) => a.standard === b.standard && a.asset.toLowerCase() === b.asset.toLowerCase() && a.tokenId === b.tokenId;
const sameDraft = (a: AdoptDraft, b: AdoptDraft) => same(a.subject, b.subject) && a.amount === b.amount && a.source.toLowerCase() === b.source.toLowerCase();

/** Whether an adoption is open or in flight, so the page keeps its panel. */
export function useAdoptHeld(): { subject: RecoverSubject | null; inFlight: boolean; open: (s: RecoverSubject | null) => void } {
  const entry = useTxEntry(ADOPT_KEY);
  const [subject, setSubject] = useStoredValue<RecoverSubject>(`${ADOPT_KEY}:subject`);
  return { subject, inFlight: holdsFlow(entry.phase), open: setSubject };
}

interface AdoptProps {
  chain: SupportedChain;
  own: OwnStateClient;
  /** The page's latest read for this asset: the form's limit. */
  facts: RecoverFacts;
  onClose: () => void;
}

/**
 * ACC-25, NFT-33 — adopt what sits uncounted in my vault. The reader names
 * how much (one for an ERC-721) and the address it came from; the review
 * states what is counted, in which vault, the declared source and every
 * consequence, and shows the declaration word for word with the word to
 * type. At send the wallet signs the declaration, the protocol's dry run
 * checks the signed call, and only then is it sent. The finish card says
 * what the transaction's record shows: counted, or the vault barred by a
 * flagged source, or neither.
 */
export function AdoptAsset(props: AdoptProps) {
  const entry = useTxEntry(ADOPT_KEY);
  const [draft, setDraft] = useStoredValue<AdoptDraft>(`${ADOPT_KEY}:draft`);
  const current = draft !== null && same(draft.subject, props.facts.subject) ? draft : null;
  if (current === null && !holdsFlow(entry.phase)) return <AdoptForm {...props} onChosen={setDraft} />;
  if (current === null) return null;
  return <AdoptFlow {...props} draft={current} onChange={() => setDraft(null)} onClose={() => (setDraft(null), props.onClose())} />;
}

function AdoptForm({ facts, onClose, onChosen }: AdoptProps & { onChosen: (d: AdoptDraft) => void }) {
  const { text, format } = useCopy();
  const s = facts.subject;
  const [input, setInput] = useStoredValue<string>(`${ADOPT_KEY}:amount`);
  const [sourceInput, setSourceInput] = useStoredValue<string>(`${ADOPT_KEY}:source`);
  const [asked, setAsked] = useState(false);
  const meta = useTokenMeta([s.asset]).data;
  const m = meta?.[s.asset.toLowerCase()];
  const decimals = m?.decimals ?? null;
  const symbol = m?.symbol ?? shortAddress(s.asset);
  const typed = input ?? '';
  const typedSource = sourceInput ?? '';
  const source = parsePasted(typedSource);
  const untracked = facts.untracked;
  const untrackedText = (v: bigint) => (s.standard === 'erc20' ? tokenAmount(v, s.asset, meta, format) : v.toString());

  const amount = (() => {
    if (s.standard === 'erc721') return { ok: true as const, value: 1n };
    if (s.standard === 'erc1155') {
      const q = parseQuantity(typed);
      return q === null ? { ok: false as const, error: typed.trim() === '' ? 'empty' : 'invalid' } : { ok: true as const, value: q };
    }
    if (decimals === null) return null;
    return parseAmount(typed, decimals);
  })();
  const amountError = (() => {
    if (s.standard === 'erc721') return null;
    if (s.standard === 'erc20' && decimals === null) return text('vaultWithdraw.decimalsUnread');
    if (!amount) return null;
    if (!amount.ok) {
      if (amount.error === 'empty' || amount.error === 'zero') return text('vaultWithdraw.amountZero');
      if (s.standard === 'erc1155') return format('vaultWithdraw.quantityInvalid', { max: MAX_1155_QUANTITY.toString() });
      if (amount.error === 'invalid') return text('request.errInvalid');
      return format('request.errDecimals', { symbol, decimals: String(decimals) });
    }
    if (untracked !== null && amount.value > untracked) return format('recover.overUntracked', { untracked: untrackedText(untracked) });
    return null;
  })();
  const sourceError = source === null ? text(typedSource.trim() === '' ? 'recover.sourceEmpty' : 'recover.sourceInvalid') : null;
  const ready = amount?.ok === true && amountError === null && source !== null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setAsked(true);
    if (ready && amount?.ok && source !== null) onChosen({ subject: s, amount: amount.value, source });
  };
  const close = () => {
    setInput(null);
    setSourceInput(null);
    onClose();
  };

  return (
    <form className="partial-form" onSubmit={submit} noValidate data-testid="recover-adopt-form">
      <h3>{text('recover.adoptFormTitle')}</h3>
      {s.standard === 'erc721' ? (
        <p className="tier-b">{text('recover.nftWhole')}</p>
      ) : (
        <FormField
          label={s.standard === 'erc20' ? format('vaultWithdraw.amountLabel', { symbol }) : text('vaultDeposit.quantityLabel')}
          hint={untracked === null ? undefined : format('recover.amountHint', { untracked: untrackedText(untracked) })}
          error={
            (s.standard === 'erc20' && decimals === null) || asked || (typed !== '' && amountError !== text('vaultWithdraw.amountZero')) ? amountError : null
          }
        >
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              inputMode={s.standard === 'erc20' ? 'decimal' : 'numeric'}
              autoComplete="off"
              aria-describedby={describedBy}
              aria-invalid={invalid}
              value={typed}
              disabled={s.standard === 'erc20' && decimals === null}
              onChange={(e) => setInput(e.target.value)}
              data-testid="recover-adopt-amount"
            />
          )}
        </FormField>
      )}
      <FormField
        label={text('recover.sourceLabel')}
        hint={text('recover.sourceHint')}
        error={asked || (typedSource !== '' && source === null) ? sourceError : null}
      >
        {({ id, describedBy, invalid }) => (
          <input
            id={id}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            value={typedSource}
            onChange={(e) => setSourceInput(e.target.value)}
            data-testid="recover-adopt-source"
          />
        )}
      </FormField>
      <p className="tier-a">{text('recover.sourceWarning')}</p>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" data-testid="recover-adopt-review">
          {text('recover.adoptReview')}
        </button>
        <button type="button" className="btn" onClick={close} data-testid="recover-adopt-cancel">
          {text('flow.cancel')}
        </button>
      </div>
    </form>
  );
}

function AdoptFlow({ chain, own, draft, onChange, onClose }: AdoptProps & { draft: AdoptDraft; onChange: () => void }) {
  const copy = useCopy();
  const { text, format } = copy;
  const config = useConfig();
  const diamond = chain.diamondAddress;
  const account = own.account;
  const identity = reviewIdentity(own);
  const meta = useTokenMeta([draft.subject.asset]).data;
  const [review, setReview] = useStoredValue<AdoptReview>(`${ADOPT_KEY}:review`);
  const [, setInput] = useStoredValue<string>(`${ADOPT_KEY}:amount`);
  const [, setSourceInput] = useStoredValue<string>(`${ADOPT_KEY}:source`);
  const [typedConfirm, setTypedConfirm] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const setStep = useTxNote(ADOPT_KEY);
  const confirmId = useId();

  const nft = draft.subject.standard !== 'erc20';
  const exact = (v: bigint) => (nft ? v.toString() : exactTokenAmount(v, draft.subject.asset, meta, format));
  const amountText = (v: bigint) => (nft ? v.toString() : tokenAmount(v, draft.subject.asset, meta, format));
  const read = (d: AdoptDraft, who: string) => readAdoptReview(own, diamond, d, who);

  const tx = useTrackedTx({
    key: ADOPT_KEY,
    chainId: chain.chainId,
    account,
    sources: own.sources,
    send: async () => {
      if (!review) throw new Error('no adoption under review');
      const d = review.draft;
      const stop = (reason: string): never => {
        throw new StatedRefusal({ code: 'AdoptStopped', reason, reopensAt: null, remedy: null });
      };
      // The protocol credits nothing and bars the vault when the declared
      // source is flagged as it confirms, and it does that without
      // reverting, so a dry run passes for a flagged source. The app
      // therefore asks the screen itself, here and again after the
      // signature, and sends only while it reads clean.
      const screened = async (): Promise<void> => {
        const screen = await own.read((c) => readSourceScreen(c, diamond, d.source)).then((x) => x.value);
        const why = sourceScreenStop(screen, copy);
        if (why !== null) stop(format('recover.rescreenStopped', { reason: why }));
      };
      // The nonce and the deadline are read right before signing, from the
      // chain, so a review left open never signs a used nonce or a lapsed
      // deadline.
      const { nonce, deadline } = await own
        .read(async (c) => ({
          nonce: await answerOrNull(
            c.readContract({ address: diamond, abi: VaultDepositoryFacetABI as Abi, functionName: 'adoptionNonce', args: [account] }) as Promise<bigint>,
          ),
          deadline: await chainValidUntil(c),
        }))
        .then((x) => x.value);
      if (nonce === null) return stop(text('recover.nonceUnread'));
      await screened();
      setStep(format('accept.stepOf', { n: '1', total: '2', what: text('recover.stepSign') }));
      const signature = await signTypedDataFor(config, chain.chainId, {
        account,
        domain: adoptionDomain(chain.chainId, diamond),
        types: ADOPTION_TYPES,
        primaryType: 'AdoptionAcknowledgment',
        message: adoptionMessage(account, d, nonce, deadline),
      });
      // The protocol's dry run with the real signature: its own verdict on
      // everything else about this adoption now.
      const call = adoptCall(d, deadline, signature);
      const dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, ...call, account }));
      if (dry.kind === 'reverted') return stop(format('recover.dryRunRefused', { reason: refusalFromError(dry.error).reason }));
      if (dry.kind === 'unreadable') return stop(format('flow.unreadable', { reason: dry.reason }));
      // The last read before the send: the screen may have flagged the
      // source while the wallet was signing.
      await screened();
      setStep(format('accept.stepOf', { n: '2', total: '2', what: text('recover.stepSend') }));
      return sendWrite(config, { address: diamond, ...call, chainId: chain.chainId, account });
    },
    measure: async (receipt) => (review ? measure(review, receipt.logs) : []),
    release: async () => null,
  });

  /** What the transaction's record shows the adoption did. */
  const measure = (r: AdoptReview, logs: readonly Log[]): LegOutcome[] => {
    const d = r.draft;
    const want = adoptAmount(d);
    const what = (v: bigint) => (nft ? recoverName(d.subject, v, meta, copy) : amountText(v));
    const label = format('recover.legCounted', { what: what(want) });
    const rec = adoptRecorded(logs, diamond, account, d.subject);
    if (rec.kind === 'barred') return [{ status: 'not-done', label, reason: format('recover.legBarred', { source: rec.source }) }];
    if (rec.kind === 'none') return [{ status: 'not-done', label, reason: text('recover.legNone') }];
    if (rec.amount !== want) return [{ status: 'not-done', label, reason: format('recover.legOther', { amount: exact(rec.amount), expected: exact(want) }) }];
    return [{ status: 'done', label }];
  };

  const mounted = useMounted();
  const load = async () => {
    try {
      const next = await read(draft, identity);
      if (!mounted.current) return;
      setLoadError(null);
      setReview(next);
    } catch (e) {
      setLoadError(refusalFromError(e).reason);
    }
  };

  // RB-RAILS: read again each block while the review is on screen.
  const onReview = tx.phase.kind === 'review' && review !== null && sameDraft(review.draft, draft);
  useReviewRefresh<AdoptReview>({
    chainId: chain.chainId,
    active: onReview,
    review,
    read: (before) => read(before.draft, before.identity),
    sameSubject: (a, b) => sameDraft(a.draft, b.draft),
    changed: (before, next) => adoptChanged(before, next, copy) !== null,
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
    if (review === null || !sameDraft(review.draft, draft) || review.identity !== identity) {
      setReview(null);
      let live = true;
      read(draft, identity).then(
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
    // Opened once per draft; the tracker and the stored review carry the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const recheck = async (current: () => boolean): Promise<Recheck> => {
    if (!review) return { kind: 'unreadable', reason: text('flow.reading') };
    let next: AdoptReview;
    try {
      next = await read(review.draft, review.identity);
    } catch (e) {
      return { kind: 'unreadable', reason: refusalFromError(e).reason };
    }
    const what = adoptChanged(review, next, copy);
    if (current()) setReview(next);
    if (what !== null) return { kind: 'changed', what };
    const blockers = adoptBlockers(next, copy, amountText);
    if (blockers.length > 0) return { kind: 'refused', refusal: { code: 'AdoptBlocked', reason: blockers[0]!, reopensAt: null, remedy: null } };
    return { kind: 'ok' };
  };

  const change = () => {
    tx.reset();
    setReview(null);
    setStep(null);
    setTypedConfirm('');
    onChange();
  };

  const blockers = review ? adoptBlockers(review, copy, amountText) : [];
  const confirmed = typedConfirm.trim() === CONFIRM_WORD;
  const gate = review
    ? {
        ready: blockers.length === 0 && confirmed,
        node: (
          <div className="repay-gate">
            {blockers.map((b) => (
              <Notice key={b} tone="danger" tier="A">
                {b}
              </Notice>
            ))}
            {blockers.length === 0 && (
              <>
                <p className="tier-b">{text('recover.ackLead')}</p>
                <blockquote className="recover-ack" data-testid="recover-ack-text">
                  {ADOPTION_ACK_TEXT}
                </blockquote>
                <label htmlFor={confirmId} className="tier-a">
                  {format('recover.confirmLabel', { word: CONFIRM_WORD })}
                </label>
                <input
                  id={confirmId}
                  autoComplete="off"
                  spellCheck={false}
                  value={typedConfirm}
                  onChange={(e) => setTypedConfirm(e.target.value)}
                  data-testid="recover-adopt-confirm"
                />
              </>
            )}
            <WhyLink summaryKey="recover.whyAdoptSummary" detailKey="recover.whyAdopt" />
            <button type="button" className="btn btn-link" onClick={change} data-testid="recover-adopt-change">
              {text('recover.adoptChange')}
            </button>
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
    setInput(null);
    setSourceInput(null);
    setStep(null);
    setTypedConfirm('');
    reviewOpened.current = false;
    onClose();
  };

  return (
    <div className="repay-loan" data-testid="recover-adopt-panel">
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
        receipt={review ? adoptReceipt(review, meta, copy) : null}
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
