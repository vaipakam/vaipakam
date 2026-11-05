import { useState, type ReactNode } from 'react';
import { useConfig } from 'wagmi';
import { writeContract } from 'wagmi/actions';
import { useOwnStateClient } from '../../chain/ownRail';
import { getSupportedChain } from '../../chain/chains';
import { requireSelector } from '../capability/types';
import { selectorOf, useCapabilities } from '../capability/CapabilityContext';
import { useCopy } from '../copy/useCopy';
import { SWITCH_EFFECTS } from '../eligibility/switchClasses';
import { WhyLink } from '../help/WhyLink';
import { useChainRead } from '../reads/chainRead';
import { readPosture, usePosture } from '../reads/posture';
import { useOwnRead } from '../reads/useOwnRead';
import { TermsPrompt } from '../terms/TermsPrompt';
import { readTerms, type TermsState } from '../terms/terms';
import { useTerms } from '../terms/useTerms';
import { simulateCall } from '../tx/simulate';
import { useTrackedTx } from '../tx/useTrackedTx';
import { ActionFlow, type Recheck } from '../ui/ActionFlow';
import { Notice } from '../ui/Notice';
import { SET_CONSENT_SIGNATURE, VPFI_DISCOUNT_ABI, consentReceipt, readDeliveryMode, readFeeDiscountConsent, type Reviewed } from './feeDiscount';

type Hex = `0x${string}`;

/**
 * RW-07 — the operable fee-discount toggle (a status-only chip would breach
 * the canonical text: the setting must be manageable away from the VPFI
 * vault page). Turning it on is new enablement, so the Terms gate applies
 * (ACC-15); turning it off never is. The protocol's global pause closes the
 * call in BOTH directions, so a pause is named as the refusal, with what
 * stays open, rather than a button that would fail.
 */
