import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useConfig } from 'wagmi';
import { writeContract } from 'wagmi/actions';
import { useMode } from '../../app/ModeContext';
import type { SupportedChain } from '../../chain/chains';
import { useOwnStateClient, type OwnStateClient } from '../../chain/ownRail';
import {
  BILL_SIGNATURE,
  billingOn,
  CONSENT_CEILING,
  CONSENT_SIGNATURE,
  consentBlockers,
  consentCall,
  consentChanged,
  consentProblem,
  consentReceipt,
  consentRouting,
  measureConsent,
  parseCap,
  readConsentReview,
  readPaidPush,
  vpfi,
  type Billing,
  type ConsentChoice,
  type ConsentReview,
} from '../../shared/alerts/paidPush';
import { usePushStatus } from '../../shared/alerts/usePushStatus';
import { selectorOf, useCapabilities } from '../../shared/capability/CapabilityContext';
import { useCopy } from '../../shared/copy/useCopy';
import { refusalFromError, StatedRefusal } from '../../shared/eligibility/refusal';
import { WhyLink } from '../../shared/help/WhyLink';
import { useOwnRead } from '../../shared/reads/useOwnRead';
import { readTerms, type TermsState } from '../../shared/terms/terms';
import { TermsPrompt } from '../../shared/terms/TermsPrompt';
import { useTerms } from '../../shared/terms/useTerms';
import { useTermsGate } from '../../shared/terms/useTermsGate';
import { askThrough } from '../../shared/tx/simulate';
import { holdsFlow, useStoredValue, useTxEntry, useTxNote } from '../../shared/tx/txStore';
import { useMounted, useReviewRefresh } from '../../shared/tx/useReviewRefresh';
import { useTrackedTx } from '../../shared/tx/useTrackedTx';
import { ActionFlow, reviewIdentity, type Recheck } from '../../shared/ui/ActionFlow';
import { formatUtc } from '../../shared/ui/format';
import { Notice } from '../../shared/ui/Notice';

type Hex = `0x${string}`;

/** The store key the consent flow keeps its state under. */
const CONSENT_KEY = 'alerts.paidPush';

/**
 * Alerts › Paid push alerts (#3180 Alerts slice 3, ACC-53; RB-PAID-PUSH).
 * States the fee per loan side on this network, whether the alert service
 * charges here, the wallet's agreed cap and whether the contract judges it
 * covers the fee; agreeing records a cap on chain (Terms first, ACC-15) and
 * withdrawing is offered whenever a cap is stored, whatever the Terms, a
 * pause or the service say. Mounted per wallet and network (the page keys
 * it), so nothing shown belongs to another identity.
 */
