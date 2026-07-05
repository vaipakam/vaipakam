/**
 * Signing transparency (#1037): shared plumbing for the review
 * screen's "you'll confirm N times" pre-disclosure and the live
 * "step x of y" phase labels while a multi-prompt submission runs.
 *
 * Why: creating an offer takes 2 wallet prompts and accepting one
 * takes 3 (terms signature → exact-amount approval → the action) —
 * structural, not incidental: an ERC-20 approval must be its own
 * transaction before the Diamond may pull funds, and the EIP-712
 * terms consent is deliberately a separate free signature. To a
 * naive user an unannounced second or third prompt reads as
 * something going wrong. The honest fix is a roadmap before the
 * first prompt and a live position indicator during the sequence.
 * (Prompt REDUCTION — Permit2 — is tracked separately as #1038.)
 */
import { erc20Abi, type PublicClient } from 'viem';
import { useReadContract } from 'wagmi';

export type PromptKind = 'sign' | 'approve' | 'send';

export interface SubmitProgress {
  kind: PromptKind;
  /** 1-based position; 0 = preflight checks before the first prompt. */
  current: number;
  total: number;
}

/** Zero-first approval rule → how many approve PROMPTS the payment
 *  leg costs: 0 (allowance already covers), 1 (fresh approve), or 2
 *  (non-zero-but-short allowance: reset to zero first — tokens like
 *  mainnet USDT revert on non-zero→non-zero approves). An unknown
 *  allowance (read unavailable) plans 1 — the roadmap says "up to". */
export function plannedApprovePrompts(
  current: bigint | undefined,
  amount: bigint,
): number {
  if (current === undefined) return 1;
  if (current >= amount) return 0;
  return current > 0n ? 2 : 1;
}

export interface Stepper {
  /** Advance to the next wallet prompt of the given kind. Clamped to
   *  the planned total so a plan/reality drift (allowance changed
   *  between planning and executing) can't render "4 of 3". */
  next: (kind: PromptKind) => void;
}

export function makeStepper(
  total: number,
  onChange: (p: SubmitProgress) => void,
): Stepper {
  let current = 0;
  return {
    next(kind: PromptKind): void {
      current = Math.min(current + 1, total);
      onChange({ kind, current, total });
    },
  };
}

/** One-shot allowance read for the runtime plan at submit time. */
export async function readAllowance(opts: {
  publicClient: PublicClient;
  token: `0x${string}`;
  owner: `0x${string}`;
  spender: `0x${string}`;
}): Promise<bigint | undefined> {
  try {
    return await opts.publicClient.readContract({
      address: opts.token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [opts.owner, opts.spender],
    });
  } catch {
    return undefined; // roadmap degrades to "up to N"
  }
}

/** Reactive allowance for the review-screen roadmap. Enabled only
 *  when every argument is known — the roadmap simply shows the
 *  fresh-approve count until the read lands. */
export function useAllowanceForPlan(opts: {
  chainId: number | undefined;
  token: `0x${string}` | undefined;
  owner: `0x${string}` | undefined;
  spender: `0x${string}` | undefined;
}) {
  return useReadContract({
    chainId: opts.chainId,
    address: opts.token,
    abi: erc20Abi,
    functionName: 'allowance',
    args:
      opts.owner && opts.spender
        ? [opts.owner, opts.spender]
        : undefined,
    query: {
      enabled: Boolean(
        opts.chainId && opts.token && opts.owner && opts.spender,
      ),
    },
  });
}
