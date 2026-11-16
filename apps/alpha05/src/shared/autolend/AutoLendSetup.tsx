import { useEffect, useRef, useState } from 'react';
import { useConfig } from 'wagmi';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useMode } from '../../app/ModeContext';
import { useCapabilities } from '../capability/CapabilityContext';
import { useCopy } from '../copy/useCopy';
import { refusalFromError, StatedRefusal } from '../eligibility/refusal';
import { WhyLink } from '../help/WhyLink';
import { GUIDE_ORIGIN, guideUrl } from '../help/guide';
import { legVerdict, moved } from '../offers/acceptOutcome';
import { readVault } from '../offers/reads';
import { assetName, exactTokenAmount, tokenAmount, type TokenMetaMap } from '../reads/tokens';
import { erc20Pair, type RiskNeed } from '../risk/riskAccess';
import { RiskGate, RiskStepFlow } from '../risk/RiskAccessStep';
import { readTerms, termsUrl, type TermsState } from '../terms/terms';
import { allowanceSteps } from '../tx/approval';
import { allowanceMoved, approvalFlow } from '../tx/approvalFlow';
import { cleanUpLeg } from '../tx/cleanUp';
import { readValidUntil } from '../tx/deadline';
import type { LegOutcome } from '../tx/outcome';
import { sendWrite } from '../tx/send';
import { askThrough } from '../tx/simulate';
import { useStoredValue, useTxNote } from '../tx/txStore';
import { useMounted, useReviewRefresh } from '../tx/useReviewRefresh';
import { useTrackedTx } from '../tx/useTrackedTx';
import { ActionFlow, reviewIdentity, type Recheck } from '../ui/ActionFlow';
import { Notice } from '../ui/Notice';
import { pageHandoff } from '../../routes/pageMap';
import { setupCall, setupLogs, type AutoLendDraft } from './autoLend';
import { autoLendReceipt, readAutoLendReview, reviewBlockers, reviewKey, type AutoLendReview } from './autoLendReview';
import { AUTOLEND_KEY } from './AutoLendForm';

type Hex = `0x${string}`;

interface AutoLendSetupProps {
  draft: AutoLendDraft;
  chain: SupportedChain;
  own: OwnStateClient;
  meta: TokenMetaMap | null;
  terms: TermsState | null;
  /** Back to the form to change a figure (the typed form is kept). */
  onEdit: () => void;
  /** Finished or abandoned; `done` when Auto-lend was recorded, so the
   *  typed form is cleared. */
  onClose: (done: boolean) => void;
}

/**
 * #3624 — sets up Auto-lend: the review is the protocol's own verdict on the
 * setup as a dry run from this wallet, with every figure it binds and the
 * single Risk and Terms consent bound to that read. The wallet approves
 * exactly the amount funded when its allowance does not cover it; the whole
 * setup (terms, then funding) is dry-run again with the approval in place
 * and sent as one transaction, so the terms are never recorded without the
 * money behind them, nor the money moved without the terms. If anything
 * stops it after an approval, the approval is put back (best effort, stated
 * either way). The outcome is measured from the transaction's own logs: the
 * terms recorded, the amount set aside, and the amount that moved into the
 * vault.
 */
