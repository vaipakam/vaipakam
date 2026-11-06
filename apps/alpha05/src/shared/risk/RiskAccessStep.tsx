import { useEffect, useRef, useState } from 'react';
import { useConfig } from 'wagmi';
import { writeContract } from 'wagmi/actions';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { requireSelector } from '../capability/types';
import { selectorOf, useCapabilities } from '../capability/CapabilityContext';
import { useCopy } from '../copy/useCopy';
import { refusalFromError } from '../eligibility/refusal';
import { WhyLink } from '../help/WhyLink';
import { useOwnRead } from '../reads/useOwnRead';
import { readTerms } from '../terms/terms';
import { simulateCall } from '../tx/simulate';
import { useStoredValue } from '../tx/txStore';
import { useMounted } from '../tx/useReviewRefresh';
import { useTrackedTx } from '../tx/useTrackedTx';
import type { LegOutcome } from '../tx/outcome';
import { ActionFlow, reviewIdentity, type Recheck } from '../ui/ActionFlow';
import { Notice } from '../ui/Notice';
import { formatUtc } from '../ui/format';
import { PLAN_SIGNATURES, RISK_ACCESS_ABI, pairName, planCall, readRiskStatus, riskPlan, type PairSource, type RiskNeed, type RiskPlan, type RiskStatus } from './riskAccess';
import { effectSentence, isAction, levelName, needSentences, planMoved, riskReceipt, type ActionPlan } from './riskReceipt';

type Hex = `0x${string}`;

interface StepProps {
  chain: SupportedChain;
  own: OwnStateClient;
  /** The step the protocol's own answer for the flow asks for. */
  need: RiskNeed;
  source: PairSource;
  /** The pair as the flow names it ("WETH borrowed against TLIQ"). */
  pairLabel: string;
}

function sourceKey(s: PairSource): string {
  return s.kind === 'offer' ? `offer:${s.offerId.toString()}` : `pair:${pairName(s.pair)}`;
}

/** Where this session keeps when an agreement it recorded takes effect: the
 *  protocol has no read for that time, so only the transaction that recorded
 *  it can say (its block time plus the waiting period then). */
function untilKey(chainId: number, account: Hex, s: RiskStatus): string {
  return `risk.until:${chainId}:${account.toLowerCase()}:${s.need}:${pairName(s.pair)}`;
}

const BUTTONS = { raise: 'risk.raise', reaffirm: 'risk.reaffirm', consent: 'risk.consentButton', ack: 'risk.ackButton' } as const;

/**
 * ACC-RISK — a risk-access block stated in place in a review, with the one
 * step that clears it. Which step is the protocol's answer for the flow
 * (`need`); this reads what the step stands on each block and says what it
 * would change and when it would count. A step already recorded and still in
 * its waiting period is never offered again (a second one would start the
 * wait over): the time it takes effect is stated instead, or that this app
 * cannot read it.
 */
export function RiskGate({ chain, own, need, source, pairLabel, onOpen }: StepProps & { onOpen: () => void }) {
  const copy = useCopy();
  const { text, format } = copy;
  const diamond = chain.diamondAddress;
  const status = useOwnRead(['riskStatus', diamond, need, sourceKey(source)], (c) => readRiskStatus(c, diamond, own.account, need, source), { perBlock: true });
  const s = status.data;
  const [until] = useStoredValue<bigint>(s ? untilKey(chain.chainId, own.account, s) : 'risk.until:none');

  if (s === null) {
    return status.state === 'failed' ? (
      <Notice tone="warn" tier="A">
        {format('risk.failed', { reason: status.error ?? 'no answer' })}{' '}
        <button type="button" className="btn" onClick={status.refetch}>
          {text('consent.retry')}
        </button>
      </Notice>
    ) : (
      <p className="tier-b">{text('risk.reading')}</p>
    );
  }
  const plan = riskPlan(s, until);
  return (
    <div className="risk-gate" data-risk-need={need} data-risk-plan={plan.kind} data-testid="risk-gate">
      {plan.kind !== 'met' &&
        needSentences(s, copy, pairLabel).map((line) => (
          <p key={line} className="tier-a">
            {line}
          </p>
        ))}
      {plan.kind === 'met' && <p className="tier-b">{text('risk.met')}</p>}
      {plan.kind === 'wait-tier' && (
        <Notice tone="info" tier="A">
          {format('risk.waitTier', { level: levelName(s.held, copy), when: formatUtc(Number(plan.until)) })}
        </Notice>
      )}
      {plan.kind === 'wait-pair' && (
        <Notice tone="info" tier="A">
          {plan.until === null ? text('risk.waitPairUnknown') : format('risk.waitPair', { when: formatUtc(Number(plan.until)) })}
        </Notice>
      )}
      {isAction(plan) && (
        <>
          <p className="tier-b">{effectSentence(s, copy)}</p>
          <p className="actions">
            <button type="button" className="btn btn-primary" onClick={onOpen} data-testid="risk-open">
              {text(BUTTONS[plan.kind])}
            </button>
          </p>
        </>
      )}
      <WhyLink summaryKey="risk.whySummary" detailKey="risk.why" />
    </div>
  );
}

