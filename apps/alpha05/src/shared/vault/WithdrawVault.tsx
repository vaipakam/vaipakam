import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Log } from 'viem';
import { useConfig } from 'wagmi';
import { sendWrite } from '../tx/send';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useCopy } from '../copy/useCopy';
import { refusalFromError, StatedRefusal } from '../eligibility/refusal';
import { WhyLink } from '../help/WhyLink';
import { ASSET_TYPE, MAX_1155_QUANTITY, parseQuantity, parseTokenId, quantityMoved, tokenMoved, type Standard } from '../nft/nft';
import { moved } from '../offers/acceptOutcome';
import { parseAmount } from '../post/postModel';
import { payoutOutcomes } from '../protection/payout';
import { payoutLegs } from '../protection/payoutCopy';
import { assetName, exactTokenAmount, tokenAmount, useTokenMeta, type TokenMetaMap } from '../reads/tokens';
import { useOwnRead } from '../reads/useOwnRead';
import { VaultDepositoryFacetABI } from '@vaipakam/contracts/abis';
import type { Abi } from 'viem';
import type { LegOutcome } from '../tx/outcome';
import { askThrough } from '../tx/simulate';
import { holdsFlow, useStoredValue, useTxEntry, useTxNote } from '../tx/txStore';
import { useMounted, useReviewRefresh } from '../tx/useReviewRefresh';
import { useTrackedTx } from '../tx/useTrackedTx';
import { ActionFlow, reviewIdentity, type Recheck } from '../ui/ActionFlow';
import { FormField } from '../ui/FormField';
import { Notice } from '../ui/Notice';
import { shortAddress } from '../ui/format';
import {
  readWithdrawReview,
  withdrawAmount,
  withdrawBlockers,
  withdrawCall,
  withdrawChanged,
  withdrawRequested,
  escapeRequested,
  type WithdrawDraft,
  type WithdrawReview,
  type WithdrawSubject,
} from './withdraw';
import { withdrawName, withdrawReceipt } from './withdrawReceipt';

type Hex = `0x${string}`;

/** The store key the withdrawal keeps its state under: one at a time. */
export const WITHDRAW_KEY = 'vault.withdraw';

/** The asset whose withdrawal is open (the form, or a draft under review
 *  or in flight), so the page keeps the panel on screen until it is closed. */
export function useWithdrawHeld(flowKey: string = WITHDRAW_KEY): { subject: WithdrawSubject | null; inFlight: boolean; open: (s: WithdrawSubject | null) => void } {
  const entry = useTxEntry(flowKey);
  const [subject, setSubject] = useStoredValue<WithdrawSubject>(`${flowKey}:subject`);
  return { subject, inFlight: holdsFlow(entry.phase), open: setSubject };
}

/** Whether a draft is for the subject the panel is open for (any token of
 *  a collection opened without one). */
export function draftFits(d: WithdrawDraft, s: WithdrawSubject): boolean {
  return d.standard === s.standard && d.asset.toLowerCase() === s.asset.toLowerCase() && (s.tokenId === null || d.tokenId === s.tokenId);
}

/** Whether two drafts name the same asset, token and amount. */
const sameDraft = (a: WithdrawDraft, b: WithdrawDraft) => draftFits(a, b) && a.amount === b.amount;

interface WithdrawProps {
  chain: SupportedChain;
  own: OwnStateClient;
  subject: WithdrawSubject;
  onClose: () => void;
  /** The store key this flow keeps its state under, so a second page that
   *  hosts the withdrawal (Rewards, for VPFI) never shares a draft with the
   *  Vault page's. */
  flowKey?: string;
}

/**
 * ACC-23 — withdraw what is free in my vault, back to this wallet. The
 * reader chooses the amount (an ERC-20 amount or an ERC-1155 quantity; an
 * ERC-721 is the one token), checked against the protocol's own figure for
 * what is free; the review states what leaves the vault, from which vault,
 * where it goes (this wallet at once, or the account's payout queue for its
 * delay) and every consequence. No approval is asked. The withdrawal is
 * sent only after the protocol's dry run passes, and the finish card states
 * what the protocol recorded and where the asset went, from the
 * transaction's own logs.
 */