export function AutoLendSetup({ draft, chain, own, meta, terms, onEdit, onClose }: AutoLendSetupProps) {
  const copy = useCopy();
  const { text, format } = copy;
  const config = useConfig();
  const { mode } = useMode();
  const diamond = chain.diamondAddress;
  const account = own.account;
  const identity = reviewIdentity(own);
  const { caps } = useCapabilities();
  const matcher = caps?.keeper.find((k) => k.pass === 'matcher')?.armed ?? 'unknown';
  const [review, setReview] = useStoredValue<AutoLendReview>(`${AUTOLEND_KEY}:review`);
  const [consentFor, setConsentFor] = useStoredValue<number>(`${AUTOLEND_KEY}:consent`);
  const [done, setDone] = useStoredValue<boolean>(`${AUTOLEND_KEY}:done`);
  const [riskOpen, setRiskOpen] = useStoredValue<RiskNeed>(`${AUTOLEND_KEY}:risk`);
  const [loadError, setLoadError] = useState<string | null>(null);
  const setStep = useTxNote(AUTOLEND_KEY);
  /** The approval this flow made and has not yet seen used or put back. */
  const approvalLeft = useRef<{ token: Hex; prior: bigint; amount: bigint; since: bigint | null } | null>(null);
  const counter = useRef<{ n: number; total: number }>({ n: 0, total: 0 });

  const exact = (asset: Hex, v: bigint) => exactTokenAmount(v, asset, meta, format);
  const { readAllowance, allowanceIo, approveExactly, putBack } = approvalFlow({ own, config, chainId: chain.chainId, diamond, copy, exactAmount: exact, setStep });

  const tx = useTrackedTx({
    key: AUTOLEND_KEY,
    chainId: chain.chainId,
    account,
    sources: own.sources,
    send: async () => {
      if (!review || review.minFill === null) throw new Error('no setup under review');
      const r = review;
      const minFill = r.minFill!;
      const token = r.draft.lending;
      const fund = r.draft.parsed.fund;
      counter.current = { n: 0, total: r.approvalSteps + 1 };
      const say = (what: string) => setStep(format('accept.stepOf', { n: String(++counter.current.n), total: String(counter.current.total), what }));
      approvalLeft.current = null;

      // 1. The approval, when needed: exactly the amount funded, judged by
      //    the allowance each step leaves. Read again first, so a change
      //    since the review stops before any prompt.
      let putItBack: (() => Promise<{ sentence: string }>) | null = null;
      const io = allowanceIo(token, (amount, i, of) => say(of === 2 && i === 0 ? text('approval.stepZero') : format('approval.step', { amount: exact(token, amount) })));
      const prior = await readAllowance(token);
      const steps = prior < fund ? await allowanceSteps(io, prior, fund) : [];
      if (steps.length !== r.approvalSteps) throw allowanceMoved(copy);
      if (steps.length > 0) {
        const since = await approveExactly(io, token, fund, prior);
        approvalLeft.current = { token, prior, amount: fund, since };
        putItBack = () => putBack(token, prior, fund, since);
      }
      const stop = async (reason: string): Promise<never> => {
        if (putItBack === null) throw new StatedRefusal({ code: 'SetupStopped', reason, reopensAt: null, remedy: null });
        approvalLeft.current = null;
        const after = await putItBack();
        throw new StatedRefusal({ code: 'SetupStopped', reason: `${reason} ${after.sentence}`, reopensAt: null, remedy: null });
      };

      // 2. The dry run of the whole setup with the approval in place, with
      //    the deadline the write carries.
      const call = setupCall(r.draft, minFill, await readValidUntil(own));
      const dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, ...call, account }));
      if (dry.kind === 'reverted') return stop(format('autoLend.dryRunRefused', { reason: refusalFromError(dry.error).reason }));
      if (dry.kind === 'unreadable') return stop(format('flow.unreadable', { reason: dry.reason }));

      // 3. The setup, one transaction.
      say(text('autoLend.stepSend'));
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
      const after = await putBack(left.token, left.prior, left.amount, left.since);
      return cleanUpLeg(after, format('approval.legBack', { amount: exact(left.token, left.prior) }));
    },
    measure: async (receipt, at) => {
      if (!review) return [];
      const d = review.draft;
      const legs: LegOutcome[] = [];
      const logs = setupLogs(receipt.logs, diamond, account, d.lending, d.collateral);
      if (logs.set) {
        setDone(true);
        legs.push({ status: 'done', label: text('autoLend.legSet') });
      } else {
        legs.push({ status: 'not-done', label: text('autoLend.legNotSet'), reason: text('autoLend.notSet') });
      }
      const fund = d.parsed.fund;
      const label = format('autoLend.legFunded', { amount: tokenAmount(fund, d.lending, meta, format) });
      let vault: Hex | null = null;
      try {
        vault = await at.read((c, b) => readVault(c, diamond, account, b));
      } catch {
        vault = null;
      }
      // What moved into the vault, from the token's own Transfer logs, and
      // what the protocol recorded as set aside, must both be the amount.
      const into = vault === null ? null : moved(receipt.logs, d.lending, account, vault);
      if (into === null) {
        legs.push({ status: 'unknown', label, reason: text('accept.vaultUnknown') });
      } else {
        const lv = legVerdict(logs.funded === into ? into : 0n, fund);
        legs.push(
          lv === 'done'
            ? { status: 'done', label }
            : { status: lv, label, reason: format('autoLend.fundedOther', { amount: exact(d.lending, into), expected: exact(d.lending, fund) }) },
        );
      }
      return legs;
    },
  });

  const mounted = useMounted();
  const load = async () => {
    try {
      const next = await readAutoLendReview(own, diamond, draft, identity);
      if (!mounted.current) return;
      setLoadError(null);
      setReview(next);
    } catch (e) {
      setLoadError(refusalFromError(e).reason);
    }
  };

  // RB-RAILS: read again each block while the review is on screen.
  const onReview = tx.phase.kind === 'review' && review !== null && review.draft === draft;
  useReviewRefresh<AutoLendReview>({
    chainId: chain.chainId,
    active: onReview,
    review,
    read: (before) => readAutoLendReview(own, diamond, before.draft, before.identity),
    sameSubject: (a, b) => a.draft === b.draft,
    changed: (before, next) => reviewKey(before) !== reviewKey(next),
    setReview,
    onChanged: () => setConsentFor(null),
  });

  // Open the review for this draft when the panel opens on it.
  const opened = useRef<AutoLendDraft | null>(null);
  useEffect(() => {
    const open = tx.phase.kind === 'idle' || tx.phase.kind === 'review';
    if (!open) return;
    if (tx.phase.kind === 'idle' && opened.current !== draft) {
      opened.current = draft;
      tx.review();
    }
    if (review === null || review.draft !== draft) {
      setReview(null);
      setConsentFor(null);
      setDone(null);
      setRiskOpen(null);
      let live = true;
      readAutoLendReview(own, diamond, draft, identity).then(
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

  const blockers = review ? reviewBlockers(review, meta, copy) : [];

  const recheck = async (current: () => boolean): Promise<Recheck> => {
    if (!review) return { kind: 'unreadable', reason: text('flow.reading') };
    let next: AutoLendReview;
    let nowTerms: TermsState;
    try {
      [next, nowTerms] = await Promise.all([readAutoLendReview(own, diamond, review.draft, review.identity), own.read((c) => readTerms(c, diamond, account)).then((x) => x.value)]);
    } catch (e) {
      return { kind: 'unreadable', reason: refusalFromError(e).reason };
    }
    if (nowTerms.kind === 'needed') return { kind: 'refused', refusal: { code: 'TermsNotAccepted', reason: text('lendOffer.termsNewer'), reopensAt: null, remedy: null } };
    if (reviewKey(review) !== reviewKey(next)) {
      if (current()) {
        setReview(next);
        setConsentFor(null);
      }
      return { kind: 'changed', what: text('autoLend.changed') };
    }
    const b = reviewBlockers(next, meta, copy);
    if (b.length > 0) return { kind: 'refused', refusal: { code: 'SetupBlocked', reason: b[0]!, reopensAt: null, remedy: null } };
    if (next.risk !== null) return { kind: 'refused', refusal: { code: 'RiskStepNeeded', reason: text('lend.rowRiskStep'), reopensAt: null, remedy: null } };
    return { kind: 'ok' };
  };

  const clear = () => {
    setReview(null);
    setConsentFor(null);
    setStep(null);
    setRiskOpen(null);
  };
  const close = () => {
    const recorded = done === true;
    clear();
    setDone(null);
    onClose(recorded);
  };
  const edit = () => {
    tx.reset();
    clear();
    onEdit();
  };

  const positions = pageHandoff('/positions');
  const consented = review !== null && consentFor === review.readAt;
  const termsLink = terms && terms.kind !== 'none' ? termsUrl(terms.version) : `${GUIDE_ORIGIN}/terms`;
  const riskLink = guideUrl(mode, 'lend-risks');
  const pairLabel = format('risk.pairName', { lend: assetName(draft.lending, meta), coll: assetName(draft.collateral, meta) });
  const riskPair = erc20Pair(draft.lending, draft.collateral);

  const gate = review
    ? {
        ready: consented && blockers.length === 0 && review.risk === null,
        node: (
          <div className="accept-gate">
            {blockers.map((b) => (
              <Notice key={b} tone="danger" tier="A">
                {b}
              </Notice>
            ))}
            {review.risk !== null && (
              <RiskGate chain={chain} own={own} need={review.risk} source={{ kind: 'pair', pair: riskPair }} pairLabel={pairLabel} onOpen={() => setRiskOpen(review.risk)} />
            )}
            <WhyLink summaryKey="autoLend.choiceSummary" detailKey="autoLend.choiceWhy" />
            {blockers.length === 0 && (
              <p className="consent tier-a">
                <label>
                  <input type="checkbox" checked={consented} onChange={(e) => setConsentFor(e.target.checked ? review.readAt : null)} data-testid="autolend-consent" />
                  <span>
                    {text('accept.consentLead')}
                    <a href={riskLink} target="_blank" rel="noreferrer">
                      {text('accept.consentRisk')}
                    </a>
                    {text('accept.consentAnd')}
                    <a href={termsLink} target="_blank" rel="noreferrer">
                      {text('accept.consentTerms')}
                    </a>
                    {text('accept.consentEnd')}
                  </span>
                </label>
              </p>
            )}
            {blockers.length === 0 && !consented && <p className="tier-b">{text('accept.consentNeeded')}</p>}
            {tx.phase.kind === 'review' && (
              <p>
                <button type="button" className="btn btn-link" onClick={edit} data-testid="autolend-edit">
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
    <div className="post-request autolend-setup" data-testid="autolend-setup">
      {loadError !== null && (
        <Notice tone="warn" tier="A">
          {format('flow.unreadable', { reason: loadError })}{' '}
          <button type="button" className="btn" onClick={() => void load()}>
            {text('consent.retry')}
          </button>
        </Notice>
      )}
      {riskOpen !== null ? (
        <RiskStepFlow
          chain={chain}
          own={own}
          need={riskOpen}
          source={{ kind: 'pair', pair: riskPair }}
          pairLabel={pairLabel}
          flowKey={AUTOLEND_KEY}
          onBack={() => {
            setRiskOpen(null);
            void load();
          }}
        />
      ) : (
        <ActionFlow
          tx={tx}
          identity={identity}
          reviewedFor={review?.identity ?? tx.frozen?.identity ?? identity}
          receipt={review ? autoLendReceipt(review, meta, copy, matcher) : null}
          recheck={recheck}
          describeAsset={describeAsset}
          explorer={chain.blockExplorer}
          next={
            done !== true || positions.kind === 'none'
              ? null
              : positions.kind === 'here'
                ? { label: text('autoLend.openPositions'), to: positions.to }
                : { label: text('autoLend.openPositions'), href: positions.href }
          }
          gate={gate}
          onClose={close}
        />
      )}
    </div>
  );
}
