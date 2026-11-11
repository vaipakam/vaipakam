import { useState, type ReactNode } from 'react';
import { useConfig } from 'wagmi';
import { useMode } from '../../app/ModeContext';
import { getSupportedChain, type SupportedChain } from '../../chain/chains';
import type { OwnStateClient } from '../../chain/ownRail';
import { selectorOf, useCapabilities } from '../capability/CapabilityContext';
import { readFeeDiscountConsent, VPFI_DISCOUNT_ABI } from '../consent/feeDiscount';
import { useCopy } from '../copy/useCopy';
import { SWITCH_EFFECTS } from '../eligibility/switchClasses';
import { WhyLink } from '../help/WhyLink';
import { useChainRead } from '../reads/chainRead';
import { readPosture, usePosture } from '../reads/posture';
import { useOwnRead } from '../reads/useOwnRead';
import { figured, textValue, type Receipt } from '../receipt/types';
import { sendWrite } from '../tx/send';
import { simulateCall } from '../tx/simulate';
import { holdsFlow } from '../tx/txStore';
import { useTrackedTx } from '../tx/useTrackedTx';
import { ActionFlow, reviewIdentity, type Recheck } from '../ui/ActionFlow';
import { formatExact, formatFigureText, formatUtc } from '../ui/format';
import { Notice } from '../ui/Notice';
import { OwnStamp } from '../ui/OwnStamp';
import { cappedBps, discountPercent } from './tiers';
import {
  BROADCAST_ABI,
  laneStanding,
  paidByCaller,
  paidSend,
  readTierPush,
  recordStanding,
  tierPushSupport,
  type PaidSend,
  type TierPushCard,
} from './tierPush';
import { readVpfiHome } from './vpfiFacts';

type Hex = `0x${string}`;

/** What a review was built from, with the wallet and network it was read
 *  under (RB-REVIEW). */
type Reviewed =
  | { kind: 'update'; now: { tier: number; bps: bigint } | null; readAt: number; identity: string }
  | { kind: 'send'; card: TierPushCard; send: PaidSend; readAt: number; identity: string };

const NATIVE_DECIMALS = 18;

/** When a review's inputs were read (an event handler's clock, never a
 *  render's). */
const readNow = () => Date.now();

/**
 * RW-11, RW-13, RW-14 — the wallet's fee-discount tier on the protocol's other networks
 * (#3579), on the Rewards page under the tier card.
 *
 * On VPFI's home network: the tier recorded for sending, whether it is
 * behind the tier the protocol applies now, and for each other network
 * what it last received and whether it is up to date, owed a lower tier
 * the protocol sends at its own cost, or owed a tier that goes only with a
 * paid send, with the fee the messenger quotes now. Two steps: update the
 * record (`pokeMyTier`, gas only) and send the record to every owed
 * network (`deliverTierPush`, paying the quoted fees plus a margin; what is
 * not used comes back in the same transaction). Elsewhere: one line saying
 * a higher tier is sent from the home network. A Diamond that predates the
 * rule (#1277) is said so, never read in its older shape.
 *
 * Nothing is worked out here: every figure is the protocol's or the
 * messenger's own answer. Nothing pays for holding VPFI (RL-6).
 */
