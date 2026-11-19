/**
 * #3721 — a position token approved for transfer to another address, said on
 * the position it belongs to. Whoever holds the approval can move the token,
 * and the position's payouts follow the token, so the page names the whole
 * address and offers the token's holder the one step that removes it:
 * `approve(0x0, tokenId)` on the position token, dry-run before the review
 * and again right before signing, and measured from the transaction's own
 * `Approval` log. The receipt refreshes the page's own reads.
 */
import { useState } from 'react';
import { parseEventLogs, zeroAddress, type Log } from 'viem';
import { useConfig } from 'wagmi';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useCopy } from '../copy/useCopy';
import { refusalFromError, StatedRefusal } from '../eligibility/refusal';
import type { Receipt } from '../receipt/types';
import { sendWrite } from '../tx/send';
import { askThrough } from '../tx/simulate';
import { useStoredValue } from '../tx/txStore';
import { useTrackedTx } from '../tx/useTrackedTx';
import { ActionFlow, reviewIdentity, type Recheck } from '../ui/ActionFlow';
import { Notice } from '../ui/Notice';
import { clearTokenApprovalCall, positionNftForDiamond } from './positionNft';

type Hex = `0x${string}`;

const APPROVAL_EVENT = [
  {
    type: 'event',
    name: 'Approval',
    inputs: [
      { name: 'owner', type: 'address', indexed: true },
      { name: 'approved', type: 'address', indexed: true },
      { name: 'tokenId', type: 'uint256', indexed: true },
    ],
  },
] as const;

/** True when `logs` carry the position token's own `Approval` clearing
 *  `tokenId`'s approval. */
export function approvalCleared(logs: readonly Log[], nft: Hex, tokenId: bigint): boolean {
  return parseEventLogs({ abi: APPROVAL_EVENT, logs: logs as Log[], strict: false }).some(
    (l) => l.address.toLowerCase() === nft.toLowerCase() && l.args.tokenId === tokenId && l.args.approved?.toLowerCase() === zeroAddress,
  );
}

export function TokenApprovalCard({
  side,
  tokenId,
  to,
  chain,
  own,
}: {
  side: 'lender' | 'borrower';
  tokenId: bigint;
  /** The address the token is approved for transfer to. */
  to: Hex;
  chain: SupportedChain;
  own: OwnStateClient;
}) {
  const { text, format } = useCopy();
  const config = useConfig();
  const diamond = chain.diamondAddress;
  const account = own.account;
  const nft = positionNftForDiamond(diamond).nft;
  const key = `position.approval.${chain.chainId}.${tokenId.toString()}`;
  const [reviewing, setReviewing] = useStoredValue<boolean>(`${key}:open`);
  const [openedFor, setOpenedFor] = useStoredValue<string>(`${key}:openedFor`);
  const [readAt, setReadAt] = useState(() => Date.now());
  const identity = reviewIdentity(own);
  const call = clearTokenApprovalCall(diamond, tokenId);
  const ask = () => askThrough(own, (cl) => cl.simulateContract({ ...call, account }));

  const tx = useTrackedTx({
    key,
    chainId: chain.chainId,
    account,
    sources: own.sources,
    send: async () => {
      const asked = await ask();
      if (asked.kind === 'reverted') {
        const r = refusalFromError(asked.error);
        throw new StatedRefusal({ code: r.code, reason: format('position.approvalRefused', { reason: r.reason }), reopensAt: null, remedy: null });
      }
      if (asked.kind === 'unreadable') throw new StatedRefusal({ code: 'Unreadable', reason: format('flow.unreadable', { reason: asked.reason }), reopensAt: null, remedy: null });
      return sendWrite(config, { ...call, chainId: chain.chainId, account });
    },
    unwind: async () => null,
    measure: async (receipt) => {
      const label = text('position.approvalLeg');
      return [approvalCleared(receipt.logs, nft, tokenId) ? { status: 'done', label } : { status: 'not-done', label, reason: text('position.approvalLegMissing') }];
    },
  });

  const close = () => {
    setReviewing(null);
    setOpenedFor(null);
    tx.reset();
  };

  if (reviewing) {
    const receipt: Receipt = {
      title: text('position.approvalRemoveTitle'),
      rows: [
        { label: text('position.approvalRowToken'), value: { kind: 'text', text: format('position.approvalTokenValue', { id: tokenId.toString() }) }, binding: true },
        { label: text('position.approvalRowFrom'), value: { kind: 'text', text: to }, binding: true },
      ],
      consequences: [text('position.approvalNoMoney'), text('position.approvalAfter')],
      prompts: 1,
      readAt,
    };
    const recheck = async (): Promise<Recheck> => {
      try {
        const asked = await ask();
        if (asked.kind === 'reverted') return { kind: 'refused', refusal: refusalFromError(asked.error) };
        if (asked.kind === 'unreadable') return { kind: 'unreadable', reason: asked.reason };
        return { kind: 'ok' };
      } catch (e) {
        return { kind: 'unreadable', reason: refusalFromError(e).reason };
      }
    };
    return (
      <div data-testid={`position-approval-review-${side}`}>
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

  return (
    <div data-testid={`position-approval-${side}`} data-to={to}>
      <Notice tone="warn" tier="A">
        {format(side === 'lender' ? 'position.approvalLender' : 'position.approvalBorrower', { address: to })}
      </Notice>
      <button
        type="button"
        className="btn"
        onClick={() => {
          setReadAt(Date.now());
          setOpenedFor(identity);
          setReviewing(true);
          tx.review();
        }}
        data-testid={`position-approval-remove-${side}`}
      >
        {text('position.approvalRemove')}
      </button>
    </div>
  );
}
