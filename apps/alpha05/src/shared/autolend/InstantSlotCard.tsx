import { useState } from 'react';
import { useConfig } from 'wagmi';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useCopy } from '../copy/useCopy';
import { refusalFromError, StatedRefusal } from '../eligibility/refusal';
import type { IntentSummary } from '../offers/intents';
import type { Receipt, ReceiptRow } from '../receipt/types';
import { assetName, type TokenMetaMap } from '../reads/tokens';
import { useOwnRead } from '../reads/useOwnRead';
import { readValidUntil } from '../tx/deadline';
import { sendWrite } from '../tx/send';
import { askThrough } from '../tx/simulate';
import { useStoredValue } from '../tx/txStore';
import { useTrackedTx } from '../tx/useTrackedTx';
import { ActionFlow, reviewIdentity, type Recheck } from '../ui/ActionFlow';
import { INSTANT_CHOICE_PRESELECTED, instantSlotCall, offersInstant, readInstantCardFacts, type InstantChoice } from './instantCard';
import { presetLogs } from './preset';

interface InstantSlotCardProps {
  intent: IntentSummary;
  active: boolean;
  chain: SupportedChain;
  own: OwnStateClient;
  meta: TokenMetaMap | null;
}

/**
 * #3761 §3.5 — on an Auto-lend that exists, one line offering the instant
 * market's consents, which nothing sets by itself. It opens a review of the
 * one call that sets them, dry-run from the wallet before and again right
 * before signing, and measured from the transaction's own log. Each consent
 * is pre-selected and can be switched off; renewal is stated as not
 * available yet.
 */
