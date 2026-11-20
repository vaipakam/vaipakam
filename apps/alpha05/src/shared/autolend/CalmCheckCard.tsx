import { useState } from 'react';
import { useConfig } from 'wagmi';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useCopy, type CopyKey } from '../copy/useCopy';
import { refusalFromError, StatedRefusal } from '../eligibility/refusal';
import type { IntentSummary } from '../offers/intents';
import type { Receipt, ReceiptRow } from '../receipt/types';
import { assetName, type TokenMetaMap } from '../reads/tokens';
import { useOwnRead } from '../reads/useOwnRead';
import { sendWrite } from '../tx/send';
import { askThrough } from '../tx/simulate';
import { useStoredValue } from '../tx/txStore';
import { useTrackedTx } from '../tx/useTrackedTx';
import { ActionFlow, reviewIdentity, type Recheck } from '../ui/ActionFlow';
import { calmCheckCall, calmLogs, calmPaused, readCalmStatus, type CalmStatus } from './calmCheck';

interface CalmCheckCardProps {
  intent: IntentSummary;
  chain: SupportedChain;
  own: OwnStateClient;
  meta: TokenMetaMap | null;
}

const STATUS_TEXT: Record<CalmStatus, CopyKey> = {
  off: 'autoLend.calmOff',
  clear: 'autoLend.calmClear',
  'no-checkpoint': 'autoLend.calmNoCheckpoint',
  moving: 'autoLend.calmMoving',
  unpriced: 'autoLend.calmUnpriced',
};

/**
 * On an active Auto-lend, where its pause for a moving price stands now, read
 * from the protocol's own answer for the slot: steady, paused and why, or
 * switched off. A paused slot says so and why, so a slot that is not lending
 * is never a silent "no matches". The owner switches the pause off or back on
 * through a review of the one call, dry-run from the wallet before and again
 * right before signing, and measured from the transaction's own log.
 */
export function CalmCheckCard({ intent, chain, own, meta }: CalmCheckCardProps) {
  const { text, format } = useCopy();
  const config = useConfig();
  const diamond = chain.diamondAddress;
  const account = own.account;
  const i = intent;
  const key = `autolend.calm.${i.lendingAsset.toLowerCase()}.${i.collateralAsset.toLowerCase()}.${i.slot}`;
  const status = useOwnRead(['autolend', 'calm', i.lendingAsset.toLowerCase(), i.collateralAsset.toLowerCase(), String(i.slot)], (c) =>
    readCalmStatus(c, diamond, account, i.lendingAsset, i.collateralAsset, i.slot),
  );
  /** The setting under review (true = switch on), kept with the flow. */
  const [target, setTarget] = useStoredValue<boolean>(`${key}:target`);
  /** The wallet and network the review was opened for, kept with it: a
   *  review opened for one wallet is never sent for another. */
  const [openedFor, setOpenedFor] = useStoredValue<string>(`${key}:openedFor`);
  const [readAt, setReadAt] = useState(() => Date.now());
  const identity = reviewIdentity(own);
  const on = target ?? true;

  const ask = async (want: boolean) => {
    const call = calmCheckCall(i.lendingAsset, i.collateralAsset, i.slot, want);
    return { call, asked: await askThrough(own, (cl) => cl.simulateContract({ address: diamond, ...call, account })) };
  };

  const tx = useTrackedTx({
    key,
    chainId: chain.chainId,
    account,
    sources: own.sources,
    send: async () => {
      const { call, asked } = await ask(on);
      if (asked.kind === 'reverted') {
        const r = refusalFromError(asked.error);
        throw new StatedRefusal({ code: r.code, reason: format('autoLend.calmRefused', { reason: r.reason }), reopensAt: null, remedy: null });
      }
      if (asked.kind === 'unreadable') throw new StatedRefusal({ code: 'Unreadable', reason: format('flow.unreadable', { reason: asked.reason }), reopensAt: null, remedy: null });
      return sendWrite(config, { address: diamond, ...call, chainId: chain.chainId, account });
    },
    unwind: async () => null,
    measure: async (receipt) => {
      const got = calmLogs(receipt.logs, diamond, account, i.lendingAsset, i.collateralAsset, i.slot);
      const label = text(on ? 'autoLend.legCalmOn' : 'autoLend.legCalmOff');
      return [got === on ? { status: 'done', label } : { status: 'not-done', label, reason: text('autoLend.legCalmMissing') }];
    },
  });

  const close = () => {
    setTarget(null);
    setOpenedFor(null);
    tx.reset();
    status.refetch();
  };

  if (target !== null) {
    const rows: ReceiptRow[] = [
      {
        label: text('autoLend.rowWhat'),
        value: { kind: 'text', text: format('autoLend.whatValue', { lend: assetName(i.lendingAsset, meta), coll: assetName(i.collateralAsset, meta) }) },
        binding: true,
      },
      { label: text('autoLend.calmTitle'), value: { kind: 'text', text: text(on ? 'autoLend.calmRowOn' : 'autoLend.calmRowOff') }, binding: true },
    ];
    const consequences = [text('autoLend.calmNoMoney'), text(on ? 'autoLend.calmLoseOn' : 'autoLend.calmLoseOff'), ...(on ? [] : [text('autoLend.calmLoseStop')])];
    const receipt: Receipt = { title: text('autoLend.calmTitle'), rows, consequences, prompts: 1, readAt };
    const recheck = async (): Promise<Recheck> => {
      try {
        const { asked } = await ask(on);
        if (asked.kind === 'reverted') return { kind: 'refused', refusal: refusalFromError(asked.error) };
        if (asked.kind === 'unreadable') return { kind: 'unreadable', reason: asked.reason };
        return { kind: 'ok' };
      } catch (e) {
        return { kind: 'unreadable', reason: refusalFromError(e).reason };
      }
    };
    return (
      <div className="autolend-calm-review" data-testid="autolend-calm-review">
        <ActionFlow
          tx={tx}
          identity={identity}
          reviewedFor={openedFor ?? tx.frozen?.identity ?? identity}
          receipt={receipt}
          recheck={recheck}
          describeAsset={() => null}
          explorer={chain.blockExplorer}
          next={null}
          onClose={close}
        />
      </div>
    );
  }

  const s = status.data;
  const open = (want: boolean) => {
    setReadAt(Date.now());
    setOpenedFor(identity);
    setTarget(want);
    tx.review();
  };
  return (
    <div className="autolend-calm" data-testid="autolend-calm" data-status={s ?? 'unread'}>
      <p className="tier-b">{text('autoLend.calmTitle')}</p>
      {s === null ? (
        status.state === 'reading' ? null : (
          <p className="tier-a" data-testid="autolend-calm-status">
            {format('autoLend.calmUnread', { reason: status.error ?? '' })}
          </p>
        )
      ) : (
        <p className={calmPaused(s) || s === 'off' ? 'tier-a' : 'tier-b'} data-testid="autolend-calm-status">
          {text(STATUS_TEXT[s])}
        </p>
      )}
      {s !== null && s !== 'off' && <p className="tier-b">{text('autoLend.calmOffMeans')}</p>}
      {s !== null && (
        <button type="button" className="btn" onClick={() => open(s === 'off')} data-testid={s === 'off' ? 'autolend-calm-on' : 'autolend-calm-off'}>
          {text(s === 'off' ? 'autoLend.calmSwitchOn' : 'autoLend.calmSwitchOff')}
        </button>
      )}
    </div>
  );
}
