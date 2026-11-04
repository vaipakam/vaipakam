/**
 * #1558 — the refinance payoff permit: ONE place for how the app reads,
 * signs and attaches it, shared by the loan page's refinance form, the
 * pending request card and the "Refinance all" batch.
 *
 * A refinance completes in a transaction the borrower does not send (the
 * new lender's accept or the matcher's fill). Since #3042 the new loan's
 * net principal (its principal less the initiation fee) pays the old
 * lender directly, and the borrower's wallet pays only the rest of the
 * payoff: the old loan's interest (and any late fee) plus the new loan's
 * initiation fee. The borrower authorises that share with a single-use
 * Permit2 permit, signed for an exact maximum and bound to THIS loan
 * through THIS request (the `RefinancePayoff(loanId, offerId)` witness),
 * and attached to the request on chain. The acceptance uses it once, for
 * the share at that moment; Permit2 burns its nonce, and an unused permit
 * lapses at its deadline. The Diamond never holds an allowance for the
 * payoff.
 *
 * The figures come from the contract (`getRefinancePayoff`), never from
 * an app-side mirror of the interest and late-fee rules: the permit's
 * maximum is what the contract says the wallet's share can reach by the
 * permit's deadline, so a rounding difference can never leave a permit a
 * wei short of what the refinance pulls.
 *
 * What the wallet still needs is the one-time ERC-20 approval of Permit2
 * itself (Uniswap's permit contract), as every Permit2 payment does. That
 * approval moves nothing on its own: Permit2 pays out only against a
 * signature the wallet made.
 *
 * BRIDGE until the all-waves fresh deploy (owner decision 2026-10-29,
 * "merge now"): a Diamond deployed before #1558 has no permit entry and
 * still pays the payoff from a standing ERC-20 approval of the Diamond.
 * Such a Diamond also predates #3042, so on that route the new principal
 * reaches the wallet first and the approval covers the WHOLE payoff.
 * `readPayoffRoute` tells the two apart from the Diamond's own routing,
 * and every refinance surface takes the route it answers. The approval
 * route, and the app-side payoff mirror it sizes with, are removed once
 * every chain runs the fresh deploy (#3074).
 */
import { toFunctionSelector, zeroAddress, type PublicClient, type WalletClient } from 'viem';
import { DIAMOND_ABI_VIEM } from './diamond';
import { ensureAllowance, restoreAllowance } from './erc20';
import { settleFailedSend } from './ownReceipt';
import {
  loanEndTimeOf,
  refinanceApprovalOf,
  refinancePayoffOf,
  refinanceWalletPullOf,
  type LoanLive,
} from './loanLive';
import { PERMIT2_ADDRESS, randomNonce } from './usePermit2Signing';
import type { DiamondWriteResult } from './diamond';

/** How a refinance pays off the old loan on this Diamond: through the
 *  request's single-use permit, or (a Diamond deployed before #1558)
 *  through a standing ERC-20 approval of the Diamond. */
export type PayoffRoute = 'permit' | 'approval';

const SET_PERMIT_SELECTOR = toFunctionSelector(
  'setRefinancePayoffPermit(uint256,uint256,uint256,uint256,bytes)',
);

/** Which route this Diamond pays a refinance payoff by, from its own
 *  routing table. A failed read throws: guessing either route would post
 *  a request its acceptance cannot pay. */
export async function readPayoffRoute(
  publicClient: PublicClient,
  diamond: `0x${string}`,
): Promise<PayoffRoute> {
  const host = (await publicClient.readContract({
    address: diamond,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'facetAddress',
    args: [SET_PERMIT_SELECTOR],
  })) as `0x${string}`;
  return host.toLowerCase() === zeroAddress ? 'approval' : 'permit';
}

/** The last moment a request can still be accepted: one second before its
 *  own expiry (acceptance refuses at the expiry itself), and never after
 *  the old loan's grace end. `expiresAt` 0 means no expiry of its own. */
