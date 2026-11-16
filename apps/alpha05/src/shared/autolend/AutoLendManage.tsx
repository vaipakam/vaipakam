import type { CopyKey } from '../copy/useCopy';
import { useEffect, useRef, useState } from 'react';
import { useConfig } from 'wagmi';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useCopy } from '../copy/useCopy';
import { refusalFromError, StatedRefusal } from '../eligibility/refusal';
import { legVerdict, moved } from '../offers/acceptOutcome';
import { readVault } from '../offers/reads';
import { parseAmount } from '../post/postModel';
import { payoutOutcomes } from '../protection/payout';
import { payoutLegs } from '../protection/payoutCopy';
import { exactTokenAmount, tokenAmount, type TokenMetaMap } from '../reads/tokens';
import { allowanceSteps } from '../tx/approval';
import { allowanceMoved, approvalFlow } from '../tx/approvalFlow';
import { cleanUpLeg } from '../tx/cleanUp';
import type { LegOutcome } from '../tx/outcome';
import { sendWrite } from '../tx/send';
import { askThrough } from '../tx/simulate';
import { holdsFlow, useStoredValue, useTxEntry, useTxNote } from '../tx/txStore';
import { useMounted, useReviewRefresh } from '../tx/useReviewRefresh';
import { useTrackedTx } from '../tx/useTrackedTx';
import { ActionFlow, reviewIdentity, type Recheck } from '../ui/ActionFlow';
import { FormField } from '../ui/FormField';
import { Notice } from '../ui/Notice';
import { WhyLink } from '../help/WhyLink';
import { manageCall, manageLogs, type ManageDraft, type ManageKind } from './manage';
import { manageBlockers, manageKey, manageReceipt, manageRouteChanged, readManageReview, type ManageReview } from './manageReview';

type Hex = `0x${string}`;

/** The store key one pair's management lives under (the typed amount, the
 *  draft, the review and its tracker), so it outlives the page. */
export function manageKeyFor(lending: Hex, collateral: Hex): string {
  return `autolend.manage.${lending.toLowerCase()}.${collateral.toLowerCase()}`;
}

/** Which step a pair's panel is open on, or null; held while a step is in
 *  flight, so a refreshed list keeps the panel on screen. */
export function useManageOpen(lending: Hex, collateral: Hex): { kind: ManageKind | null; held: boolean; open: (k: ManageKind | null) => void } {
  const key = manageKeyFor(lending, collateral);
  const entry = useTxEntry(key);
  const [kind, setKind] = useStoredValue<ManageKind>(`${key}:kind`);
  return { kind, held: kind !== null || holdsFlow(entry.phase), open: setKind };
}

interface AutoLendManageProps {
  kind: ManageKind;
  lending: Hex;
  collateral: Hex;
  /** Set aside and not lent, as the list read it: the default a stop takes
   *  back, and the figure a take-back is checked against before the review
   *  reads it again. */
  unlent: bigint;
  chain: SupportedChain;
  own: OwnStateClient;
  meta: TokenMetaMap | null;
  onClose: () => void;
}

const LABEL: Record<ManageKind, CopyKey> = { add: 'autoLend.mAddLabel', takeBack: 'autoLend.mTakeBackLabel', stop: 'autoLend.mStopLabel' };

/**
 * #3624 part 2 — one management step on one Auto-lend: add money, take back
 * money that is not lent, or stop it (taking the money not lent back in the
 * same transaction, unless the reader keeps it set aside). The amount is
 * parsed exactly; the review is the protocol's own dry run from this wallet
 * with every figure it binds, where taken-back money goes under protected
 * mode, and what stays lent. Adding asks the wallet to approve exactly the
 * amount, and puts the approval back if the step does not go through. The
 * outcome is measured from the transaction's own logs.
 */
