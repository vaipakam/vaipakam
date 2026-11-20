/**
 * #3770 — how long a step may wait for a contract wallet's approvals. The
 * rule is the shared one (`@vaipakam/lib/txDeadline`: the step's class and
 * the wallet's kind); this module reads the wallet's kind and its approvals
 * required from the chain, and renders the choice on a review.
 *
 * A key wallet never sees it. A contract wallet on a fixed-terms step picks
 * "Time to gather approvals" and the review states the exact end time, that
 * anyone can submit the step once enough owners approve, and how to withdraw
 * it sooner. On a live-price step it is told the thirty minutes are fixed.
 * The end time is measured from the chain's latest block, as the deadline is.
 */
import { useState } from 'react';
import { parseAbi, type PublicClient } from 'viem';
import { useAccount } from 'wagmi';
import { deadlineWindows, stepClass, type DeadlineWallet } from '@vaipakam/lib/txDeadline';
import type { SupportedChain } from '../../chain/chains';
import { useCopy } from '../copy/useCopy';
import { useChainRead } from '../reads/chainRead';
import { formatSpan, formatUtc } from '../ui/format';
import { walletKindFromCode } from './accountWallet';
import type { TxStep, WindowChoice } from './deadline';

type Hex = `0x${string}`;
const SAFE_ABI = parseAbi(['function getThreshold() view returns (uint256)']);

/** The sender as the window rule sees it: a contract wallet only when it is
 *  opened as a Safe App and has code on this network; its threshold read
 *  from the wallet's own contract, null when that read fails. */
export async function readDeadlineWallet(c: PublicClient, account: Hex): Promise<DeadlineWallet> {
  if (walletKindFromCode(await c.getCode({ address: account })) !== 'contract') return { kind: 'key' };
  try {
    return { kind: 'contract', threshold: await c.readContract({ address: account, abi: SAFE_ABI, functionName: 'getThreshold' }) };
  } catch {
    return { kind: 'contract', threshold: null };
  }
}

/** The wallet, the windows `step` offers it, the choice and its setter. */
export function useApprovalWindow(step: TxStep, chain: SupportedChain | null) {
  const { address, connector } = useAccount();
  const safe = connector?.id === 'safe' && address !== undefined && chain !== null;
  const read = useChainRead(['deadline-wallet', address], (c) => readDeadlineWallet(c, address!), { enabled: safe, chain: chain ?? undefined });
  const wallet: DeadlineWallet = safe && read.data ? read.data : { kind: 'key' };
  const windows = deadlineWindows(step, wallet);
  const [picked, setPicked] = useState<number | null>(null);
  const window = picked !== null && windows.choices.includes(picked) ? picked : windows.preselected;
  const choice: WindowChoice = { wallet, window };
  return { wallet, windows, window, choice, setWindow: setPicked };
}

/** The choice on a review, or the fixed-window note; nothing for a key wallet. */
export function ApprovalWindowChoice({ step, chain, state }: { step: TxStep; chain: SupportedChain; state: ReturnType<typeof useApprovalWindow> }) {
  const { text, format } = useCopy();
  const now = useChainRead(['latest-time'], async (c) => (await c.getBlock({ blockTag: 'latest' })).timestamp, { enabled: state.wallet.kind === 'contract', chain });
  if (state.wallet.kind !== 'contract') return null;
  const cls = stepClass(step);
  if (state.windows.choices.length === 1) {
    if (cls.kind === 'short') return <p className="tier-a" data-testid="approval-window-fixed">{text('approvalWindow.livePrice')}</p>;
    return null;
  }
  return (
    <div data-testid="approval-window">
      <label>
        {text('approvalWindow.label')}{' '}
        <select value={state.window} onChange={(e) => state.setWindow(Number(e.target.value))}>
          {state.windows.choices.map((w) => (
            <option key={w} value={w}>
              {formatSpan(w)}
            </option>
          ))}
        </select>
      </label>
      <p className="tier-a" data-testid="approval-window-end">
        {now.data != null ? format('approvalWindow.ends', { when: formatUtc(now.data + BigInt(state.window)) }) : text('approvalWindow.endsUnread')}
      </p>
      {cls.kind === 'fixed-terms' && cls.signedMessage && <p className="tier-a" data-testid="approval-window-rounds">{text('approvalWindow.twoRounds')}</p>}
      {cls.kind === 'fixed-terms' && cls.maxWindow !== undefined && <p className="tier-a">{text('approvalWindow.capped')}</p>}
      <p className="tier-a">{text('approvalWindow.anyone')}</p>
    </div>
  );
}
