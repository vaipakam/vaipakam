import { useState } from 'react';
import { useConfig } from 'wagmi';
import { writeContract } from 'wagmi/actions';
import { useOwnStateClient } from '../../chain/ownRail';
import { getSupportedChain } from '../../chain/chains';
import { useCopy, type CopyAccess } from '../copy/useCopy';
import type { Receipt } from '../receipt/types';
import { tokenAmount, type TokenMetaMap } from '../reads/tokens';
import { simulateCall } from '../tx/simulate';
import { holdsFlow } from '../tx/txStore';
import { useTrackedTx } from '../tx/useTrackedTx';
import { ActionFlow, reviewIdentity, type Recheck } from '../ui/ActionFlow';
import { shortAddress } from '../ui/format';
import { REWARD_CLAIM_ABI, VENUE_VAULT, claimRecord, deliveryOutcome, moreRemains, readHeldRewards, readPendingRewards, readVaultAddress, readVpfiToken, vpfiArrivals, type PendingRewards } from './rewards';

type Hex = `0x${string}`;

/** The moment a review's inputs were read (called from handlers). */
const readNow = () => Date.now();

/** Which reward leg of the shared claim flow (RB-CLAIM): the interaction
 *  claim, or the standalone release of a held balance (RW-36). */
export type RewardClaimKind = 'interaction' | 'held';

/** What the reads say a claim pays now: the exact preview for an
 *  interaction claim (with the block it was read at), the held balance for
 *  a held one (days 0 to 0, no block). */
export interface RewardReady {
  amount: bigint;
  fromDay: bigint;
  toDay: bigint;
  atBlock?: bigint;
}

/** The sentence for a preview that is not an exact figure. */
export function pendingText(p: Exclude<PendingRewards, { kind: 'exact' }>, copy: Pick<CopyAccess, 'text' | 'format'>): string {
  const { text, format } = copy;
  switch (p.kind) {
    case 'none':
      return text('rewards.none');
    case 'waiting':
      return format(p.why === 'global' ? 'rewards.waitingGlobal' : 'rewards.waitingDelivery', { day: p.day.toString() });
    case 'not-started':
      return text('rewards.notStarted');
    case 'paused':
      return text('rewards.paused');
    case 'barred':
      return text('rewards.barred');
    case 'refused':
      return format('rewards.refused', { code: p.code });
  }
}

/** The review's inputs, with the identity they were read under. */
interface Reviewed extends RewardReady {
  readAt: number;
  identity: string;
}

interface RewardClaimProps {
  kind: RewardClaimKind;
  /** Claimable now by the reads; null when nothing is offered. A flow
   *  already open stays on screen whatever this becomes. */
  ready: RewardReady | null;
  /** The VPFI token the claim pays in (null until read). */
  token: Hex | null;
  meta: TokenMetaMap | null;
}

/**
 * RB-CLAIM, the reward legs: one claim flow reached from every surface that
 * offers a reward claim (Home, Claims, Rewards). The tracker key is per leg,
 * so a claim sent from one page is the same outstanding flow on another.
 * The re-check runs the claim's own preview again (or re-reads the held
 * balance and the screen) and simulates the call as the sender; the outcome
 * is the payment the claim's logs record, placed by the VPFI the claim's own
 * transaction delivered to the wallet and to the vault (unknown when those
 * do not add up to it). Every send, preview and re-check passes the Vault
 * venue explicitly. After an interaction claim that stopped at its bound,
 * the remainder is offered as "claim again" (RW-27).
 */