export function lastFillableMoment(expiresAt: bigint, graceEnd: bigint): bigint {
  return expiresAt > 0n && expiresAt - 1n < graceEnd ? expiresAt - 1n : graceEnd;
}

/** What `getRefinancePayoff(loanId, offerId, by)` answers. */
export interface RefinancePayoff {
  /** The old loan's principal asset. */
  asset: `0x${string}`;
  /** The payoff if the refinance completed now (0 unless the loan is an
   *  Active ERC-20 loan). */
  payoffNow: bigint;
  /** The payoff at `by` (read as no earlier than now and no later than the
   *  old loan's grace end): the most it can reach by then. */
  payoffBy: bigint;
  /** #3042 — the most the wallet pays if the request is accepted now: the
   *  payoff less the request's amount net of the initiation fee at the live
   *  rate (for `offerId` 0, a request for the outstanding principal). */
  walletShareNow: bigint;
  /** The same at `by`: what a permit with that deadline is signed for. */
  walletShareBy: bigint;
  /** The attached permit, if any (signer is the zero address when none). */
  signer: `0x${string}`;
  maxAmount: bigint;
  nonce: bigint;
  deadline: bigint;
  /** Permit2 has already spent that nonce: the permit can no longer pay. */
  nonceSpent: boolean;
}

/** Read the payoff now and at `by`, and the permit attached to `offerId`
 *  (pass 0 for the figures alone). Only on a Diamond whose route is
 *  `'permit'`. */
export async function readRefinancePayoff(
  publicClient: PublicClient,
  diamond: `0x${string}`,
  loanId: bigint,
  offerId: bigint,
  by: bigint,
): Promise<RefinancePayoff> {
  const r = (await publicClient.readContract({
    address: diamond,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getRefinancePayoff',
    args: [loanId, offerId, by],
  })) as readonly [
    `0x${string}`,
    bigint,
    bigint,
    bigint,
    bigint,
    `0x${string}`,
    bigint,
    bigint,
    bigint,
    boolean,
  ];
  return {
    asset: r[0],
    payoffNow: r[1],
    payoffBy: r[2],
    walletShareNow: r[3],
    walletShareBy: r[4],
    signer: r[5],
    maxAmount: r[6],
    nonce: r[7],
    deadline: r[8],
    nonceSpent: r[9],
  };
}

/**
 * Today's payoff, what the wallet pays, and the most a request's
 * acceptance can pull from the wallet, on either route. On the permit
 * route they come from the contract; on a Diamond deployed before #1558
 * they come from the app-side mirror that sized the standing approval (it
 * over-covers a pro-rata loan, never under-covers).
 * `expiresAt` is the request's own expiry (posted, or the one about to be
 * posted); `graceSeconds` the loan's grace window.
 */
export interface PayoffQuote {
  route: PayoffRoute;
  /** The whole payoff of an acceptance in this block. */
  payoff: bigint;
  /** What the wallet must hold SPARE for an acceptance in this block: the
   *  payoff less the new loan's net principal. On the permit route that
   *  is exactly what is pulled (#3042); on the approval route the whole
   *  payoff is pulled and the net principal arrives first. */
  topUp: bigint;
  /** How much the payoff can still grow before `lastFillable` (late fee
   *  plus interest that keeps building up). */
  growth: bigint;
  /** What an acceptance at `lastFillable` pulls from the wallet: the most
   *  it can be. On the permit route the permit is signed for exactly this
   *  (the wallet's share); on the approval route it is the approval's size
   *  (the whole payoff). */
  bound: bigint;
  /** The request's last fillable moment, which is the permit's deadline. */
  lastFillable: bigint;
  /** The permit attached to `offerId` (permit route, `offerId` > 0). */
  permit: RefinancePayoff | null;
}

