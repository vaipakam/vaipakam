/**
 * The approval half of every flow that lets the protocol pull a token from
 * the wallet (RB-FUNDS): read the allowance, approve exactly the amount a
 * review counted the steps for, and put an approval back when what it was
 * for does not go through. One module, so taking an offer and posting a
 * request cannot drift apart on how an approval is judged or reported.
 *
 * The allowance read back is the truth (shared/tx/approval): a step counts
 * only when the allowance reads the value asked for after it. A reset is
 * attempted only while the allowance still reads the value this flow set,
 * and anything else is stated, never overwritten.
 */
import { erc20Abi } from 'viem';
import type { Config } from 'wagmi';
import { waitForTransactionReceipt } from 'wagmi/actions';
import { sendWrite } from './send';
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess } from '../copy/useCopy';
import { refusalFromError, StatedRefusal } from '../eligibility/refusal';
import { tokenAcceptsApproval } from '../offers/reads';
import { setAllowance, type AllowanceIo } from './approval';
import type { CleanUpResult } from './cleanUp';

type Hex = `0x${string}`;

export interface ApprovalFlowDeps {
  own: OwnStateClient;
  config: Config;
  chainId: number;
  /** The spender: the protocol's Diamond. */
  diamond: Hex;
  copy: Pick<CopyAccess, 'text' | 'format'>;
  /** A token amount with every digit ("12.500001 WETH"): an approval is
   *  sent for an exact figure, so every sentence naming one states it exactly
   *  (RB-FUNDS), never shortened. */
  exactAmount: (token: Hex, value: bigint) => string;
  /** Names the wallet step in progress, or clears it. */
  setStep: (what: string | null) => void;
}

/** A put-back's result (shared/tx/cleanUp): `unknown` when a reset was
 *  sent but the allowance it left could not be read. */
export type PutBack = CleanUpResult;

export interface ApprovalFlow {
  /** The wallet's allowance to the Diamond for `token`, now or at `block`. */
  readAllowance: (token: Hex, block?: bigint) => Promise<bigint>;
  /** The wallet and chain operations the shared allowance rule runs on.
   *  With `since`, a read without a named block reads no earlier than it. */
  allowanceIo: (token: Hex, onStep?: AllowanceIo['onStep'], since?: bigint | null) => AllowanceIo;
  /**
   * Approves exactly `amount` of `token`, overwriting `prior` (the value the
   * review counted the steps from). Throws a stated refusal when the
   * allowance moved meanwhile, a step did not land, or the wallet declined
   * after a step had landed; a step of this flow that landed ahead of the
   * failure is put back while the allowance still reads the value it set.
   * Resolves with the block the approval mined in, which a put-back needs.
   */
  approveExactly: (io: AllowanceIo, token: Hex, amount: bigint, prior: bigint) => Promise<bigint | null>;
  /** Puts the allowance back to `prior` (best effort, and only if nothing
   *  else changed it since the approval), and says what happened. `since`
   *  is the block the approval mined in: the allowance is never read as it
   *  stood before it, whichever node answers, so a reset is never skipped
   *  as already done. */
  putBack: (token: Hex, prior: bigint, approvedAmount: bigint, since: bigint | null) => Promise<PutBack>;
}

/** The refusal a flow raises when the allowance it counted on moved. */
export function allowanceMoved(copy: Pick<CopyAccess, 'text'>): StatedRefusal {
  return new StatedRefusal({ code: 'AllowanceChanged', reason: copy.text('approval.allowanceMoved'), reopensAt: null, remedy: null });
}