export function TierElsewhere({ chain, own }: { chain: SupportedChain; own: OwnStateClient }) {
  const { text, format } = useCopy();
  const { mode } = useMode();
  const config = useConfig();
  const diamond = chain.diamondAddress as Hex;
  const account = own.account as Hex;
  const { caps } = useCapabilities();
  const support = tierPushSupport(caps?.routedSelectors ?? null, selectorOf);
  const home = useChainRead(['vpfiHome', diamond], (c) => readVpfiHome(c, diamond), { immutable: true });
  const enabled = support === 'present' && home.data === true;
  const card = useOwnRead(['rewards', 'tierPush', diamond], (c) => readTierPush(c, diamond, account), { enabled, perBlock: true });
  const consent = useOwnRead(['feeDiscountConsent', diamond], (c) => readFeeDiscountConsent(c, diamond, account), { enabled });
  const posture = usePosture(diamond);
  const [reviewed, setReviewed] = useState<Reviewed | null>(null);
  const symbol = chain.nativeGasSymbol;
  const native = (v: bigint, exact = false) => (exact ? formatExact(v, NATIVE_DECIMALS) : formatFigureText(v, NATIVE_DECIMALS));
  const networkName = (id: number) => getSupportedChain(id)?.name ?? format('rewardsElsewhere.network', { id: String(id) });

  const update = useTrackedTx({
    key: 'rewards.tierUpdate',
    chainId: chain.chainId,
    account,
    sources: own.sources,
    send: () => sendWrite(config, { address: diamond, abi: VPFI_DISCOUNT_ABI, functionName: 'pokeMyTier', args: [], chainId: chain.chainId, account }),
    measure: async (_receipt, at) => {
      const after = await at.read((c, b) => readTierPush(c, diamond, account, b.blockNumber));
      const label = text('rewardsElsewhere.legRecorded');
      const standing = recordStanding(after);
      if (standing === 'same') return [{ status: 'done', label }];
      if (standing === 'unknown') return [{ status: 'unknown', label, reason: text('rewardsElsewhere.nowUnread') }];
      return [{ status: 'not-done', label, reason: text('rewardsElsewhere.legRecordedMissing') }];
    },
  });

  const sendValue = reviewed?.kind === 'send' ? reviewed.send.value : 0n;
  const deliver = useTrackedTx({
    key: 'rewards.tierSend',
    chainId: chain.chainId,
    account,
    sources: own.sources,
    send: () =>
      sendWrite(config, {
        address: diamond,
        abi: BROADCAST_ABI,
        functionName: 'deliverTierPush',
        args: [account],
        value: sendValue,
        chainId: chain.chainId,
        account,
      }),
    measure: async (receipt, at) => {
      const r = reviewed?.kind === 'send' ? reviewed : null;
      const status = await at.read((c, b) => readTierPush(c, diamond, account, b.blockNumber));
      const ids = r ? r.send.chainIds : status.lanes.map((l) => l.chainId);
      const nonce = r ? r.card.recorded.nonce : status.recorded.nonce;
      const legs = ids.map((id) => {
        const lane = status.lanes.find((l) => l.chainId === id);
        const label = format('rewardsElsewhere.legSent', { chain: networkName(id) });
        if (!lane) return { status: 'unknown' as const, label, reason: format('rewardsElsewhere.legOwed', { chain: networkName(id) }) };
        return lane.delivered.nonce >= nonce
          ? { status: 'done' as const, label }
          : { status: 'not-done' as const, label, reason: format('rewardsElsewhere.legOwed', { chain: networkName(id) }) };
      });
      const paid = paidByCaller(receipt, diamond, account);
      const sent = r ? r.send.value : null;
      if (sent !== null) {
        legs.push({ status: 'done', label: format('rewardsElsewhere.legPaid', { paid: native(paid, true), back: native(sent - paid, true), symbol }) });
      }
      return legs;
    },
  });

  if (support === 'absent' || home.data === false) {
    if (home.data !== false) return null;
    return (
      <section className="home-section" aria-labelledby="rewards-elsewhere-title" data-testid="rewards-elsewhere" data-elsewhere="away">
        <h2 id="rewards-elsewhere-title">{text('rewardsElsewhere.title')}</h2>
        <p className="tier-b">{text('rewardsElsewhere.away')}</p>
      </section>
    );
  }

  const head = (
    <>
      <h2 id="rewards-elsewhere-title">{text('rewardsElsewhere.title')}</h2>
      <WhyLink summaryKey="rewardsElsewhere.lead" detailKey="rewardsElsewhere.why" />
    </>
  );
  const shell = (state: string, body: ReactNode) => (
    <section className="home-section" aria-labelledby="rewards-elsewhere-title" data-testid="rewards-elsewhere" data-elsewhere={state}>
      {head}
      {body}
    </section>
  );
  if (support === 'unknown') return shell('checking', <p className="tier-b">{text('rewardsElsewhere.checking')}</p>);
  if (support === 'predates') return shell('predates', <p className="tier-b">{text('rewardsElsewhere.predates')}</p>);
  if (home.data === null) {
    return home.state === 'failed'
      ? shell('home-unread', <p className="tier-a">{text('rewardsElsewhere.homeUnread')}</p>)
      : shell('checking', <p className="tier-b">{text('rewardsElsewhere.reading')}</p>);
  }

  const data = card.data;
  if (data === null) {
    return shell(
      card.state === 'failed' ? 'failed' : 'reading',
      card.state === 'failed' ? (
        <p className="tier-a" data-testid="rewards-elsewhere-failed">
          {format('rewardsElsewhere.failed', { reason: card.error ?? 'no answer' })}
        </p>
      ) : (
        <p className="tier-b">{text('rewardsElsewhere.reading')}</p>
      ),
    );
  }

  const identity = reviewIdentity(own);
  const standing = recordStanding(data);
  const plan = paidSend(data.lanes);
  const rec = data.recorded;

  const startUpdate = () => {
    setReviewed({ kind: 'update', now: data.effective, readAt: readNow(), identity });
    if (update.phase.kind !== 'idle') update.reset();
    update.review();
  };
  const startSend = () => {
    if (typeof plan === 'string') return;
    setReviewed({ kind: 'send', card: data, send: plan, readAt: readNow(), identity });
    if (deliver.phase.kind !== 'idle') deliver.reset();
    deliver.review();
  };
  const close = () => setReviewed(null);

  const paused = async (): Promise<Recheck | null> => {
    const p = await own.read((c) => readPosture(c, diamond));
    if (p.value.paused) {
      return {
        kind: 'refused',
        refusal: { code: 'EnforcedPause', reason: format('consent.paused', { staysOpen: SWITCH_EFFECTS['2'].staysOpen }), reopensAt: null, remedy: null },
      };
    }
    return null;
  };

  const recheckUpdate = async (): Promise<Recheck> => {
    const refused = await paused();
    if (refused) return refused;
    return simulateCall(own, { address: diamond, abi: VPFI_DISCOUNT_ABI, functionName: 'pokeMyTier', args: [] });
  };

  // RB-REVIEW: the record, the owed networks and their fees read again,
  // then the send simulated as the sender with the reviewed value.
  const recheckSend = async (current: () => boolean): Promise<Recheck> => {
    if (reviewed?.kind !== 'send') return { kind: 'unreadable', reason: text('flow.reading') };
    const refused = await paused();
    if (refused) return refused;
    const now = (await own.read((c) => readTierPush(c, diamond, account))).value;
    // A review that no longer matches what a send would carry, or that has
    // nothing left to send, is not refreshed in place: it is closed to
    // signing, and the reader starts again from the section.
    const obsolete = (code: string, reason: string): Recheck => ({ kind: 'refused', refusal: { code, reason, reopensAt: null, remedy: null } });
    if (recordStanding(now) !== 'same' || now.recorded.nonce !== reviewed.card.recorded.nonce)
      return obsolete('TierRecordMoved', text('rewardsElsewhere.staleRecord'));
    const next = paidSend(now.lanes);
    if (next === 'nothing-owed') return obsolete('TierNothingOwed', text('rewardsElsewhere.staleNothingOwed'));
    if (next === 'unquoted') return obsolete('TierFeeUnquoted', text('rewardsElsewhere.sendUnquoted'));
    const sameNetworks = next.chainIds.join(',') === reviewed.send.chainIds.join(',');
    if (!sameNetworks || next.quoted > reviewed.send.value) {
      if (current()) setReviewed({ ...reviewed, card: now, send: next, readAt: readNow() });
      return { kind: 'changed', what: text('rewardsElsewhere.changedFees') };
    }
    return simulateCall(own, { address: diamond, abi: BROADCAST_ABI, functionName: 'deliverTierPush', args: [account], value: reviewed.send.value });
  };

  const updateReceipt = (r: Extract<Reviewed, { kind: 'update' }>): Receipt => ({
    title: text('rewardsElsewhere.titleUpdate'),
    rows: [
      {
        label: text('rewardsElsewhere.rowRecord'),
        value: {
          kind: 'text',
          text:
            r.now === null
              ? text('rewardsElsewhere.recordValueUnread')
              : format('rewardsElsewhere.recordValue', { tier: String(r.now.tier), discount: discountPercent(cappedBps(r.now.bps)) }),
        },
        binding: false,
      },
      { label: text('rewardsElsewhere.rowSends'), value: { kind: 'text', text: text('rewardsElsewhere.updateSends') }, binding: false },
      { label: text('rewardsElsewhere.rowCost'), value: { kind: 'text', text: text('rewardsElsewhere.updateCost') }, binding: false },
    ],
    consequences: consent.data === false ? [text('rewardsElsewhere.consentOff')] : [],
    prompts: 1,
    readAt: r.readAt,
  });

  const sendReceipt = (r: Extract<Reviewed, { kind: 'send' }>): Receipt => ({
    title: text('rewardsElsewhere.titleSend'),
    rows: [
      {
        label: text('rewardsElsewhere.rowCarries'),
        value: {
          kind: 'text',
          text: format('rewardsElsewhere.carriesValue', { tier: String(r.card.recorded.tier), discount: discountPercent(cappedBps(r.card.recorded.bps)) }),
        },
        binding: true,
      },
      { label: text('rewardsElsewhere.rowTo'), value: { kind: 'text', text: r.send.chainIds.map(networkName).join(', ') }, binding: true },
      {
        label: text('rewardsElsewhere.rowValue'),
        value: textValue(figured((exact) => format('rewardsElsewhere.valueText', { value: native(r.send.value, exact), symbol }))),
        binding: true,
        movesOut: true,
      },
      { label: text('rewardsElsewhere.rowQuoted'), value: textValue(figured((exact) => `${native(r.send.quoted, exact)} ${symbol}`)), binding: false },
      { label: text('rewardsElsewhere.rowBack'), value: { kind: 'text', text: text('rewardsElsewhere.backValue') }, binding: false },
    ],
    consequences: [text('rewardsElsewhere.loseFee'), text('rewardsElsewhere.loseRise')],
    prompts: 1,
    readAt: r.readAt,
  });

  const flowOpen = reviewed !== null || holdsFlow(update.phase) || holdsFlow(deliver.phase);
  const updateOpen = reviewed?.kind === 'update' || (reviewed === null && holdsFlow(update.phase));
  const sendOpen = reviewed?.kind === 'send' || (reviewed === null && !updateOpen && holdsFlow(deliver.phase));

  const routedSteps = caps?.routedSelectors?.has(selectorOf('pokeMyTier()')) === true;
  const postureKnown = posture.state === 'ready' && posture.error === null && posture.data !== null;
  let actions: ReactNode = null;
  // With no other network set up there is nothing to send to, and an update
  // records nothing (the protocol records only where it can send).
  if (!routedSteps || data.lanes.length === 0) actions = null;
  else if (!postureKnown) {
    actions =
      posture.state === 'reading' ? (
        <p className="tier-b">{text('action.withheld')}</p>
      ) : (
        <Notice tone="warn" tier="A">
          {format('rewardsElsewhere.postureUnknown', { reason: posture.error ?? 'no answer' })}
        </Notice>
      );
  } else if (posture.data!.paused) {
    actions = (
      <Notice tone="danger" tier="A">
        {text('rewardsElsewhere.paused')}
      </Notice>
    );
  } else {
    const sendBlock =
      plan === 'nothing-owed' ? null : standing !== 'same' ? (
        <p className="tier-b" data-testid="rewards-elsewhere-send-after-update">
          {text('rewardsElsewhere.sendAfterUpdate')}
        </p>
      ) : plan === 'unquoted' ? (
        <p className="tier-a" data-testid="rewards-elsewhere-unquoted">
          {text('rewardsElsewhere.sendUnquoted')}
        </p>
      ) : (
        <p className="tier-b">{format('rewardsElsewhere.sendHint', { fee: native(plan.quoted), symbol })}</p>
      );
    const canSend = typeof plan !== 'string' && standing === 'same';
    actions = (
      <>
        {sendBlock}
        <div className="form-actions">
          {canSend && (
            <button type="button" className="btn btn-primary" onClick={startSend} disabled={flowOpen} data-testid="rewards-elsewhere-send">
              {text('rewardsElsewhere.send')}
            </button>
          )}
          <button
            type="button"
            className={standing === 'behind' ? 'btn btn-primary' : 'btn'}
            onClick={startUpdate}
            disabled={flowOpen}
            data-testid="rewards-elsewhere-update"
          >
            {text('rewardsElsewhere.update')}
          </button>
        </div>
      </>
    );
  }

  return shell(
    'shown',
    <>
      <div data-testid="rewards-elsewhere-record" data-record={standing} data-tier={rec.nonce === 0n ? '' : rec.tier}>
        <p className="tier-b">
          {rec.nonce === 0n
            ? text('rewardsElsewhere.recordedNone')
            : format('rewardsElsewhere.recorded', { tier: String(rec.tier), discount: discountPercent(cappedBps(rec.bps)) })}
        </p>
        {standing === 'behind' && data.effective !== null && data.lanes.length > 0 && (
          <p className="tier-a" data-testid="rewards-elsewhere-behind">
            {format('rewardsElsewhere.behind', { tier: String(data.effective.tier), discount: discountPercent(cappedBps(data.effective.bps)) })}
          </p>
        )}
        {standing === 'unknown' && data.lanes.length > 0 && <p className="tier-a">{text('rewardsElsewhere.nowUnread')}</p>}
        {consent.data === false && <p className="tier-a">{text('rewardsElsewhere.consentOff')}</p>}
        {mode === 'advanced' && rec.nonce !== 0n && (
          <dl className="facts">
            <dt className="tier-b">{text('rewardsElsewhere.factRecordNo')}</dt>
            <dd>{rec.nonce.toString()}</dd>
            <dt className="tier-b">{text('rewardsElsewhere.factVersion')}</dt>
            <dd>{String(rec.version)}</dd>
            <dt className="tier-b">{text('rewardsElsewhere.factExpires')}</dt>
            <dd>{rec.expiresAt === null ? text('rewardsElsewhere.factNoExpiry') : formatUtc(rec.expiresAt)}</dd>
          </dl>
        )}
      </div>
      {data.lanes.length === 0 ? (
        <p className={data.destinations === 'unreadable' ? 'tier-a' : 'tier-b'} data-testid="rewards-elsewhere-none" data-destinations={data.destinations}>
          {text(
            data.destinations === 'unreadable'
              ? 'rewardsElsewhere.listUnreadable'
              : data.destinations === 'no-messenger'
                ? 'rewardsElsewhere.noMessenger'
                : 'rewardsElsewhere.noLanes',
          )}
        </p>
      ) : (
        <>
          <p className="tier-a" data-testid="rewards-elsewhere-sent-only">
            {text('rewardsElsewhere.lanesSentOnly')}
          </p>
          <ul className="rows" data-testid="rewards-elsewhere-lanes">
            {data.lanes.map((l) => {
              const s = laneStanding(l);
              const d = l.delivered;
              return (
                <li key={l.chainId} className="card" data-testid="rewards-elsewhere-lane" data-chain={l.chainId} data-standing={s}>
                  <p className="row-head">{networkName(l.chainId)}</p>
                  <p className="tier-b">
                    {d.nonce === 0n && d.sentAt === 0
                      ? text('rewardsElsewhere.laneNothing')
                      : format('rewardsElsewhere.laneHolds', { tier: String(d.tier), discount: discountPercent(cappedBps(d.bps)), sent: formatUtc(d.sentAt) })}
                  </p>
                  {s === 'current' && <p className="tier-b">{text('rewardsElsewhere.laneCurrent')}</p>}
                  {s === 'protocol-pays' && <p className="tier-a">{text('rewardsElsewhere.laneProtocol')}</p>}
                  {s === 'needs-paid-send' && <p className="tier-a">{format('rewardsElsewhere.lanePaid', { tier: String(rec.tier) })}</p>}
                  {l.owed && l.fee !== null && <p className="tier-b">{format('rewardsElsewhere.laneFee', { fee: native(l.fee), symbol })}</p>}
                  {l.owed && l.fee === null && <p className="tier-a">{text('rewardsElsewhere.laneFeeUnread')}</p>}
                  {mode === 'advanced' && d.nonce !== 0n && (
                    <dl className="facts">
                      <dt className="tier-b">{text('rewardsElsewhere.factRecordNo')}</dt>
                      <dd>{d.nonce.toString()}</dd>
                      <dt className="tier-b">{text('rewardsElsewhere.factVersion')}</dt>
                      <dd>{String(d.version)}</dd>
                      <dt className="tier-b">{text('rewardsElsewhere.factExpires')}</dt>
                      <dd>{d.expiresAt === null ? text('rewardsElsewhere.factNoExpiry') : formatUtc(d.expiresAt)}</dd>
                    </dl>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
      <OwnStamp reads={[card]} />
      {!flowOpen && actions}
      {updateOpen && (
        <ActionFlow
          tx={update}
          identity={identity}
          reviewedFor={reviewed?.identity ?? update.frozen?.identity ?? ''}
          receipt={reviewed?.kind === 'update' ? updateReceipt(reviewed) : null}
          recheck={recheckUpdate}
          describeAsset={() => null}
          explorer={chain.blockExplorer}
          next={null}
          onClose={close}
        />
      )}
      {sendOpen && (
        <ActionFlow
          tx={deliver}
          identity={identity}
          reviewedFor={reviewed?.identity ?? deliver.frozen?.identity ?? ''}
          receipt={reviewed?.kind === 'send' ? sendReceipt(reviewed) : null}
          recheck={recheckSend}
          describeAsset={() => null}
          explorer={chain.blockExplorer}
          next={null}
          onClose={close}
        />
      )}
    </>,
  );
}