export async function readPayoffQuote(a: {
  publicClient: PublicClient;
  diamond: `0x${string}`;
  live: LoanLive;
  loanId: bigint;
  /** The request whose attached permit to read; 0 for none yet. */
  offerId: bigint;
  chainNow: bigint;
  expiresAt: bigint;
  graceSeconds: bigint;
  /** The route, when the caller has already read it. */
  route?: PayoffRoute;
  /** The request's amount and the live initiation-fee rate. Required on
   *  the approval route, where they size the wallet's spare balance; the
   *  permit route reads the contract's own figure. */
  requestAmount?: bigint;
  loanInitiationFeeBps?: number;
}): Promise<PayoffQuote> {
  const route = a.route ?? (await readPayoffRoute(a.publicClient, a.diamond));
  const graceEnd = loanEndTimeOf(a.live, a.chainNow) + a.graceSeconds;
  const lastFillable = lastFillableMoment(a.expiresAt, graceEnd);
  if (route === 'approval') {
    if (a.requestAmount === undefined || a.loanInitiationFeeBps === undefined) {
      throw new Error('readPayoffQuote: the approval route needs the request amount and fee rate');
    }
    const payoff = refinancePayoffOf(a.live, a.chainNow);
    const bound = refinanceApprovalOf(a.live, {
      expiresAt: a.expiresAt,
      graceSeconds: a.graceSeconds,
    });
    return {
      route,
      payoff,
      topUp: refinanceWalletPullOf(
        a.live,
        { requestAmount: a.requestAmount, loanInitiationFeeBps: a.loanInitiationFeeBps },
        a.chainNow,
      ),
      growth: bound > payoff ? bound - payoff : 0n,
      bound,
      lastFillable,
      permit: null,
    };
  }
  const p = await readRefinancePayoff(a.publicClient, a.diamond, a.loanId, a.offerId, lastFillable);
  return {
    route,
    payoff: p.payoffNow,
    topUp: p.walletShareNow,
    growth: p.payoffBy > p.payoffNow ? p.payoffBy - p.payoffNow : 0n,
    bound: p.walletShareBy,
    lastFillable,
    permit: a.offerId > 0n ? p : null,
  };
}

/** Whether a refinance request needs a payoff permit at all: only when
 *  the wallet's share can be above zero (#3042). A share of zero — no
 *  interest, late fee or initiation fee to cover, as with a zero-rate loan
 *  and a zero fee rate or dust-sized amounts — takes nothing from the
 *  wallet, so the settlement consults no permit (`LibRefinancePayoff.pull`
 *  only clears one), and the contract refuses to store a permit for zero.
 *  The ONE rule every signing, attach and verdict path below reads. */
export function permitNeeded(bound: bigint): boolean {
  return bound > 0n;
}

/** Why the permit attached to a request cannot pay every acceptance the
 *  request still allows, or null when it can (or needs none,
 *  `permitNeeded`):
 *  - `missing`: none attached, or attached by another wallet;
 *  - `spent`: Permit2 has already used its nonce;
 *  - `expired`: its deadline has passed;
 *  - `lapsesEarly`: it expires before the request's last fillable moment;
 *  - `short`: it allows less than the wallet's share can reach by then.
 *  `chainNow` is the latest block's time. */
export type PermitProblem = 'missing' | 'spent' | 'expired' | 'lapsesEarly' | 'short';

export function permitProblem(
  p: RefinancePayoff,
  holder: string,
  chainNow: bigint,
  lastFillable: bigint,
  bound: bigint,
): PermitProblem | null {
  if (!permitNeeded(bound)) return null;
  if (p.signer.toLowerCase() === zeroAddress || p.signer.toLowerCase() !== holder.toLowerCase()) {
    return 'missing';
  }
  if (p.nonceSpent) return 'spent';
  if (chainNow > p.deadline) return 'expired';
  if (p.deadline < lastFillable) return 'lapsesEarly';
  if (p.maxAmount < bound) return 'short';
  return null;
}

