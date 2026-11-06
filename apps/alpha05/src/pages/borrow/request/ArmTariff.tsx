import { useEffect, useRef, useState } from 'react';
import { useConfig } from 'wagmi';
import { writeContract } from 'wagmi/actions';
import { formatUnits } from 'viem';
import type { OwnStateClient } from '../../../chain/ownRail';
import { getSupportedChain } from '../../../chain/chains';
import { requireSelector } from '../../../shared/capability/types';
import { selectorOf, useCapabilities } from '../../../shared/capability/CapabilityContext';
import { useCopy } from '../../../shared/copy/useCopy';
import { refusalFromError } from '../../../shared/eligibility/refusal';
import { PROFILE, readOfferTariff, SET_TARIFF_SIGNATURE, tariffMatches, VPFI_DECIMALS } from '../../../shared/offers/fullTariff';
import type { Receipt } from '../../../shared/receipt/types';
import { simulateCall } from '../../../shared/tx/simulate';
import { useStoredValue } from '../../../shared/tx/txStore';
import { useTrackedTx } from '../../../shared/tx/useTrackedTx';
import { ActionFlow, reviewIdentity, type Recheck } from '../../../shared/ui/ActionFlow';
import type { TxPhase } from '../../../shared/tx/outcome';
import { armEnding, type ArmContext, type ArmEnding } from './armState';
import { Notice } from '../../../shared/ui/Notice';
import { REQUEST_KEY } from './RequestForm';

type Hex = `0x${string}`;

/** The arm step's own tracked transaction, beside the request's. */
export const TARIFF_KEY = `${REQUEST_KEY}:tariff`;
/** Where the arm step's context is kept: written when a posting with the
 *  tariff chosen measures its request, cleared when the reader dismisses
 *  the step's last word. It lives apart from the request's own review, so
 *  closing the request's finish card never drops a tariff transaction in
 *  flight or its outcome. */
export type { ArmContext } from './armState';
export const TARIFF_CONTEXT_KEY = `${TARIFF_KEY}:ctx`;

const ENDING_KEYS = {
  armed: 'request.tariffEndArmed',
  'not-set': 'request.tariffLegMissing',
  unknown: 'request.tariffEndUnknown',
  skipped: 'request.tariffSkipped',
} as const;

type ReadNote = { kind: 'reading' } | { kind: 'switch' } | { kind: 'failed'; reason: string } | { kind: 'not-yet' | 'taken'; at: number };

interface ArmTariffProps {
  ctx: ArmContext;
  /** The connected wallet's client; the step withholds signing while it is
   *  not the one that posted the request. */
  own: OwnStateClient;
  /** The reader dismissed the step's last word: the context is cleared. */
  onDone: () => void;
}

/**
 * OFF-22 — arms the Full fee tariff on a request just posted: the creator's
 * opt-in is its own transaction (`setOfferCreatorFullTariff`), sent after
 * posting and refused by the protocol once a lender has taken the request.
 * It opens below the request's finish card with its own receipt, from a
 * stored context bound to the wallet and network that posted the request,
 * so it outlives that card and never signs from another network. It
 * re-reads the request before the wallet opens (taken, not the creator,
 * already set),
 * simulates the call, and measures by reading the request back. Until it
 * confirms, a lender who takes the request opens a loan without the tariff;
 * that gap is stated here and in the request's review. Closing the step
 * leaves its last word in place (set, not set, not known, or skipped) until
 * the reader dismisses it.
 */