/** The step under review, with the status and plan it was read with and the
 *  identity it was read under (RB-REVIEW). */
interface Reviewed {
  status: RiskStatus;
  plan: RiskPlan;
  readAt: number;
  identity: string;
  /** The flow's pair source the step was opened for (`sourceKey`). */
  source: string;
}

/**
 * ACC-RISK — the step itself, through the shared signing flow: the receipt
 * (what it changes, its reach, when it counts, that no funds move), a
 * re-read and dry run right before the wallet opens, and the outcome read
 * back from the chain at the receipt's block. It takes the review's place
 * while open, and hands back to the review when done.
 */
export function RiskStepFlow({ chain, own, need, source, pairLabel, flowKey, onBack }: StepProps & { flowKey: string; onBack: () => void }) {
  const copy = useCopy();
  const { text, format } = copy;
  const config = useConfig();
  const { caps } = useCapabilities();
  const diamond = chain.diamondAddress;
  const account = own.account;
  const identity = reviewIdentity(own);
  const key = `${flowKey}.risk`;
  const [reviewed, setReviewed] = useStoredValue<Reviewed>(`${key}:review`);
  const [, setUntil] = useStoredValue<bigint>(reviewed ? untilKey(chain.chainId, account, reviewed.status) : 'risk.until:none');
  const mounted = useMounted();

  const tx = useTrackedTx({
    key,
    chainId: chain.chainId,
    account,
    sources: own.sources,
    send: async () => {
      const call = reviewed && planCall(reviewed.plan, reviewed.status);
      if (!call) throw new Error('no risk-access step under review');
      return writeContract(config, { address: diamond, abi: RISK_ACCESS_ABI, functionName: call.functionName, args: call.args, chainId: chain.chainId, account });
    },
    measure: async (_receipt, at) => {
      if (!reviewed || !isAction(reviewed.plan)) return [];
      const plan = reviewed.plan;
      const after = await at.read((c, b) => readRiskStatus(c, diamond, account, reviewed.status.need, { kind: 'pair', pair: reviewed.status.pair }, b.blockNumber));
      const legs: LegOutcome[] = [];
      if (plan.kind === 'raise' || plan.kind === 'reaffirm') {
        const label = format('risk.legLevel', { level: levelName(plan.level, copy) });
        if (after.held !== plan.level || after.stale) {
          legs.push({ status: 'not-done', label, reason: text('risk.legLevelMissing') });
          return legs;
        }
        legs.push({ status: 'done', label });
        legs.push({ status: 'done', label: after.unlockAt <= after.chainNow ? text('risk.legNow') : format('risk.legAt', { when: formatUtc(Number(after.unlockAt)) }) });
        return legs;
      }
      const label = text(plan.kind === 'consent' ? 'risk.legConsent' : 'risk.legAck');
      if (after.inEffect)
        return [
          { status: 'done', label },
          { status: 'done', label: text('risk.legNow') },
        ];
      if (!after.pending) return [{ status: 'not-done', label, reason: text('risk.legPairMissing') }];
      const until = after.chainNow + after.cooldown;
      setUntil(until);
      return [
        { status: 'done', label },
        { status: 'done', label: format('risk.legAt', { when: formatUtc(Number(until)) }) },
      ];
    },
  });

  const [loadError, setLoadError] = useState<string | null>(null);
  const load = () =>
    own
      .read((c) => readRiskStatus(c, diamond, account, need, source))
      .then(
        ({ value }) => {
          if (!mounted.current) return;
          setLoadError(null);
          setReviewed({ status: value, plan: riskPlan(value, null), readAt: Date.now(), identity, source: sourceKey(source) });
        },
        (e: unknown) => {
          if (mounted.current) setLoadError(refusalFromError(e).reason);
        },
      );

  // Read the step once when it opens (a review kept from before, for the
  // same need and pair under this identity, is kept), and open the review.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    // A step that ended earlier (its finish card was left) starts a new
    // review; one still out with the wallet or the network is kept.
    const k = tx.phase.kind;
    const fresh = k === 'idle' || k === 'measured' || k === 'failed' || k === 'superseded';
    if (fresh) tx.review();
    if (!fresh || k === 'idle') {
      if (reviewed !== null && reviewed.identity === identity && reviewed.status.need === need && reviewed.source === sourceKey(source)) return;
    }
    setReviewed(null);
    void load();
    // Opened once; the stored review and the tracker carry the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const recheck = async (current: () => boolean): Promise<Recheck> => {
    if (!reviewed) return { kind: 'unreadable', reason: text('flow.reading') };
    const fn = reviewed.status.need === 'tier' ? PLAN_SIGNATURES.tier : reviewed.status.need === 'pair-consent' ? PLAN_SIGNATURES.consent : PLAN_SIGNATURES.ack;
    const routed = requireSelector(caps, selectorOf(fn), text('risk.capabilityName'));
    if (!routed.ok) return { kind: 'refused', refusal: { code: 'NotRouted', reason: routed.reason, reopensAt: null, remedy: null } };
    let now: RiskStatus;
    try {
      const [s, t] = await Promise.all([
        own.read((c) => readRiskStatus(c, diamond, account, reviewed.status.need, { kind: 'pair', pair: reviewed.status.pair })).then((r) => r.value),
        own.read((c) => readTerms(c, diamond, account)).then((r) => r.value),
      ]);
      if (t.kind === 'needed') return { kind: 'refused', refusal: { code: 'TermsNotAccepted', reason: text('accept.termsNewer'), reopensAt: null, remedy: null } };
      now = s;
    } catch (e) {
      return { kind: 'unreadable', reason: refusalFromError(e).reason };
    }
    const next = { status: now, plan: riskPlan(now, null) };
    if (!isAction(next.plan)) return { kind: 'refused', refusal: { code: 'AlreadyRecorded', reason: text('risk.already'), reopensAt: null, remedy: null } };
    if (planMoved(reviewed, next)) {
      if (current()) setReviewed({ ...next, readAt: Date.now(), identity: reviewed.identity, source: reviewed.source });
      return { kind: 'changed', what: text('risk.changedWhat') };
    }
    const call = planCall(reviewed.plan, reviewed.status)!;
    return simulateCall(own, { address: diamond, abi: RISK_ACCESS_ABI, functionName: call.functionName, args: call.args });
  };

  const back = () => {
    setReviewed(null);
    onBack();
  };

  const plan = reviewed?.plan ?? null;
  const action: ActionPlan | null = plan !== null && isAction(plan) ? plan : null;
  // Nothing to sign (the reads say it is recorded or no longer needed):
  // say so and hand back, unless a transaction is already out.
  if (reviewed !== null && action === null && tx.phase.kind === 'review') {
    return (
      <div className="risk-step" data-testid="risk-step">
        <Notice tone="info" tier="A">
          {text('risk.already')}
        </Notice>
        <p className="actions">
          <button type="button" className="btn btn-primary" onClick={back}>
            {text('risk.back')}
          </button>
        </p>
      </div>
    );
  }
  return (
    <div className="risk-step" data-testid="risk-step">
      {loadError !== null && (
        <Notice tone="warn" tier="A">
          {format('risk.failed', { reason: loadError })}{' '}
          <button type="button" className="btn" onClick={() => void load()}>
            {text('consent.retry')}
          </button>
        </Notice>
      )}
      <ActionFlow
        tx={tx}
        identity={identity}
        reviewedFor={reviewed?.identity ?? tx.frozen?.identity ?? identity}
        receipt={reviewed && action ? riskReceipt(action, reviewed.status, copy, { chain: chain.name, pairLabel, readAt: reviewed.readAt }) : null}
        recheck={recheck}
        describeAsset={() => null}
        explorer={chain.blockExplorer}
        next={null}
        after={() => (
          <p className="actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                tx.reset();
                back();
              }}
              data-testid="risk-back"
            >
              {text('risk.back')}
            </button>
          </p>
        )}
        onClose={back}
      />
    </div>
  );
}