export function PaidPush({ chain, account }: { chain: SupportedChain; account: Hex }) {
  const copy = useCopy();
  const { text, format } = copy;
  const { isAdvanced } = useMode();
  const own = useOwnStateClient();
  const diamond = chain.diamondAddress as Hex;
  const push = usePushStatus();
  const billing: Billing = billingOn(push.current, chain.chainId);
  const { caps } = useCapabilities();
  const routing = consentRouting(caps?.routedSelectors ?? null, selectorOf(CONSENT_SIGNATURE), selectorOf(BILL_SIGNATURE));
  const read = useOwnRead(['alerts', 'paidPush', diamond], (c) => readPaidPush(c, diamond, account), { enabled: routing === 'consent' });
  const terms = useTerms();
  const termsGate = useTermsGate(`${CONSENT_KEY}.terms`, chain, own);
  const entry = useTxEntry(CONSENT_KEY);
  const [choice, setChoice] = useStoredValue<ConsentChoice>(`${CONSENT_KEY}:choice`);
  const [follow, setFollow] = useState<bigint | null>(null);
  const [capInput, setCapInput] = useState('');
  const [capBad, setCapBad] = useState(false);
  const flowOpen = choice !== null || holdsFlow(entry.phase);

  const data = read.data;
  const open = (next: ConsentChoice) => {
    if (next.kind === 'agree' && terms.data?.kind === 'needed') {
      setFollow(next.cap);
      termsGate.start(terms.data);
      return;
    }
    setChoice(next);
  };
  const submitCap = (e: FormEvent) => {
    e.preventDefault();
    const cap = parseCap(capInput);
    setCapBad(cap === null);
    if (cap !== null) open({ kind: 'agree', cap });
  };

  const agreeProblem = data ? consentProblem({ kind: 'agree', cap: data.fee }, data, billing) : null;
  // Agreeing at the fee now is offered while no stored cap covers it; a
  // different cap is chosen in Advanced.
  const offerAgree = data !== null && routing === 'consent' && agreeProblem === null && !data.covers;
  const agreeBlocked = !own || terms.state !== 'ready' || termsGate.session !== null || flowOpen;

  return (
    <section className="home-section alert-channels" aria-labelledby="paid-push" data-testid="paid-push">
      <h2 id="paid-push">{text('paidPush.title')}</h2>
      <p className="tier-b">{text('paidPush.lead')}</p>
      <div className="card alert-channel">
        {routing === 'checking' && <p className="tier-b">{text('paidPush.routingChecking')}</p>}
        {routing === 'no-consent-bills' && (
          <p className="tier-a" data-testid="paid-push-no-record">
            {text('paidPush.noRecordBills')}
          </p>
        )}
        {routing === 'no-consent-no-bill' && (
          <p className="tier-b" data-testid="paid-push-no-record">
            {text('paidPush.noRecordNoBill')}
          </p>
        )}
        {routing === 'consent' && (
          <>
            <p className={billing === 'unknown' ? 'tier-a' : 'tier-b'} data-testid="paid-push-billing" data-billing={billing}>
              {format(billing === 'charges' ? 'paidPush.billingCharges' : billing === 'free' ? 'paidPush.billingFree' : 'paidPush.billingUnknown', { chain: chain.name })}
            </p>
            {data === null && read.state === 'failed' && (
              <Notice tone="warn" tier="A">
                {format('paidPush.unreadable', { chain: chain.name, reason: read.error ?? '' })}{' '}
                <button type="button" className="btn" onClick={read.refetch}>
                  {text('consent.retry')}
                </button>
              </Notice>
            )}
            {data === null && read.state !== 'failed' && <p className="tier-b">{format('paidPush.checking', { chain: chain.name })}</p>}
            {data !== null && (
              <>
                <p className="tier-b" data-testid="paid-push-fee">
                  {format('paidPush.fee', { fee: vpfi(data.fee), chain: chain.name })}
                </p>
                <p className="tier-a">{text('paidPush.feeHow')}</p>
                {data.cap === 0n ? (
                  <p className="tier-b" data-testid="paid-push-consent" data-cap="0">
                    {format('paidPush.none', { chain: chain.name })}
                  </p>
                ) : (
                  <div data-testid="paid-push-consent" data-cap={vpfi(data.cap)}>
                    <p className="tier-b">
                      {format('paidPush.agreed', { cap: vpfi(data.cap) })} {text(data.covers ? 'paidPush.covers' : 'paidPush.notCovers')}
                    </p>
                    {data.cap === CONSENT_CEILING && <p className="tier-a">{format('paidPush.atCeiling', { ceiling: vpfi(CONSENT_CEILING) })}</p>}
                    <p className="tier-a">{text('paidPush.rise')}</p>
                  </div>
                )}
                {data.freeVpfi === null && <p className="tier-a">{text('paidPush.freeUnread')}</p>}
                {data.freeVpfi !== null && data.freeVpfi < data.fee && (data.cap > 0n || billing === 'charges') && (
                  <p className="tier-a" data-testid="paid-push-low">
                    {format('paidPush.lowVpfi', { free: vpfi(data.freeVpfi) })}
                  </p>
                )}
                {data.frozen === 'flagged' && <p className="tier-a">{text('paidPush.problem_flagged')}</p>}
                {read.readAt !== null && <p className="tier-b muted">{format('paidPush.readAt', { time: formatUtc(Math.floor(read.readAt / 1000)) })}</p>}
                {termsGate.session && own && (
                  <TermsPrompt
                    asker={text('paidPush.askerAgree')}
                    gate={termsGate}
                    session={termsGate.session}
                    chain={chain}
                    own={own}
                    onAccepted={() => {
                      termsGate.end();
                      const cap = follow;
                      setFollow(null);
                      if (cap !== null) setChoice({ kind: 'agree', cap });
                    }}
                    onClose={() => {
                      termsGate.end();
                      setFollow(null);
                    }}
                  />
                )}
                {!flowOpen && (
                  <div className="form-actions">
                    {offerAgree && (
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={agreeBlocked}
                        onClick={() => open({ kind: 'agree', cap: data.fee })}
                        data-testid="paid-push-agree"
                      >
                        {format('paidPush.agree', { fee: vpfi(data.fee) })}
                      </button>
                    )}
                    {data.cap > 0n && (
                      <button type="button" className="btn" disabled={!own} onClick={() => open({ kind: 'withdraw' })} data-testid="paid-push-withdraw">
                        {text('paidPush.withdraw')}
                      </button>
                    )}
                  </div>
                )}
                {!flowOpen && isAdvanced && billing === 'charges' && data.frozen !== 'flagged' && (
                  <form className="form-row" onSubmit={submitCap} data-testid="paid-push-cap-form" noValidate>
                    <label>
                      {text('paidPush.capLabel')}
                      <input inputMode="decimal" value={capInput} onChange={(e) => setCapInput(e.target.value)} aria-describedby="paid-push-cap-hint" data-testid="paid-push-cap" />
                    </label>
                    <p className="tier-b" id="paid-push-cap-hint">
                      {format('paidPush.capHint', { fee: vpfi(data.fee), ceiling: vpfi(CONSENT_CEILING) })}
                    </p>
                    {capBad && <p className="tier-b">{text('paidPush.capBad')}</p>}
                    <button type="submit" className="btn" disabled={agreeBlocked} data-testid="paid-push-cap-agree">
                      {text('paidPush.agreeCap')}
                    </button>
                  </form>
                )}
              </>
            )}
            {flowOpen && own && (
              <ConsentFlow
                chain={chain}
                own={own}
                choice={choice}
                billing={billing}
                onTermsDue={terms.refetch}
                onClose={() => {
                  setChoice(null);
                  read.refetch();
                }}
              />
            )}
          </>
        )}
        <WhyLink summaryKey="paidPush.whySummary" detailKey="paidPush.why" />
      </div>
    </section>
  );
}