export function ArmTariff({ ctx, own, onDone }: ArmTariffProps) {
  const copy = useCopy();
  const { text, format } = copy;
  const config = useConfig();
  const { offerId, choice } = ctx;
  const chainId = Number(ctx.identity.split(':')[0]);
  const account = ctx.identity.split(':')[1] as Hex;
  const chain = getSupportedChain(chainId);
  const diamond = (chain?.diamondAddress ?? '0x') as Hex;
  const identity = reviewIdentity(own);
  const { caps } = useCapabilities();
  const routed = requireSelector(caps, selectorOf(SET_TARIFF_SIGNATURE), text('request.tariffCapabilityName'));
  /** The request this arm step belongs to (identity and id): a step kept for
   *  an earlier request is started again for this one. */
  const subject = `${ctx.identity}#${offerId.toString()}`;
  const [armedFor, setArmedFor] = useStoredValue<string>(`${TARIFF_KEY}:for`);
  /** The step's ending, stored with the request it belongs to: an ending
   *  written for another request (a late read-back after its step was
   *  dismissed) is never read as this step's. */
  const [storedEnding, setStoredEnding] = useStoredValue<{ for: string; ending: ArmEnding }>(`${TARIFF_KEY}:ended`);
  const ended = storedEnding?.for === subject ? storedEnding.ending : null;
  const setEnded = (ending: ArmEnding | null) => setStoredEnding(ending === null ? null : { for: subject, ending });
  const [readAt] = useState(() => Date.now());
  /** The last read-back of an unknown ending, as stated under it. */
  const [readNote, setReadNote] = useState<ReadNote | null>(null);

  const tx = useTrackedTx({
    key: TARIFF_KEY,
    chainId,
    account,
    sources: own.sources,
    send: () =>
      writeContract(config, {
        address: diamond,
        abi: PROFILE,
        functionName: 'setOfferCreatorFullTariff',
        args: [offerId, true, choice.maxCStar, choice.allowDowngrade],
        chainId,
        account,
      }),
    measure: async (_receipt, at) => {
      const label = format('request.tariffLeg', { id: offerId.toString() });
      const now = await at.read((c, b) => readOfferTariff(c, diamond, offerId, b));
      if (tariffMatches(now.stored, choice)) return [{ status: 'done', label }];
      return [{ status: 'not-done', label, reason: text('request.tariffLegMissing') }];
    },
  });

  // Opened once per request: a step kept for an earlier request is reset;
  // one kept for this request carries on where it was. The ref keeps a
  // repeated effect (a remount in development) from opening it twice.
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (opened.current === subject) return;
    opened.current = subject;
    if (armedFor !== subject) {
      readSet.current = false;
      setArmedFor(subject);
      setEnded(null);
      if (tx.phase.kind !== 'idle') tx.reset();
      tx.review();
    } else if (tx.phase.kind === 'idle' && ended === null) {
      tx.review();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subject]);

  /** The phase as of the latest render: the card's Close resets the tracker
   *  before it reports, so the ending is read from here. */
  const lastPhase = useRef<TxPhase>(tx.phase);
  /** Whether a re-check read the chosen tariff already on the request. */
  const readSet = useRef(false);
  /** The read-back in flight (each start or dismissal moves it on), and
   *  whether the step is still on screen, so a late answer is dropped. */
  const readSeq = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    lastPhase.current = tx.phase;
  }, [tx.phase]);

  const recheck = async (): Promise<Recheck> => {
    // A routing table still loading (or failing to load) is not a refusal:
    // signing is withheld until it is read, and the check can run again.
    if (!caps || caps.routedSelectors === null) return { kind: 'unreadable', reason: routed.reason };
    if (!routed.ok) return { kind: 'refused', refusal: { code: 'NotRouted', reason: routed.reason, reopensAt: null, remedy: null } };
    // The request's own network and wallet, never the connected ones: the
    // flow already withholds signing when they differ, and this holds it
    // again at the moment the wallet would open.
    if (identity !== ctx.identity) return { kind: 'refused', refusal: { code: 'IdentityMoved', reason: text('flow.identityChanged'), reopensAt: null, remedy: null } };
    let now;
    try {
      now = (await own.read((c) => readOfferTariff(c, diamond, offerId))).value;
    } catch (e) {
      return { kind: 'unreadable', reason: refusalFromError(e).reason };
    }
    if (now.creator.toLowerCase() !== account.toLowerCase())
      return { kind: 'refused', refusal: { code: 'NotCreator', reason: text('request.tariffNotCreator'), reopensAt: null, remedy: null } };
    if (now.accepted) return { kind: 'refused', refusal: { code: 'OfferAlreadyAccepted', reason: text('request.tariffArmTaken'), reopensAt: null, remedy: null } };
    if (tariffMatches(now.stored, choice)) {
      // Read from the chain: the request already carries this choice (set
      // from another tab or app), so closing records it as set.
      readSet.current = true;
      return { kind: 'refused', refusal: { code: 'AlreadySet', reason: text('request.tariffAlreadySet'), reopensAt: null, remedy: null } };
    }
    return simulateCall(own, { address: diamond, abi: PROFILE, functionName: 'setOfferCreatorFullTariff', args: [offerId, true, choice.maxCStar, choice.allowDowngrade] });
  };

  const receipt: Receipt = {
    title: text('request.tariffArmTitle'),
    rows: [
      { label: text('request.rowTariffRequest'), value: { kind: 'text', text: format('request.tariffRequestId', { id: offerId.toString() }) }, binding: true },
      {
        label: text('request.rowTariffCeiling'),
        value: { kind: 'text', text: format('request.tariffVpfi', { amount: formatUnits(choice.maxCStar, VPFI_DECIMALS) }) },
        binding: true,
      },
      { label: text('request.rowTariffFail'), value: { kind: 'text', text: text(choice.allowDowngrade ? 'request.tariffFailOpen' : 'request.tariffFailRefuse') }, binding: true },
    ],
    consequences: [text('request.loseTariffPaid'), text('request.loseTariffArmGap'), text('request.loseTariffChecked')],
    prompts: 1,
    readAt,
  };

  /** An unknown or skipped ending is checked by reading the request back
   *  from its own network: a match sets the ending to armed; anything else
   *  is stated as read, with its time, and never settles the ending on its
   *  own, since a transaction still pending can still set the tariff. */
  const readBack = async () => {
    if (identity !== ctx.identity) {
      setReadNote({ kind: 'switch' });
      return;
    }
    setReadNote({ kind: 'reading' });
    const asked = ++readSeq.current;
    // A read answered after the ending was dismissed, or after another read
    // was started, is dropped: it would speak for a step no longer shown.
    const stale = () => !mounted.current || asked !== readSeq.current;
    try {
      const now = (await own.read((c) => readOfferTariff(c, diamond, offerId))).value;
      if (stale()) return;
      if (now.creator.toLowerCase() === account.toLowerCase() && tariffMatches(now.stored, choice)) {
        setReadNote(null);
        setEnded('armed');
        return;
      }
      setReadNote({ kind: now.accepted ? 'taken' : 'not-yet', at: Date.now() });
    } catch (e) {
      if (stale()) return;
      setReadNote({ kind: 'failed', reason: refusalFromError(e).reason });
    }
  };

  if (ended !== null) {
    const id = offerId.toString();
    return (
      <section className="arm-tariff" data-testid="request-tariff-ended" data-ending={ended}>
        <Notice tone={ended === 'armed' ? 'ok' : 'warn'} tier="A">
          {format(ENDING_KEYS[ended], { id })}
        </Notice>
        {(ended === 'unknown' || ended === 'skipped') && (
          <>
            {readNote !== null && (
              <p className="tier-a" role="status" data-testid="request-tariff-read">
                {readNote.kind === 'reading'
                  ? text('request.tariffReadingBack')
                  : readNote.kind === 'switch'
                    ? format('request.tariffReadSwitch', { id })
                    : readNote.kind === 'failed'
                      ? format('request.tariffReadFailed', { reason: readNote.reason })
                      : format(readNote.kind === 'taken' ? 'request.tariffReadTaken' : ended === 'skipped' ? 'request.tariffReadNotSet' : 'request.tariffReadNotYet', {
                          id,
                          time: new Date(readNote.at).toLocaleTimeString(),
                        })}
              </p>
            )}
            <p className="actions">
              <button type="button" className="btn" disabled={readNote?.kind === 'reading'} onClick={() => void readBack()}>
                {text('request.tariffReadAgain')}
              </button>
            </p>
          </>
        )}
        <p className="actions">
          <button
            type="button"
            className="btn"
            onClick={() => {
              readSeq.current += 1;
              setEnded(null);
              setArmedFor(null);
              onDone();
            }}
          >
            {text('flow.close')}
          </button>
        </p>
      </section>
    );
  }

  return (
    <section className="arm-tariff" data-testid="request-tariff-arm" aria-labelledby="arm-tariff-title">
      <h3 id="arm-tariff-title">{text('request.tariffArmTitle')}</h3>
      <p className="tier-b">{text('request.tariffArmLead')}</p>
      {!routed.ok && <p className="tier-b">{routed.reason}</p>}
      <ActionFlow
        tx={tx}
        identity={identity}
        reviewedFor={ctx.identity}
        receipt={receipt}
        recheck={recheck}
        describeAsset={() => null}
        explorer={chain?.blockExplorer ?? ''}
        next={null}
        onClose={() => setEnded(armEnding(lastPhase.current, readSet.current))}
      />
    </section>
  );
}