// EIP-712 types for Permit2's `permitWitnessTransferFrom` with the
// refinance witness. Permit2 hashes the witness type it is handed by the
// Diamond (`LibRefinancePayoff.WITNESS_TYPE_STRING`); viem encodes the
// same type from these definitions, referenced types in alphabetical
// order, so the two must name the same fields in the same order.
const PAYOFF_PERMIT_TYPES = {
  PermitWitnessTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'witness', type: 'RefinancePayoff' },
  ],
  RefinancePayoff: [
    { name: 'loanId', type: 'uint256' },
    { name: 'offerId', type: 'uint256' },
  ],
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
} as const;

/** The typed data the wallet signs for a payoff permit. Exported for the
 *  test that holds it to the contract's witness. */
export function payoffPermitTypedData(a: {
  chainId: number;
  diamond: `0x${string}`;
  token: `0x${string}`;
  maxAmount: bigint;
  nonce: bigint;
  deadline: bigint;
  loanId: bigint;
  offerId: bigint;
}) {
  return {
    domain: {
      name: 'Permit2',
      chainId: a.chainId,
      verifyingContract: PERMIT2_ADDRESS,
    },
    types: PAYOFF_PERMIT_TYPES,
    primaryType: 'PermitWitnessTransferFrom' as const,
    message: {
      permitted: { token: a.token, amount: a.maxAmount },
      spender: a.diamond,
      nonce: a.nonce,
      deadline: a.deadline,
      witness: { loanId: a.loanId, offerId: a.offerId },
    },
  };
}

/** A signed payoff permit, as `setRefinancePayoffPermit` takes it after
 *  the request id. */
export interface SignedPayoffPermit {
  maxAmount: bigint;
  nonce: bigint;
  deadline: bigint;
  signature: `0x${string}`;
}

/** Sign a payoff permit for `loanId` through request `offerId`: at most
 *  `maxAmount`, expiring at `deadline` (pass the request's last fillable
 *  moment, so the permit lapses with the request). One wallet prompt. */
export async function signRefinancePayoffPermit(a: {
  walletClient: WalletClient;
  chainId: number;
  diamond: `0x${string}`;
  owner: `0x${string}`;
  token: `0x${string}`;
  maxAmount: bigint;
  deadline: bigint;
  loanId: bigint;
  offerId: bigint;
}): Promise<SignedPayoffPermit> {
  const nonce = randomNonce();
  const signature = await a.walletClient.signTypedData({
    account: a.owner,
    ...payoffPermitTypedData({
      chainId: a.chainId,
      diamond: a.diamond,
      token: a.token,
      maxAmount: a.maxAmount,
      nonce,
      deadline: a.deadline,
      loanId: a.loanId,
      offerId: a.offerId,
    }),
  });
  return { maxAmount: a.maxAmount, nonce, deadline: a.deadline, signature };
}

/** The Diamond call that attaches a signed permit to request `offerId`. */
export function setPayoffPermitCall(
  offerId: bigint,
  p: SignedPayoffPermit,
): { functionName: string; args: readonly unknown[] } {
  return {
    functionName: 'setRefinancePayoffPermit',
    args: [offerId, p.maxAmount, p.nonce, p.deadline, p.signature],
  };
}

/**
 * Sign a payoff permit for `loanId` through request `offerId` and attach it
 * to the request. First makes sure the wallet's approval of Permit2 covers
 * `maxAmount` (it raises a lower one to exactly that figure, and leaves a
 * larger one alone). Each step is a wallet prompt: the Permit2 approval
 * when needed, the signature, and the attach transaction.
 *
 * Throws when the permit is established as NOT attached: a refusal or
 * failure before the attach transaction was sent, or that transaction
 * reverted or was cancelled. Resolves `'attached'` once the chain shows
 * it mined, and `'unknown'` when the transaction was sent but neither
 * confirmed nor refused (a receipt wait that timed out): it may still
 * attach, so a caller must not report the permit as missing then.
 * Resolves `'notNeeded'`, touching nothing, when `maxAmount` is zero
 * (`permitNeeded`).
 */
export type PermitAttachOutcome = 'attached' | 'unknown' | 'notNeeded';