/**
 * The agree or withdraw flow: the review is read at one block and the
 * protocol's dry run passes before the wallet opens; the fee is read again
 * right before it opens (RB-REVIEW); the finish card names the cap the
 * transaction's record stores.
 */
function ConsentFlow({
  chain,
  own,
  choice,
  billing,
  onTermsDue,
  onClose,
}: {
  chain: SupportedChain;
  own: OwnStateClient;
  choice: ConsentChoice | null;
  billing: Billing;
  /** Called when the last check before an agreement finds an unaccepted
   *  Terms version, so the page reads the Terms again and asks for them. */
  onTermsDue: () => void;
  onClose: () => void;
}) {
  const copy = useCopy();
  const { text, format } = copy;
  const config = useConfig();
  const diamond = chain.diamondAddress as Hex;
  const account = own.account;
  const identity = reviewIdentity(own);
  const [review, setReview] = useStoredValue<ConsentReview>(`${CONSENT_KEY}:review`);
  const [loadError, setLoadError] = useState<string | null>(null);
  const setStep = useTxNote(CONSENT_KEY);
  const subject = review?.choice ?? choice;

  const tx = useTrackedTx({
    key: CONSENT_KEY,
    chainId: chain.chainId,
    account,
    sources: own.sources,
    send: async () => {
      const stop = (reason: string): never => {
        throw new StatedRefusal({ code: 'PaidPushStopped', reason, reopensAt: null, remedy: null });
      };
      if (!subject) return stop(text('flow.reading'));
      const call = consentCall(subject);
      const dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, ...call, account }));
      if (dry.kind === 'reverted') return stop(format('repay.dryRunRefused', { reason: refusalFromError(dry.error).reason }));
      if (dry.kind === 'unreadable') return stop(format('flow.unreadable', { reason: dry.reason }));
      setStep(format('accept.stepOf', { n: '1', total: '1', what: text(subject.kind === 'agree' ? 'paidPush.agreeTitle' : 'paidPush.withdrawTitle') }));
      return writeContract(config, { address: diamond, ...call, chainId: chain.chainId, account });
    },
    measure: async (receipt) => measureConsent(receipt.logs, diamond, account, subject ?? { kind: 'withdraw' }, copy),
    release: async () => null,
  });

  const mounted = useMounted();
  const readFor = (who: string, c: ConsentChoice) => readConsentReview(own, diamond, who, c, billing);
  const load = async () => {
    if (!subject) return;
    try {
      const next = await readFor(identity, subject);
      if (!mounted.current) return;
      setLoadError(null);
      setReview(next);
    } catch (e) {
      setLoadError(refusalFromError(e).reason);
    }
  };

  // RB-RAILS: read again each block while the review is on screen.
  const onReview = tx.phase.kind === 'review' && review !== null;
  useReviewRefresh<ConsentReview>({
    chainId: chain.chainId,
    active: onReview,
    review,
    read: (before) => readFor(before.identity, before.choice),
    sameSubject: () => true,
    changed: (before, next) => consentChanged(before, next, copy) !== null,
    setReview,
    onChanged: () => undefined,
  });

  const reviewOpened = useRef(false);
  useEffect(() => {
    const opening = tx.phase.kind === 'idle' || tx.phase.kind === 'review';
    if (!opening || !choice) return;
    if (tx.phase.kind === 'idle' && !reviewOpened.current) {
      reviewOpened.current = true;
      tx.review();
    }
    if (review === null || review.identity !== identity) {
      setReview(null);
      let live = true;
      readFor(identity, choice).then(
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
    let next: ConsentReview;
    let nowTerms: TermsState | null;
    try {
      // ACC-15: an agreement reads the Terms again right before signing, so a
      // wallet switched to while the review was open, or a version published
      // since, never agrees without acceptance. A withdrawal never asks.
      const agreeing = review.choice.kind === 'agree';
      [next, nowTerms] = await Promise.all([
        readFor(review.identity, review.choice),
        agreeing ? own.read((c) => readTerms(c, diamond, account)).then((x) => x.value) : Promise.resolve(null),
      ]);
    } catch (e) {
      return { kind: 'unreadable', reason: refusalFromError(e).reason };
    }
    if (nowTerms?.kind === 'needed') {
      onTermsDue();
      return { kind: 'refused', refusal: { code: 'TermsNotAccepted', reason: text('paidPush.termsNewer'), reopensAt: null, remedy: null } };
    }
    const what = consentChanged(review, next, copy);
    if (current()) setReview(next);
    if (what !== null) return { kind: 'changed', what };
    const blockers = consentBlockers(next, copy);
    if (blockers.length > 0)
      return {
        kind: 'refused',
        refusal: { code: next.dryRun !== null && next.dryRun !== 'unread' ? next.dryRun.code : 'PaidPushBlocked', reason: blockers[0]!, reopensAt: null, remedy: null },
      };
    return { kind: 'ok' };
  };

  const blockers = review ? consentBlockers(review, copy) : [];
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
    <div className="repay-loan" data-testid="paid-push-panel">
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
        receipt={review ? consentReceipt(review, copy) : null}
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
