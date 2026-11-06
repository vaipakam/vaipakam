import { useEffect, useRef, useState } from 'react';
import { useConfig } from 'wagmi';
import { writeContract } from 'wagmi/actions';
import { formatUnits } from 'viem';
import type { OwnStateClient } from '../../../chain/ownRail';
import type { SupportedChain } from '../../../chain/chains';
import { requireSelector } from '../../../shared/capability/types';
import { selectorOf, useCapabilities } from '../../../shared/capability/CapabilityContext';
import { useCopy } from '../../../shared/copy/useCopy';
import { refusalFromError } from '../../../shared/eligibility/refusal';
import { PROFILE, readOfferTariff, SET_TARIFF_SIGNATURE, tariffMatches, VPFI_DECIMALS, type TariffChoice } from '../../../shared/offers/fullTariff';
import type { Receipt } from '../../../shared/receipt/types';
import { simulateCall } from '../../../shared/tx/simulate';
import { useStoredValue } from '../../../shared/tx/txStore';
import { useTrackedTx } from '../../../shared/tx/useTrackedTx';
import { ActionFlow, reviewIdentity, type Recheck } from '../../../shared/ui/ActionFlow';
import { Notice } from '../../../shared/ui/Notice';
import { REQUEST_KEY } from './RequestForm';

/** The arm step's own tracked transaction, beside the request's. */
export const TARIFF_KEY = `${REQUEST_KEY}:tariff`;

interface ArmTariffProps {
  chain: SupportedChain;
  own: OwnStateClient;
  /** The request the posting measured. */
  offerId: bigint;
  choice: TariffChoice;
}

/**
 * OFF-22 — arms the Full fee tariff on a request just posted: the creator's
 * opt-in is its own transaction (`setOfferCreatorFullTariff`), sent after
 * posting and refused by the protocol once a lender has taken the request.
 * It opens under the request's finish card with its own receipt, re-reads
 * the request before the wallet opens (taken, not the creator, already set),
 * simulates the call, and measures by reading the request back. Until it
 * confirms, a lender who takes the request opens a loan without the tariff;
 * that gap is stated here and in the request's review.
 */
export function ArmTariff({ chain, own, offerId, choice }: ArmTariffProps) {
  const copy = useCopy();
  const { text, format } = copy;
  const config = useConfig();
  const diamond = chain.diamondAddress;
  const account = own.account;
  const identity = reviewIdentity(own);
  const { caps } = useCapabilities();
  const routed = requireSelector(caps, selectorOf(SET_TARIFF_SIGNATURE), text('request.tariffCapabilityName'));
  /** The request this arm step belongs to: a step kept for an earlier
   *  request is started again for this one. */
  const [armedFor, setArmedFor] = useStoredValue<bigint>(`${TARIFF_KEY}:for`);
  const [closed, setClosed] = useState(false);
  const [readAt] = useState(() => Date.now());

  const tx = useTrackedTx({
    key: TARIFF_KEY,
    chainId: chain.chainId,
    account,
    sources: own.sources,
    send: () =>
      writeContract(config, {
        address: diamond,
        abi: PROFILE,
        functionName: 'setOfferCreatorFullTariff',
        args: [offerId, true, choice.maxCStar, choice.allowDowngrade],
        chainId: chain.chainId,
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
  const opened = useRef<bigint | null>(null);
  useEffect(() => {
    if (opened.current === offerId) return;
    opened.current = offerId;
    if (armedFor !== offerId) {
      setArmedFor(offerId);
      if (tx.phase.kind !== 'idle') tx.reset();
      tx.review();
    } else if (tx.phase.kind === 'idle') {
      tx.review();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offerId]);

  const recheck = async (): Promise<Recheck> => {
    if (!routed.ok) return { kind: 'refused', refusal: { code: 'NotRouted', reason: routed.reason, reopensAt: null, remedy: null } };
    let now;
    try {
      now = (await own.read((c) => readOfferTariff(c, diamond, offerId))).value;
    } catch (e) {
      return { kind: 'unreadable', reason: refusalFromError(e).reason };
    }
    if (now.creator.toLowerCase() !== account.toLowerCase())
      return { kind: 'refused', refusal: { code: 'NotCreator', reason: text('request.tariffNotCreator'), reopensAt: null, remedy: null } };
    if (now.accepted) return { kind: 'refused', refusal: { code: 'OfferAlreadyAccepted', reason: text('request.tariffArmTaken'), reopensAt: null, remedy: null } };
    if (tariffMatches(now.stored, choice)) return { kind: 'refused', refusal: { code: 'AlreadySet', reason: text('request.tariffAlreadySet'), reopensAt: null, remedy: null } };
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

  if (closed && tx.phase.kind !== 'measured') {
    return (
      <Notice tone="warn" tier="A">
        <span data-testid="request-tariff-skipped">{text('request.tariffSkipped')}</span>
      </Notice>
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
        reviewedFor={tx.frozen?.identity ?? identity}
        receipt={receipt}
        recheck={recheck}
        describeAsset={() => null}
        explorer={chain.blockExplorer}
        next={null}
        onClose={() => setClosed(true)}
      />
    </section>
  );
}