export async function attachRefinancePayoffPermit(a: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  write: (
    functionName: string,
    args: readonly unknown[],
    opts?: { onSubmitted?: (hash: `0x${string}`) => void },
  ) => Promise<DiamondWriteResult>;
  chainId: number;
  diamond: `0x${string}`;
  owner: `0x${string}`;
  token: `0x${string}`;
  maxAmount: bigint;
  deadline: bigint;
  loanId: bigint;
  offerId: bigint;
  onPrompt?: () => void;
}): Promise<PermitAttachOutcome> {
  // A zero share needs no permit, and the contract would refuse one for
  // zero: nothing is approved, signed or sent.
  if (!permitNeeded(a.maxAmount)) return 'notNeeded';
  await ensurePermit2Approval(a);
  a.onPrompt?.();
  const signed = await signRefinancePayoffPermit(a);
  a.onPrompt?.();
  const call = setPayoffPermitCall(a.offerId, signed);
  let submitted: `0x${string}` | null = null;
  try {
    await a.write(call.functionName, call.args, { onSubmitted: (hash) => (submitted = hash) });
    return 'attached';
  } catch (err) {
    const settled = await settleFailedSend(a.publicClient, submitted, err);
    if ('block' in settled) return 'attached';
    if ('pending' in settled) return 'unknown';
    throw err;
  }
}

/** The wallet's ERC-20 approval of Permit2 covers `maxAmount`; raises a
 *  lower one to exactly that figure. A batch calls it once for the sum of
 *  its permits before attaching each.
 *
 *  Never leaves the prior approval destroyed (#1558 review). Raising a
 *  non-zero approval goes through a reset to zero first (some tokens refuse
 *  a non-zero to non-zero approve), and that prior approval may be what
 *  another live request's permit draws on. If the raise then stops (the
 *  wallet prompt rejected, the approve reverted or never confirmed) while
 *  the reset stands, the prior figure is put back before the error is
 *  rethrown, through the same guarded restore every other unwind uses: it
 *  acts only while the allowance still reads what this attempt left. A raise
 *  that did land is left alone; it covers the prior requests too. */
export async function ensurePermit2Approval(a: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  owner: `0x${string}`;
  token: `0x${string}`;
  maxAmount: bigint;
  onPrompt?: () => void;
}): Promise<void> {
  // Nothing to cover: no approval is asked for (`permitNeeded`).
  if (!permitNeeded(a.maxAmount)) return;
  // One record the callbacks fill, read once the raise has stopped.
  const seen: {
    previous: bigint | null;
    wrote: bigint | null;
    wroteTxHash: `0x${string}` | null;
    confirmed: bigint | null;
  } = { previous: null, wrote: null, wroteTxHash: null, confirmed: null };
  try {
    await ensureAllowance({
      publicClient: a.publicClient,
      walletClient: a.walletClient,
      token: a.token,
      owner: a.owner,
      spender: PERMIT2_ADDRESS,
      amount: a.maxAmount,
      onPrompt: a.onPrompt,
      onObserved: (value) => {
        seen.previous = value;
      },
      onWrote: (value, hash) => {
        seen.wrote = value;
        seen.wroteTxHash = hash;
      },
      onConfirmed: (value) => {
        seen.confirmed = value;
      },
    });
  } catch (err) {
    const { previous, wrote, wroteTxHash, confirmed } = seen;
    // Only the reduced case is unwound: what this attempt left on chain is
    // below what it found.
    if (previous !== null && wrote !== null && wrote < previous) {
      try {
        await restoreAllowance({
          publicClient: a.publicClient,
          walletClient: a.walletClient,
          token: a.token,
          owner: a.owner,
          spender: PERMIT2_ADDRESS,
          previous,
          wrote,
          wroteTxHash,
          confirmed,
        });
      } catch {
        // Best effort: the original failure is what the caller reports, and
        // the pending card names a Permit2 approval that no longer covers a
        // request's permit, with the step that raises it again.
      }
    }
    throw err;
  }
}