export function RewardClaim({ kind, ready, token, meta }: RewardClaimProps) {
  const copy = useCopy();
  const { text, format } = copy;
  const config = useConfig();
  const own = useOwnStateClient();
  const chain = getSupportedChain(own?.chainId);
  const diamond = (chain?.diamondAddress ?? '0x') as Hex;
  const account = (own?.account ?? '0x') as Hex;
  const [reviewed, setReviewed] = useState<Reviewed | null>(null);

  const tx = useTrackedTx({
    key: `claim.reward.${kind}`,
    chainId: chain?.chainId ?? 0,
    account,
    sources: own?.sources ?? [],
    send: () =>
      kind === 'interaction'
        ? writeContract(config, { address: diamond, abi: REWARD_CLAIM_ABI, functionName: 'claimInteractionRewardsTo', args: [VENUE_VAULT], chainId: chain!.chainId, account })
        : writeContract(config, { address: diamond, abi: REWARD_CLAIM_ABI, functionName: 'claimHeldInteractionRewards', args: [VENUE_VAULT], chainId: chain!.chainId, account }),
    measure: async (receipt, at) => {
      const record = claimRecord(receipt.logs, diamond, account);
      if (record.paid === null) return [{ status: 'not-done', label: text(kind === 'interaction' ? 'claim.titleRewards' : 'claim.titleHeld'), reason: text('claim.noLog') }];
      const paid = record.paid;
      if (paid === 0n) return [{ status: 'done', label: text('claim.legNothing') }];
      const vpfi = token ?? (await at.read((c) => readVpfiToken(c, diamond)));
      // From the claim's own transaction: the VPFI its Transfer logs sent to
      // the wallet and to the vault. Another transfer in the same block is
      // not in these logs, so it cannot be read as the claim's delivery.
      const vault = await at.read((c, b) => readVaultAddress(c, diamond, account, b));
      const arrived = vpfiArrivals(receipt.logs, vpfi, account, vault);
      const outcome = deliveryOutcome(paid, arrived.wallet, arrived.vault);
      if (outcome.verdict === 'done') {
        const where = text(outcome.where === 'vault' ? 'claim.whereVault' : outcome.where === 'wallet' ? 'claim.whereWallet' : 'claim.whereSplit');
        return [{ status: 'done', label: format('claim.legPaid', { amount: tokenAmount(paid, vpfi, meta, format), where }) }];
      }
      return [
        {
          status: 'unknown',
          label: format('claim.legLogged', { amount: tokenAmount(paid, vpfi, meta, format) }),
          reason: format('claim.arrivedOther', { amount: tokenAmount(arrived.wallet + arrived.vault, vpfi, meta, format) }),
        },
      ];
    },
  });

  if (!own || !chain) return null;
  const identity = reviewIdentity(own);
  const flowOpen = reviewed !== null || holdsFlow(tx.phase);
  if (!flowOpen && (ready === null || token === null)) return null;

  const start = () => {
    if (!ready) return;
    setReviewed({ ...ready, readAt: readNow(), identity });
    // A review left open when this page last unmounted has lost its inputs.
    if (tx.phase.kind !== 'idle') tx.reset();
    tx.review();
  };

  // RB-REVIEW: the figure the receipt states, worked out again through the
  // own rail, then the call itself simulated as the sender.
  const recheck = async (current: () => boolean): Promise<Recheck> => {
    if (!reviewed) return { kind: 'unreadable', reason: text('flow.reading') };
    if (kind === 'interaction') {
      const now = (await own.read((c) => readPendingRewards(c, diamond, account))).value;
      if (now.kind !== 'exact') return { kind: 'refused', refusal: { code: now.kind, reason: pendingText(now, copy), reopensAt: null, remedy: null } };
      if (now.amount !== reviewed.amount || now.fromDay !== reviewed.fromDay || now.toDay !== reviewed.toDay) {
        if (current()) setReviewed({ ...reviewed, amount: now.amount, fromDay: now.fromDay, toDay: now.toDay, readAt: readNow() });
        return { kind: 'changed', what: text('claim.changedAmount') };
      }
      return simulateCall(own, { address: diamond, abi: REWARD_CLAIM_ABI, functionName: 'claimInteractionRewardsTo', args: [VENUE_VAULT] });
    }
    const held = (await own.read((c) => readHeldRewards(c, diamond, account))).value;
    if (held.decision !== 'deliver') return { kind: 'refused', refusal: { code: 'SanctionedAddress', reason: text('claim.heldStillFlagged'), reopensAt: null, remedy: null } };
    if (held.held === 0n) return { kind: 'refused', refusal: { code: 'NoInteractionRewardsToClaim', reason: text('claim.heldGone'), reopensAt: null, remedy: null } };
    if (held.held !== reviewed.amount) {
      if (current()) setReviewed({ ...reviewed, amount: held.held, readAt: readNow() });
      return { kind: 'changed', what: text('claim.changedHeld') };
    }
    return simulateCall(own, { address: diamond, abi: REWARD_CLAIM_ABI, functionName: 'claimHeldInteractionRewards', args: [VENUE_VAULT] });
  };

  const receipt: Receipt | null =
    reviewed && token
      ? {
          title: text(kind === 'interaction' ? 'claim.titleRewards' : 'claim.titleHeld'),
          rows: [
            { label: text('claim.rowReceive'), value: { kind: 'amount', asset: token, amount: reviewed.amount }, binding: true },
            kind === 'interaction'
              ? { label: text('claim.rowDays'), value: { kind: 'text', text: reviewed.toDay === 0n ? text('claim.daysEntries') : format('claim.days', { from: reviewed.fromDay.toString(), to: reviewed.toDay.toString() }) }, binding: false }
              : { label: text('claim.rowFrom'), value: { kind: 'text', text: text('claim.heldFrom') }, binding: false },
            { label: text('claim.rowTo'), value: { kind: 'text', text: text('claim.to') }, binding: true },
            { label: text('claim.rowNetwork'), value: { kind: 'text', text: format('claim.network', { chain: chain.name }) }, binding: false },
          ],
          consequences: [],
          prompts: 1,
          readAt: reviewed.readAt,
        }
      : null;

  const describeAsset = (a: Hex) => {
    const m = meta?.[a.toLowerCase()];
    return m && m.decimals !== null ? { symbol: m.symbol ?? shortAddress(a), decimals: m.decimals } : null;
  };

  // RW-27: a claim pays a bounded amount at a time; once a preview read at
  // or after the finished claim's block still answers with a figure, the
  // remainder is offered at once.
  const more =
    kind === 'interaction' && tx.phase.kind === 'measured' && ready?.atBlock !== undefined && moreRemains({ kind: 'exact', ...ready, atBlock: ready.atBlock }, tx.phase.blockNumber);

  return (
    <>
      {!flowOpen && (
        <p className="actions">
          <button type="button" className="btn btn-primary" onClick={start} data-testid={`claim-${kind}`}>
            {text(kind === 'interaction' ? 'rewards.claim' : 'rewards.heldClaim')}
          </button>
        </p>
      )}
      {flowOpen && (
        <ActionFlow
          tx={tx}
          identity={identity}
          reviewedFor={reviewed?.identity ?? tx.frozen?.identity ?? ''}
          receipt={receipt}
          recheck={recheck}
          describeAsset={describeAsset}
          explorer={chain.blockExplorer}
          next={null}
          after={(outcome) =>
            outcome.verdict === 'done' && more ? (
              <p className="tier-b" data-testid="claim-more">
                {text('rewards.more')}{' '}
                <button type="button" className="btn btn-primary" onClick={start} data-testid="claim-again">
                  {text('rewards.claimAgain')}
                </button>
              </p>
            ) : null
          }
          onClose={() => setReviewed(null)}
        />
      )}
    </>
  );
}