export function WithdrawVault(props: WithdrawProps) {
  const flowKey = props.flowKey ?? WITHDRAW_KEY;
  const entry = useTxEntry(flowKey);
  const [draft, setDraft] = useStoredValue<WithdrawDraft>(`${flowKey}:draft`);
  const current = draft !== null && draftFits(draft, props.subject) ? draft : null;
  if (current === null && !holdsFlow(entry.phase)) return <WithdrawForm {...props} onChosen={setDraft} />;
  if (current === null) return null;
  return <WithdrawFlow {...props} draft={current} onChange={() => setDraft(null)} onClose={() => (setDraft(null), props.onClose())} />;
}

/** The form: the token when a collection was opened, then how much,
 *  checked as it is typed against what is free, read again each block. */
function WithdrawForm({ chain, own, subject, onClose, onChosen, flowKey = WITHDRAW_KEY }: WithdrawProps & { onChosen: (d: WithdrawDraft) => void }) {
  const { text, format } = useCopy();
  const [input, setInput] = useStoredValue<string>(`${flowKey}:amount`);
  const [idInput, setIdInput] = useStoredValue<string>(`${flowKey}:tokenId`);
  const [asked, setAsked] = useState(false);
  const typedId = idInput ?? '';
  const tokenId = subject.standard === 'erc20' ? 0n : subject.tokenId !== null ? subject.tokenId : parseTokenId(typedId);
  const idError = tokenId === null ? text('vaultDeposit.tokenIdInvalid') : null;
  const free = useFree(own, chain.diamondAddress, subject.standard, subject.asset, tokenId);
  const meta = useTokenMeta([subject.asset]).data;
  const m = meta?.[subject.asset.toLowerCase()];
  const decimals = m?.decimals ?? null;
  const symbol = m?.symbol ?? shortAddress(subject.asset);
  const typed = input ?? '';

  const freeText = (v: bigint) => (subject.standard === 'erc20' ? tokenAmount(v, subject.asset, meta, format) : v.toString());
  const amount = (() => {
    if (subject.standard === 'erc721') return { ok: true as const, value: 1n };
    if (subject.standard === 'erc1155') {
      const q = parseQuantity(typed);
      return q === null ? { ok: false as const, error: typed.trim() === '' ? 'empty' : 'invalid' } : { ok: true as const, value: q };
    }
    if (decimals === null) return null;
    return parseAmount(typed, decimals);
  })();
  const error = (() => {
    if (subject.standard === 'erc721') return null;
    if (subject.standard === 'erc20' && decimals === null) return text('vaultWithdraw.decimalsUnread');
    if (!amount) return null;
    if (!amount.ok) {
      if (amount.error === 'empty' || amount.error === 'zero') return text('vaultWithdraw.amountZero');
      if (subject.standard === 'erc1155') return format('vaultWithdraw.quantityInvalid', { max: MAX_1155_QUANTITY.toString() });
      if (amount.error === 'invalid') return text('request.errInvalid');
      return format('request.errDecimals', { symbol, decimals: String(decimals) });
    }
    if (typeof free === 'bigint' && amount.value > free) return format('vaultWithdraw.overFreeForm', { free: freeText(free) });
    return null;
  })();
  const ready = amount?.ok === true && error === null && tokenId !== null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setAsked(true);
    if (ready && amount?.ok && tokenId !== null) onChosen({ standard: subject.standard, asset: subject.asset, tokenId, amount: amount.value });
  };
  const close = () => {
    setInput(null);
    setIdInput(null);
    onClose();
  };

  return (
    <form className="partial-form" onSubmit={submit} noValidate data-testid="vault-withdraw-form">
      <h3>
        {subject.standard === 'erc20' || tokenId === null
          ? assetName(subject.asset, meta)
          : format('asset.nftToken', { asset: assetName(subject.asset, meta), id: tokenId.toString() })}
      </h3>
      {subject.standard !== 'erc20' && subject.tokenId === null && (
        <FormField label={text('vaultDeposit.tokenIdLabel')} hint={text('vaultWithdraw.tokenIdHint')} error={asked || typedId !== '' ? idError : null}>
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              inputMode="numeric"
              autoComplete="off"
              aria-describedby={describedBy}
              aria-invalid={invalid}
              value={typedId}
              onChange={(e) => setIdInput(e.target.value)}
              data-testid="vault-withdraw-token-id"
            />
          )}
        </FormField>
      )}
      {free !== undefined && free !== null && subject.standard !== 'erc20' && tokenId !== null && free === 0n && (
        <p className="tier-a" data-testid="vault-withdraw-none-free">
          {text('vaultWithdraw.nothingFree')}
        </p>
      )}
      {subject.standard === 'erc721' ? (
        <p className="tier-b">{text('vaultWithdraw.nftNote')}</p>
      ) : (
        <FormField
          label={subject.standard === 'erc20' ? format('vaultWithdraw.amountLabel', { symbol }) : text('vaultDeposit.quantityLabel')}
          hint={
            free === null || free === undefined
              ? undefined
              : format(subject.standard === 'erc20' ? 'vaultWithdraw.amountHint' : 'vaultWithdraw.quantityHint', { free: freeText(free) })
          }
          error={(subject.standard === 'erc20' && decimals === null) || asked || (typed !== '' && error !== text('vaultWithdraw.amountZero')) ? error : null}
        >
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              inputMode={subject.standard === 'erc20' ? 'decimal' : 'numeric'}
              autoComplete="off"
              aria-describedby={describedBy}
              aria-invalid={invalid}
              value={typed}
              disabled={subject.standard === 'erc20' && decimals === null}
              onChange={(e) => setInput(e.target.value)}
              data-testid="vault-withdraw-amount"
            />
          )}
        </FormField>
      )}
      <p className="tier-b">{text('vaultWithdraw.formNote')}</p>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" data-testid="vault-withdraw-review">
          {text('vaultWithdraw.review')}
        </button>
        <button type="button" className="btn" onClick={close} data-testid="vault-withdraw-cancel">
          {text('flow.cancel')}
        </button>
      </div>
    </form>
  );
}