export function approvalFlow(d: ApprovalFlowDeps): ApprovalFlow {
  const { own, config, chainId, diamond, copy } = d;
  const { text, format } = copy;
  const account = own.account;

  async function readAllowance(token: Hex, block?: bigint, since?: bigint | null): Promise<bigint> {
    const x = await own.read(async (c) => {
      let at = block;
      if (at === undefined && since !== undefined && since !== null) {
        const head = await c.getBlockNumber({ cacheTime: 0 });
        at = head < since ? since : head;
      }
      return c.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [account, diamond],
        blockNumber: at,
      });
    });
    return x.value;
  }

  function allowanceIo(token: Hex, onStep?: AllowanceIo['onStep'], since?: bigint | null): AllowanceIo {
    return {
      read: (block) => readAllowance(token, block, since),
      accepts: (amount) => own.read((c) => tokenAcceptsApproval(c, token, account, diamond, amount)).then((x) => x.value),
      send: (amount) =>
        sendWrite(config, {
          address: token,
          abi: erc20Abi,
          functionName: 'approve',
          args: [diamond, amount],
          chainId,
          account,
        }),
      wait: (hash) => waitForTransactionReceipt(config, { hash, chainId }).then((m) => m.blockNumber),
      onStep,
    };
  }

  async function putBack(token: Hex, prior: bigint, approvedAmount: bigint, since: bigint | null): Promise<PutBack> {
    // The same rule as the approval: the reset counts only when the
    // allowance reads `prior` after it, whatever the wallet did with it.
    const set = await setAllowance(
      allowanceIo(token, () => d.setStep(text('approval.stepRestore')), since),
      prior,
      approvedAmount,
    ).catch((e: unknown) => ({ ok: false as const, why: 'refused' as const, sent: 0, now: null, last: null, at: null, pending: null, reason: refusalFromError(e).reason }));
    if (set.ok) return { status: 'done', sentence: format('approval.restored', { amount: d.exactAmount(token, prior) }) };
    const why =
      set.why === 'changed'
        ? text('approval.restoreChanged')
        : set.pending !== null
          ? format('approval.restorePending', { hash: set.pending.hash })
          : set.why === 'refused'
            ? (set.reason ?? text('approval.restoreNotLanded'))
            : text('approval.restoreNotLanded');
    // An allowance that could not be read is said to be unknown, never
    // filled in with the amount approved: the reset may have landed.
    // Unknown only when a reset was sent and what it left is unread; with
    // nothing sent, the allowance is still the one the flow approved.
    const sentUnread = set.pending !== null || (set.now === null && set.sent > 0);
    if (set.now === null) return { status: sentUnread ? 'unknown' : 'not-done', sentence: format('approval.restoreUnverified', { why }) };
    return { status: sentUnread ? 'unknown' : 'not-done', sentence: format('approval.notRestored', { why, amount: d.exactAmount(token, set.now) }) };
  }

  async function approveExactly(io: AllowanceIo, token: Hex, amount: bigint, prior: bigint): Promise<bigint | null> {
    // `prior` is the allowance this flow overwrites and a stop restores, so
    // nothing is sent if it moved since it was read.
    const set = await setAllowance(io, amount, prior);
    if (set.ok) return set.at;
    // The wallet refused the first prompt: nothing was sent.
    if (set.why === 'refused' && set.sent === 0) throw new Error(set.reason ?? 'refused');
    if (set.why === 'changed') throw allowanceMoved(copy);
    // A step of this flow that landed (the one to zero, ahead of a refused or
    // failed one) left the allowance away from `prior`: it is put back, but
    // only while the allowance still reads the value this flow set. Any other
    // value (a replacement for a different amount, another transaction) is
    // stated, never overwritten.
    const back = set.pending === null && set.last !== null && set.now === set.last && set.now !== prior ? ` ${(await putBack(token, prior, set.last, set.at)).sentence}` : '';
    throw new StatedRefusal({
      code: 'ApprovalNotSet',
      reason:
        (set.pending !== null
          ? set.pending.amount === 0n
            ? format('approval.zeroUnread', { hash: set.pending.hash })
            : format('approval.unread', { hash: set.pending.hash, amount: d.exactAmount(token, set.pending.amount) })
          : format('approval.notSet', { amount: d.exactAmount(token, amount), now: set.now === null ? text('approval.allowanceUnknown') : d.exactAmount(token, set.now) })) + back,
      reopensAt: null,
      remedy: null,
    });
  }

  return { readAllowance, allowanceIo, approveExactly, putBack };
}