export function InstantSlotCard({ intent, active, chain, own, meta }: InstantSlotCardProps) {
  const copy = useCopy();
  const { text, format } = copy;
  const config = useConfig();
  const diamond = chain.diamondAddress;
  const account = own.account;
  const i = intent;
  const key = `autolend.instant.${i.lendingAsset.toLowerCase()}.${i.collateralAsset.toLowerCase()}.${i.slot}`;
  const facts = useOwnRead(['autolend', 'instantCard', i.lendingAsset.toLowerCase(), i.collateralAsset.toLowerCase(), String(i.slot)], (c) =>
    readInstantCardFacts(c, diamond, account, i.lendingAsset, i.collateralAsset, i.slot),
  );
  const [open, setOpen] = useStoredValue<boolean>(`${key}:open`);
  const [choice, setChoice] = useStoredValue<InstantChoice>(`${key}:choice`);
  /** The wallet and network the review was opened for, kept with it. */
  const [openedFor, setOpenedFor] = useStoredValue<string>(`${key}:openedFor`);
  const [readAt, setReadAt] = useState(() => Date.now());
  const picked = choice ?? INSTANT_CHOICE_PRESELECTED;
  const identity = reviewIdentity(own);

  const ask = async (c: InstantChoice) => {
    const deadline = await readValidUntil(own);
    const call = instantSlotCall(i.lendingAsset, i.collateralAsset, i.slot, c, deadline);
    return { call, asked: await askThrough(own, (cl) => cl.simulateContract({ address: diamond, ...call, account })) };
  };

  const tx = useTrackedTx({
    key,
    chainId: chain.chainId,
    account,
    sources: own.sources,
    send: async () => {
      const { call, asked } = await ask(picked);
      if (asked.kind === 'reverted') {
        const r = refusalFromError(asked.error);
        throw new StatedRefusal({ code: r.code, reason: format('autoLend.instantCardRefused', { reason: r.reason }), reopensAt: null, remedy: null });
      }
      if (asked.kind === 'unreadable') throw new StatedRefusal({ code: 'Unreadable', reason: format('flow.unreadable', { reason: asked.reason }), reopensAt: null, remedy: null });
      return sendWrite(config, { address: diamond, ...call, chainId: chain.chainId, account });
    },
    unwind: async () => null,
    measure: async (receipt) => {
      const got = presetLogs(receipt.logs, diamond, account, i.lendingAsset, i.collateralAsset, i.slot, null).instant;
      const label = text('autoLend.legInstant');
      return [
        got !== null && got.fills === picked.fills && got.takeover === picked.takeover && !got.renewal
          ? { status: 'done', label }
          : { status: 'not-done', label, reason: text('autoLend.legInstantMissing') },
      ];
    },
  });

  // An open review stays on screen through its finish, after the consents
  // it set take the line away.
  if (open !== true && !offersInstant(i, active, facts.data)) return null;

  const onOff = (on: boolean) => text(on ? 'autoLend.instantCardOn' : 'autoLend.instantSwitchedOff');
  const rows: ReceiptRow[] = [
    {
      label: text('autoLend.rowWhat'),
      value: { kind: 'text', text: format('autoLend.whatValue', { lend: assetName(i.lendingAsset, meta), coll: assetName(i.collateralAsset, meta) }) },
      binding: true,
    },
    { label: text('autoLend.rowFills'), value: { kind: 'text', text: onOff(picked.fills) }, binding: true },
    { label: text('autoLend.rowRenewal'), value: { kind: 'text', text: text('autoLend.renewalNotYetRow') }, binding: true },
    { label: text('autoLend.rowTakeover'), value: { kind: 'text', text: onOff(picked.takeover) }, binding: true },
  ];
  const consequences = [
    text('autoLend.instantCardNoMoney'),
    text('autoLend.loseInstantWhat'),
    ...(picked.takeover ? [text('autoLend.loseTakeover')] : []),
    text('autoLend.loseInstantReady'),
  ];
  const receipt: Receipt = { title: text('autoLend.instantCardTitle'), rows, consequences, prompts: 1, readAt };
  const none = !picked.fills && !picked.takeover;

  const recheck = async (): Promise<Recheck> => {
    try {
      const { asked } = await ask(picked);
      if (asked.kind === 'reverted') return { kind: 'refused', refusal: refusalFromError(asked.error) };
      if (asked.kind === 'unreadable') return { kind: 'unreadable', reason: asked.reason };
      return { kind: 'ok' };
    } catch (e) {
      return { kind: 'unreadable', reason: refusalFromError(e).reason };
    }
  };

  const close = () => {
    setOpen(null);
    setChoice(null);
    setOpenedFor(null);
    tx.reset();
    facts.refetch();
  };

  if (open !== true)
    return (
      <div className="autolend-instant-line" data-testid="autolend-instant-line">
        <p className="tier-b">{text('autoLend.instantCardLine')}</p>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setReadAt(Date.now());
            setOpenedFor(identity);
            setOpen(true);
            tx.review();
          }}
          data-testid="autolend-instant-open"
        >
          {text('autoLend.instantCardOpen')}
        </button>
      </div>
    );

  const gate = {
    ready: !none,
    node: (
      <div className="accept-gate">
        <fieldset className="choice-group" disabled={tx.phase.kind !== 'review'}>
          <legend className="sr-only">{text('autoLend.instantCardTitle')}</legend>
          <label>
            <input type="checkbox" checked={picked.fills} onChange={(e) => setChoice({ ...picked, fills: e.target.checked })} data-testid="autolend-instant-fills" />
            <span>{text('autoLend.rowFills')}</span>
          </label>
          <label>
            <input type="checkbox" checked={picked.takeover} onChange={(e) => setChoice({ ...picked, takeover: e.target.checked })} data-testid="autolend-instant-takeover" />
            <span>{text('autoLend.rowTakeover')}</span>
          </label>
        </fieldset>
        {none && <p className="tier-b">{text('autoLend.instantCardNone')}</p>}
      </div>
    ),
  };

  return (
    <div className="autolend-instant-review" data-testid="autolend-instant-review">
      <ActionFlow
        tx={tx}
        identity={identity}
        reviewedFor={openedFor ?? tx.frozen?.identity ?? identity}
        receipt={receipt}
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