export function AutoLendManage({ kind, lending, collateral, unlent, chain, own, meta, onClose }: AutoLendManageProps) {
  const copy = useCopy();
  const { text, format } = copy;
  const config = useConfig();
  const diamond = chain.diamondAddress;
  const account = own.account;
  const identity = reviewIdentity(own);
  const key = manageKeyFor(lending, collateral);
  const [typed, setTyped] = useStoredValue<string>(`${key}:amount`);
  const [keepSetAside, setKeepSetAside] = useStoredValue<boolean>(`${key}:keep`);
  const [draft, setDraft] = useStoredValue<ManageDraft>(`${key}:draft`);
  const [review, setReview] = useStoredValue<ManageReview>(`${key}:review`);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);
  const setStep = useTxNote(key);
  /** The approval this flow made and has not yet seen used or put back. */
  const approvalLeft = useRef<{ prior: bigint; amount: bigint; since: bigint | null } | null>(null);

  const decimals = meta?.[lending.toLowerCase()]?.decimals ?? null;
  const exact = (asset: Hex, v: bigint) => exactTokenAmount(v, asset, meta, format);
  const amt = (v: bigint) => tokenAmount(v, lending, meta, format);
  const { readAllowance, allowanceIo, approveExactly, putBack } = approvalFlow({ own, config, chainId: chain.chainId, diamond, copy, exactAmount: exact, setStep });

  const tx = useTrackedTx({
    key,
    chainId: chain.chainId,
    account,
    sources: own.sources,
    send: async () => {
      if (!review) throw new Error('no step under review');
      const d = review.draft;
      const call = manageCall(d, account);
      approvalLeft.current = null;
      let putItBack: (() => Promise<{ sentence: string }>) | null = null;
      let n = 0;
      const total = review.approvalSteps + 1;
      const say = (what: string) => setStep(format('accept.stepOf', { n: String(++n), total: String(total), what }));
      if (d.kind === 'add') {
        // The approval, when needed: exactly the amount added, read again
        // first, so a change since the review stops before any prompt.
        const io = allowanceIo(lending, (a, i, of) => say(of === 2 && i === 0 ? text('approval.stepZero') : format('approval.step', { amount: exact(lending, a) })));
        const prior = await readAllowance(lending);
        const steps = prior < d.amount ? await allowanceSteps(io, prior, d.amount) : [];
        if (steps.length !== review.approvalSteps) throw allowanceMoved(copy);
        if (steps.length > 0) {
          const since = await approveExactly(io, lending, d.amount, prior);
          approvalLeft.current = { prior, amount: d.amount, since };
          putItBack = () => putBack(lending, prior, d.amount, since);
        }
      }
      const stop = async (reason: string): Promise<never> => {
        if (putItBack === null) throw new StatedRefusal({ code: 'ManageStopped', reason, reopensAt: null, remedy: null });
        approvalLeft.current = null;
        const after = await putItBack();
        throw new StatedRefusal({ code: 'ManageStopped', reason: `${reason} ${after.sentence}`, reopensAt: null, remedy: null });
      };
      let dry: Awaited<ReturnType<typeof askThrough>>;
      try {
        dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, ...call, account }));
      } catch (e) {
        return stop(format('flow.unreadable', { reason: refusalFromError(e).reason }));
      }
      if (dry.kind === 'reverted') return stop(format('autoLend.mDryRunRefused', { reason: refusalFromError(dry.error).reason }));
      if (dry.kind === 'unreadable') return stop(format('flow.unreadable', { reason: dry.reason }));
      say(text(d.kind === 'add' ? 'autoLend.mStepAdd' : d.kind === 'takeBack' ? 'autoLend.mStepTakeBack' : 'autoLend.mStepStop'));
      try {
        return await sendWrite(config, { address: diamond, ...call, chainId: chain.chainId, account });
      } catch (e) {
        return stop(format('autoLend.stoppedAfterApproval', { reason: refusalFromError(e).reason }));
      }
    },
    unwind: async () => {
      const left = approvalLeft.current;
      approvalLeft.current = null;
      if (!left) return null;
      const after = await putBack(lending, left.prior, left.amount, left.since);
      return cleanUpLeg(after, format('approval.legBack', { amount: exact(lending, left.prior) }));
    },
    measure: async (receipt, at) => {
      if (!review) return [];
      approvalLeft.current = null;
      const d = review.draft;
      const logs = manageLogs(receipt.logs, diamond, account, lending, collateral);
      const legs: LegOutcome[] = [];
      let vault: Hex | null = null;
      try {
        vault = await at.read((c, b) => readVault(c, diamond, account, b));
      } catch {
        vault = null;
      }
      if (d.kind === 'stop') {
        legs.push(
          logs.stopped
            ? { status: 'done', label: text('autoLend.mLegStopped') }
            : { status: 'not-done', label: text('autoLend.mLegStopped'), reason: text('autoLend.mNotStopped') },
        );
      }
      if (d.kind === 'add') {
        const label = format('autoLend.legFunded', { amount: amt(d.amount) });
        // What moved into the vault, from the token's own Transfer logs, and
        // what the protocol recorded as set aside, must both be the amount.
        const into = vault === null ? null : moved(receipt.logs, lending, account, vault);
        if (into === null) legs.push({ status: 'unknown', label, reason: text('accept.vaultUnknown') });
        else {
          const lv = legVerdict(logs.funded === into ? into : 0n, d.amount);
          legs.push(
            lv === 'done'
              ? { status: 'done', label }
              : { status: lv, label, reason: format('autoLend.fundedOther', { amount: exact(lending, into), expected: exact(lending, d.amount) }) },
          );
        }
      } else if (d.amount > 0n) {
        const released = logs.withdrawn ?? 0n;
        if (released !== d.amount) {
          legs.push({
            status: released === 0n ? 'not-done' : 'unknown',
            label: format('autoLend.mLegReleased', { amount: amt(d.amount) }),
            reason: format('autoLend.mReleasedOther', { amount: exact(lending, released), expected: exact(lending, d.amount) }),
          });
        }
        const wallet = vault === null ? 0n : moved(receipt.logs, lending, vault, account);
        legs.push(
          ...payoutLegs(
            {
              outcomes: payoutOutcomes(receipt.logs, diamond, account, lending),
              wallet,
              expected: d.amount,
              protection: review.facts.protection,
              what: amt,
              exact: (v) => exact(lending, v),
              walletLeg: (what) => format('autoLend.mLegReceived', { what }),
              walletOther: (got, expected) => format('autoLend.mReceivedOther', { amount: got, expected }),
            },
            copy,
          ),
        );
      }
      return legs;
    },
  });

  const mounted = useMounted();
  const read = (d: ManageDraft, who: string) => readManageReview(own, diamond, d, who);
  const load = async () => {
    if (!draft) return;
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
  const onReview = tx.phase.kind === 'review' && review !== null && draft !== null && review.draft === draft;
  useReviewRefresh<ManageReview>({
    chainId: chain.chainId,
    active: onReview,
    review,
    read: (before) => read(before.draft, before.identity),
    sameSubject: (a, b) => a.draft === b.draft,
    changed: (before, next) => manageKey(before) !== manageKey(next) || manageRouteChanged(before, next),
    setReview,
    onChanged: () => undefined,
  });

  // Open the review once a draft is confirmed.
  const opened = useRef<ManageDraft | null>(null);
  useEffect(() => {
    if (draft === null) return;
    const open = tx.phase.kind === 'idle' || tx.phase.kind === 'review';
    if (!open) return;
    if (tx.phase.kind === 'idle' && opened.current !== draft) {
      opened.current = draft;
      tx.review();
    }
    if (review === null || review.draft !== draft || review.identity !== identity) {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const recheck = async (current: () => boolean): Promise<Recheck> => {
    if (!review) return { kind: 'unreadable', reason: text('flow.reading') };
    let next: ManageReview;
    try {
      next = await read(review.draft, review.identity);
    } catch (e) {
      return { kind: 'unreadable', reason: refusalFromError(e).reason };
    }
    if (manageKey(review) !== manageKey(next) || manageRouteChanged(review, next)) {
      if (current()) setReview(next);
      return { kind: 'changed', what: text('autoLend.changed') };
    }
    const b = manageBlockers(next, meta, copy);
    if (b.length > 0) return { kind: 'refused', refusal: { code: 'ManageBlocked', reason: b[0]!, reopensAt: null, remedy: null } };
    return { kind: 'ok' };
  };

  const clear = () => {
    setReview(null);
    setDraft(null);
    setStep(null);
    opened.current = null;
  };
  const close = () => {
    clear();
    setTyped(null);
    setKeepSetAside(null);
    onClose();
  };
  const back = () => {
    tx.reset();
    clear();
  };

  // The amount: typed for adding or taking back; for a stop, all the money
  // not lent, unless the reader keeps it set aside.
  const parsed = kind === 'stop' || decimals === null ? null : parseAmount(typed ?? '', decimals);
  const amountError =
    parsed === null || parsed.ok || !asked
      ? null
      : parsed.error === 'decimals'
        ? format('autoLend.errDecimals', { symbol: meta?.[lending.toLowerCase()]?.symbol ?? '', decimals: String(decimals ?? 0) })
        : text(parsed.error === 'empty' ? 'autoLend.errEmpty' : parsed.error === 'zero' ? 'autoLend.errZero' : 'autoLend.errInvalid');
  const confirm = () => {
    setAsked(true);
    if (kind === 'stop') {
      setDraft({ kind, lending, collateral, amount: keepSetAside === true ? 0n : unlent });
      return;
    }
    if (parsed === null || !parsed.ok) return;
    setDraft({ kind, lending, collateral, amount: parsed.value });
  };

  if (draft === null) {
    return (
      <form
        className="offer-form autolend-manage"
        data-testid={`autolend-manage-${kind}`}
        onSubmit={(e) => {
          e.preventDefault();
          confirm();
        }}
      >
        <h4>{text(LABEL[kind])}</h4>
        {kind === 'stop' ? (
          <>
            <p className="tier-b">{text('autoLend.mStopLead')}</p>
            {unlent > 0n && (
              <div className="field field-check">
                <label>
                  <input type="checkbox" checked={keepSetAside !== true} onChange={(e) => setKeepSetAside(!e.target.checked)} data-testid="autolend-stop-takeback" />
                  <span>{format('autoLend.mStopTakeBack', { amount: amt(unlent) })}</span>
                </label>
              </div>
            )}
          </>
        ) : (
          <FormField
            label={format(kind === 'add' ? 'autoLend.mAddAmountLabel' : 'autoLend.mTakeBackAmountLabel', { symbol: meta?.[lending.toLowerCase()]?.symbol ?? '' })}
            hint={kind === 'takeBack' ? format('autoLend.mTakeBackHint', { amount: amt(unlent) }) : text('autoLend.mAddHint')}
            error={amountError}
          >
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                inputMode="decimal"
                autoComplete="off"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                value={typed ?? ''}
                onChange={(e) => setTyped(e.target.value)}
                onBlur={() => setAsked(true)}
                data-testid="autolend-manage-amount"
              />
            )}
          </FormField>
        )}
        <p className="actions">
          <button type="submit" className="btn btn-primary" disabled={kind !== 'stop' && decimals === null} data-testid="autolend-manage-review">
            {text('autoLend.review')}
          </button>
          <button type="button" className="btn" onClick={close}>
            {text('autoLend.cancel')}
          </button>
        </p>
      </form>
    );
  }

  const blockers = review ? manageBlockers(review, meta, copy) : [];
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
            <WhyLink summaryKey="autoLend.mWhySummary" detailKey="autoLend.mWhy" />
            {tx.phase.kind === 'review' && (
              <p>
                <button type="button" className="btn btn-link" onClick={back} data-testid="autolend-manage-edit">
                  {text('autoLend.edit')}
                </button>
              </p>
            )}
          </div>
        ),
      }
    : undefined;

  const describeAsset = (a: Hex) => {
    const m = meta?.[a.toLowerCase()];
    return m && m.decimals !== null ? { symbol: m.symbol ?? a, decimals: m.decimals } : null;
  };

  return (
    <div className="repay-loan autolend-manage" data-testid={`autolend-manage-${kind}`}>
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
        publicQueue={kind !== 'add'}
        identity={identity}
        reviewedFor={review?.identity ?? tx.frozen?.identity ?? identity}
        receipt={review ? manageReceipt(review, meta, copy) : null}
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