export function FeeDiscountConsent() {
  const { text, format } = useCopy();
  const config = useConfig();
  const own = useOwnStateClient();
  const chain = getSupportedChain(own?.chainId);
  const diamond = (chain?.diamondAddress ?? '0x') as Hex;
  const account = (own?.account ?? '0x') as Hex;
  const enabled = chain !== null;
  const consent = useOwnRead(['feeDiscountConsent', diamond], (c) => readFeeDiscountConsent(c, diamond, account), { enabled });
  const mode = useChainRead(['feeDiscountMode', diamond], (c) => readDeliveryMode(c, diamond), { enabled });
  const posture = usePosture(diamond);
  const terms = useTerms();
  const { caps } = useCapabilities();
  const routed = requireSelector(caps, selectorOf(SET_CONSENT_SIGNATURE), text('consent.capabilityName'));
  const [panel, setPanel] = useState<'none' | 'terms' | 'flow'>('none');
  const [reviewed, setReviewed] = useState<Reviewed | null>(null);
  /** The Terms the prompt was opened for: kept while it is open, so the
   *  acceptance's own re-read does not close it before its outcome shows. */
  const [asked, setAsked] = useState<Extract<TermsState, { kind: 'needed' }> | null>(null);

  const target = reviewed?.target ?? false;
  const tx = useTrackedTx({
    chainId: chain?.chainId ?? 0,
    account,
    send: () =>
      writeContract(config, { address: diamond, abi: VPFI_DISCOUNT_ABI, functionName: 'setVPFIDiscountConsent', args: [target], chainId: chain!.chainId, account }),
    measure: async () => {
      const now = (await own!.read((c) => readFeeDiscountConsent(c, diamond, account))).value;
      const label = format('consent.leg', { state: text(target ? 'consent.stateOn' : 'consent.stateOff') });
      if (now === target) return [{ status: 'done', label }];
      return [{ status: 'not-done', label, reason: text('consent.legMissing') }];
    },
  });

  if (!own || !chain) return null;
  const chainName = chain.name;

  const startReview = (next: boolean) => {
    setReviewed({ target: next, mode: mode.state === 'ready' && mode.error === null ? mode.data : null, readAt: Date.now() });
    setPanel('flow');
    tx.review();
  };

  const toggle = (next: boolean) => {
    if (next && terms.data?.kind === 'needed') {
      setAsked(terms.data);
      setPanel('terms');
      return;
    }
    startReview(next);
  };

  // RB-REVIEW: everything the receipt and the gate stand on, read again
  // through the own rail, then the call simulated as the sender.
  const recheck = async (): Promise<Recheck> => {
    if (!reviewed) return { kind: 'unreadable', reason: text('flow.reading') };
    const [now, p, m, t] = await Promise.all([
      own.read((c) => readFeeDiscountConsent(c, diamond, account)),
      own.read((c) => readPosture(c, diamond)),
      own.read((c) => readDeliveryMode(c, diamond)).then(
        (r) => r.value,
        () => null,
      ),
      reviewed.target ? own.read((c) => readTerms(c, diamond, account)).then((r) => r.value) : Promise.resolve(null),
    ]);
    if (p.value.paused) return { kind: 'refused', refusal: { code: 'EnforcedPause', reason: format('consent.paused', { staysOpen: SWITCH_EFFECTS['2'].staysOpen }), reopensAt: null, remedy: null } };
    if (t !== null && t.kind === 'needed') {
      return { kind: 'refused', refusal: { code: 'TermsNotAccepted', reason: text('consent.termsNewer'), reopensAt: null, remedy: null } };
    }
    if (now.value === reviewed.target) {
      return { kind: 'refused', refusal: { code: 'AlreadySet', reason: format('consent.already', { state: text(reviewed.target ? 'consent.stateOn' : 'consent.stateOff') }), reopensAt: null, remedy: null } };
    }
    // Turning it on can let vault VPFI be spent on fees: how the discount is
    // delivered is a funds fact, so it must be READ before signing.
    if (reviewed.target && m === null) return { kind: 'unreadable', reason: text('consent.modeUnknown') };
    if (m !== reviewed.mode) {
      setReviewed({ ...reviewed, mode: m, readAt: Date.now() });
      return { kind: 'changed', what: text('consent.changedMode') };
    }
    return simulateCall(own, { address: diamond, abi: VPFI_DISCOUNT_ABI, functionName: 'setVPFIDiscountConsent', args: [reviewed.target] });
  };

  const close = () => {
    setPanel('none');
    setReviewed(null);
    setAsked(null);
  };

  // The action, by one verdict: withheld until its inputs are read, closed by
  // the pause (both directions), and, for turning on, by an unreadable Terms
  // state, which is "cannot confirm", never "not accepted".
  let action: ReactNode;
  const current = consent.data;
  const postureKnown = posture.state === 'ready' && posture.error === null && posture.data !== null;
  if (current === null) action = null;
  else if (!routed.ok) action = <p className="tier-b">{routed.reason}</p>;
  else if (!postureKnown) {
    action =
      posture.state === 'reading' ? (
        <p className="tier-b">{text('action.withheld')}</p>
      ) : (
        <Notice tone="warn" tier="A">
          {format('consent.postureUnknown', { reason: posture.error ?? 'no answer' })}
        </Notice>
      );
  } else if (posture.data!.paused) {
    action = (
      <Notice tone="danger" tier="A">
        {format('consent.paused', { staysOpen: SWITCH_EFFECTS['2'].staysOpen })}
      </Notice>
    );
  } else if (!current && terms.state !== 'ready') {
    action =
      terms.state === 'failed' ? (
        <Notice tone="warn" tier="A">
          {format('consent.termsUnknown', { chain: chainName, reason: terms.error ?? 'no answer' })}{' '}
          <button type="button" className="btn" onClick={terms.refetch}>
            {text('consent.retry')}
          </button>
        </Notice>
      ) : (
        <p className="tier-b">{text('action.withheld')}</p>
      );
  } else {
    action = (
      <p className="actions">
        <button type="button" className="btn btn-primary" disabled={panel !== 'none'} onClick={() => toggle(!current)} data-testid="consent-toggle">
          {text(current ? 'consent.turnOff' : 'consent.turnOn')}
        </button>
      </p>
    );
  }

  return (
    <section className="home-section consent" aria-labelledby="consent-title" data-consent={current === null ? 'unknown' : current ? 'on' : 'off'}>
      <h2 id="consent-title">{text('consent.title')}</h2>
      {consent.state === 'reading' && <p className="tier-b">{text('consent.reading')}</p>}
      {consent.state === 'failed' && (
        <Notice tone="warn" tier="A">
          {format('consent.failed', { reason: consent.error ?? 'no answer' })}{' '}
          <button type="button" className="btn" onClick={consent.refetch}>
            {text('consent.retry')}
          </button>
        </Notice>
      )}
      {current !== null && (
        <WhyLink summaryKey={current ? 'consent.on' : 'consent.off'} detailKey="consent.why" vars={{ chain: chainName }} />
      )}
      {consent.error !== null && current !== null && <p className="tier-b">{text('consent.stale')}</p>}
      {panel === 'none' && action}
      {panel === 'terms' && asked && (
        <TermsPrompt
          asker={text('consent.asker')}
          terms={asked}
          chain={chain}
          own={own}
          onAccepted={() => startReview(true)}
          onClose={close}
        />
      )}
      {panel === 'flow' && reviewed && (
        <ActionFlow
          tx={tx}
          identity={`${chain.chainId}:${own.account}`}
          receipt={consentReceipt(reviewed, chainName, { text, format })}
          recheck={recheck}
          describeAsset={() => null}
          explorer={chain.blockExplorer}
          next={null}
          onClose={close}
        />
      )}
    </section>
  );
}