/** The review and the transaction, for one draft. */
function WithdrawFlow({ chain, own, draft, onChange, onClose, flowKey = WITHDRAW_KEY }: WithdrawProps & { draft: WithdrawDraft; onChange: () => void }) {
  const copy = useCopy();
  const { text, format } = copy;
  const config = useConfig();
  const diamond = chain.diamondAddress;
  const account = own.account;
  const identity = reviewIdentity(own);
  const meta = useTokenMeta([draft.asset]).data;
  const [review, setReview] = useStoredValue<WithdrawReview>(`${flowKey}:review`);
  const [, setInput] = useStoredValue<string>(`${flowKey}:amount`);
  const [loadError, setLoadError] = useState<string | null>(null);
  const setStep = useTxNote(flowKey);

  const nft = draft.standard !== 'erc20';
  const exact = (v: bigint) => (nft ? v.toString() : exactTokenAmount(v, draft.asset, meta, format));
  const amountText = (v: bigint) => (nft ? v.toString() : tokenAmount(v, draft.asset, meta, format));
  const read = (d: WithdrawDraft, who: string) => readWithdrawReview(own, diamond, d, who, copy);

  const tx = useTrackedTx({
    key: flowKey,
    chainId: chain.chainId,
    account,
    sources: own.sources,
    send: async () => {
      if (!review) throw new Error('no withdrawal under review');
      const stop = (reason: string): never => {
        throw new StatedRefusal({ code: 'WithdrawStopped', reason, reopensAt: null, remedy: null });
      };
      // The dry run again, at send: the protocol's own verdict on this
      // withdrawal now, since what is free can move with any position.
      if (review.via === null) return stop(text('vaultWithdraw.routeUnread'));
      const call = withdrawCall(review.draft, account, review.via);
      const dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, ...call, account }));
      if (dry.kind === 'reverted') return stop(format('vaultWithdraw.dryRunRefused', { reason: refusalFromError(dry.error).reason }));
      if (dry.kind === 'unreadable') return stop(format('flow.unreadable', { reason: dry.reason }));
      setStep(format('accept.stepOf', { n: '1', total: '1', what: text('vaultWithdraw.stepSend') }));
      return sendWrite(config, { address: diamond, ...call, chainId: chain.chainId, account });
    },
    measure: async (receipt) => (review ? measure(review, receipt.logs) : []),
    release: async () => null,
  });

  /** What the protocol recorded and where the asset went, from the
   *  transaction's own logs. */
  const measure = (r: WithdrawReview, logs: readonly Log[]): LegOutcome[] => {
    const d = r.draft;
    const want = withdrawAmount(d);
    const legs: LegOutcome[] = [];
    const escaped = r.via === 'escape' ? escapeRequested(logs, diamond, account, d) : null;
    const asked = r.via === 'escape' ? (escaped === null ? null : { amount: escaped, queued: false }) : withdrawRequested(logs, diamond, account, d);
    const leftLabel = format('vaultWithdraw.legLeft', { what: nft ? withdrawName(d, meta, copy) : amountText(asked?.amount ?? want) });
    if (asked === null) legs.push({ status: 'not-done', label: leftLabel, reason: text('vaultWithdraw.notRequested') });
    else if (asked.amount !== want)
      legs.push({ status: 'not-done', label: leftLabel, reason: format('vaultWithdraw.requestedOther', { amount: exact(asked.amount), expected: exact(want) }) });
    else if (!asked.queued) legs.push({ status: 'done', label: leftLabel });
    if (asked === null) return legs;
    // What reached the wallet itself: the token's own transfer logs, from
    // the vault to this wallet.
    const vault = r.vault;
    const wallet =
      vault === null
        ? 0n
        : d.standard === 'erc721'
          ? tokenMoved(logs, d.asset, d.tokenId, vault, account)
            ? 1n
            : 0n
          : d.standard === 'erc1155'
            ? quantityMoved(logs, d.asset, d.tokenId, vault, account)
            : moved(logs, d.asset, vault, account);
    legs.push(
      ...payoutLegs(
        {
          outcomes: payoutOutcomes(logs, diamond, account, d.asset, nft ? d.tokenId : undefined),
          wallet,
          expected: want,
          protection: r.protection,
          what: (v) => (nft ? withdrawName({ ...d, amount: v }, meta, copy) : amountText(v)),
          exact,
          walletLeg: (what) => format('vaultWithdraw.legReceived', { what }),
          walletOther: (got, expected) => format('vaultWithdraw.receivedOther', { amount: got, expected }),
        },
        copy,
      ),
    );
    return legs;
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
  useReviewRefresh<WithdrawReview>({
    chainId: chain.chainId,
    active: onReview,
    review,
    read: (before) => read(before.draft, before.identity),
    sameSubject: (a, b) => sameDraft(a.draft, b.draft),
    changed: (before, next) => withdrawChanged(before, next, copy) !== null,
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
    let next: WithdrawReview;
    try {
      next = await read(review.draft, review.identity);
    } catch (e) {
      return { kind: 'unreadable', reason: refusalFromError(e).reason };
    }
    const what = withdrawChanged(review, next, copy);
    if (current()) setReview(next);
    if (what !== null) return { kind: 'changed', what };
    const blockers = withdrawBlockers(next, copy, amountText);
    if (blockers.length > 0)
      return {
        kind: 'refused',
        refusal: { code: next.dryRun !== null && next.dryRun !== 'unread' ? next.dryRun.code : 'WithdrawBlocked', reason: blockers[0]!, reopensAt: null, remedy: null },
      };
    return { kind: 'ok' };
  };

  const change = () => {
    tx.reset();
    setReview(null);
    setStep(null);
    onChange();
  };

  const blockers = review ? withdrawBlockers(review, copy, amountText) : [];
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
            <WhyLink summaryKey="vaultWithdraw.whySummary" detailKey="vaultWithdraw.why" />
            <button type="button" className="btn btn-link" onClick={change} data-testid="vault-withdraw-change">
              {text('vaultWithdraw.change')}
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
    setStep(null);
    reviewOpened.current = false;
    onClose();
  };

  return (
    <div className="repay-loan" data-testid="vault-withdraw-panel">
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
        receipt={review ? withdrawReceipt(review, meta, copy) : null}
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

/** What the protocol lets this wallet withdraw of one token now, read again
 *  each block, so the form's limit never goes stale: undefined while reading
 *  (or before a token id is typed), null when unread. */
function useFree(own: OwnStateClient, diamond: Hex, standard: Standard, asset: Hex, tokenId: bigint | null): bigint | null | undefined {
  const read = useOwnRead(
    ['vault', 'withdrawable', diamond, standard, asset, tokenId?.toString() ?? ''],
    (c) =>
      c.readContract({
        address: diamond,
        abi: VaultDepositoryFacetABI as Abi,
        functionName: 'withdrawableNow',
        args: [own.account, ASSET_TYPE[standard], asset, tokenId ?? 0n],
      }) as Promise<bigint>,
    { enabled: tokenId !== null, perBlock: true },
  );
  if (tokenId === null || read.state === 'reading' || read.state === 'no-identity') return undefined;
  return read.state === 'failed' ? null : read.data;
}
