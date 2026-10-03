/**
 * Take back extra collateral (UX3-009, 2026-10-03 live review).
 *
 * The platform lets a borrower withdraw collateral from an open loan as
 * long as the loan stays healthy (ProjectDetailsREADME, "Allow Borrower to
 * Withdraw Excess Collateral"). The contract has carried that since launch
 * (`partialWithdrawCollateral` + the `calculateMaxWithdrawable` view); the
 * app never offered it, so a borrower whose collateral had grown in value
 * had no way to use the surplus short of closing the loan.
 *
 * Two things here, both kept out of the page so the rules are tested
 * rather than read:
 *  - `useMaxWithdrawable` — the live ceiling, plus the one fact that
 *    explains a ZERO ceiling (the collateral cannot be priced right now)
 *    when the app can actually determine it;
 *  - `classifyMaxWithdrawable` / `withdrawAmountProblem` — what the page
 *    may say about that ceiling and about a typed amount.
 */
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { BaseError, ContractFunctionRevertedError, type PublicClient } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { useActiveChain } from '../chain/useActiveChain';
import { tipAware } from '../chain/railHealth';
import { isAssetIlliquidLive } from '../contracts/preflights';
import type { SaleListingHoldState } from './saleListingHold';

export interface MaxWithdrawableRead {
  /** `calculateMaxWithdrawable` — the most collateral (token units) the
   *  loan can release now and still meet its own health and loan-to-value
   *  limits. */
  max: bigint;
  /** Whether the collateral is unpriceable right now. `undefined` when the
   *  liquidity read itself failed — the page then says it cannot tell
   *  WHICH reason applies rather than picking one. */
  illiquid: boolean | undefined;
  /** Whether the collateral is VPFI. Taking VPFI out of the vault lowers
   *  the balance the fee-discount tier is measured on. `undefined` when
   *  the token read failed. */
  isVpfi: boolean | undefined;
  /** #2389 r3 — the deployment's pause switch. The ceiling view stays
   *  readable while paused, but the withdrawal itself is refused, so a
   *  paused deployment is said instead of offering a doomed form.
   *  `undefined` when the read failed. */
  paused: boolean | undefined;
}

export type MaxWithdrawState =
  | { kind: 'loading' }
  /** The ceiling could not be read — never shown as zero. */
  | { kind: 'unconfirmed' }
  /** Zero, and the collateral cannot be priced right now. */
  | { kind: 'none-unpriced' }
  /** Zero, and the collateral IS priced: the loan needs all of it. */
  | { kind: 'none-needed' }
  /** Zero, and the app could not tell which of the two applies. */
  | { kind: 'none-unknown' }
  /** The deployment is paused: withdrawals are refused right now. */
  | { kind: 'paused' }
  | { kind: 'some'; max: bigint };

/** Pure — what the page may state about the ceiling. A failed read is
 *  "unconfirmed", never a zero: telling a borrower "you can take back
 *  nothing" on a read the app did not get would be stating an outcome it
 *  cannot substantiate. */
export function classifyMaxWithdrawable(q: {
  data: MaxWithdrawableRead | undefined;
  isError: boolean;
}): MaxWithdrawState {
  if (q.isError) return { kind: 'unconfirmed' };
  if (!q.data) return { kind: 'loading' };
  if (q.data.paused === true) return { kind: 'paused' };
  if (q.data.max > 0n) return { kind: 'some', max: q.data.max };
  if (q.data.illiquid === true) return { kind: 'none-unpriced' };
  if (q.data.illiquid === false) return { kind: 'none-needed' };
  return { kind: 'none-unknown' };
}

/** Pure — why a typed amount cannot be sent, or null when it can. The
 *  ceiling is a snapshot: prices move between the read and the signature,
 *  so an amount at or near it can still be refused on-chain. That is said
 *  beside the input; this only rejects what is already known to fail. */
export function withdrawAmountProblem(args: {
  /** `parseExactUnits` of the typed text — never a rounded parse. */
  parsed: bigint | 'invalid' | 'too-precise';
  state: MaxWithdrawState;
}): 'invalid' | 'too-precise' | 'no-ceiling' | 'over-max' | null {
  if (args.parsed === 'too-precise') return 'too-precise';
  if (args.parsed === 'invalid' || args.parsed <= 0n) return 'invalid';
  if (args.state.kind !== 'some') return 'no-ceiling';
  if (args.parsed > args.state.max) return 'over-max';
  return null;
}

/** Live read of the ceiling. Enabled only for an ERC-20-collateral loan
 *  whose indexed status is active — the contract answers zero for any
 *  other status, and the page does not offer the action there. */
export function useMaxWithdrawable(args: {
  loanId: string | undefined;
  collateralAsset: string | undefined;
  enabled: boolean;
}) {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  return useQuery({
    queryKey: ['maxWithdrawable', readChain.chainId, args.loanId, args.collateralAsset?.toLowerCase()],
    enabled: args.enabled && Boolean(publicClient) && args.loanId !== undefined && Boolean(args.collateralAsset),
    // Collateral and debt prices move; keep the ceiling fresh while the
    // page is open rather than letting a borrower act on an old figure.
    refetchInterval: tipAware(30_000, Boolean(readChain.wsUrl)),
    queryFn: async (): Promise<MaxWithdrawableRead> =>
      readMaxWithdrawable({
        publicClient: publicClient!,
        diamondAddress: readChain.diamondAddress,
        loanId: BigInt(args.loanId!),
        collateralAsset: args.collateralAsset!,
      }),
  });
}

/** The three reads behind `useMaxWithdrawable`. Exported for the tests.
 *  The ceiling read is the one that matters and THROWS on failure (the
 *  query lands in error → "unconfirmed"); the two explanatory reads
 *  degrade to `undefined` rather than failing the whole answer. */
export async function readMaxWithdrawable(opts: {
  publicClient: PublicClient;
  diamondAddress: `0x${string}`;
  loanId: bigint;
  collateralAsset: string;
}): Promise<MaxWithdrawableRead> {
  const [max, illiquid, vpfiToken, paused] = await Promise.all([
    opts.publicClient.readContract({
      address: opts.diamondAddress,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'calculateMaxWithdrawable',
      args: [opts.loanId],
    }) as Promise<bigint>,
    isAssetIlliquidLive({
      publicClient: opts.publicClient,
      diamondAddress: opts.diamondAddress,
      asset: opts.collateralAsset,
      failClosed: true,
    }).catch(() => undefined),
    (
      opts.publicClient.readContract({
        address: opts.diamondAddress,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'getVPFIToken',
      }) as Promise<string>
    ).catch(() => undefined),
    (
      opts.publicClient.readContract({
        address: opts.diamondAddress,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'paused',
      }) as Promise<boolean>
    ).catch(() => undefined),
  ]);
  return {
    max,
    illiquid,
    isVpfi:
      vpfiToken === undefined
        ? undefined
        : vpfiToken.toLowerCase() === opts.collateralAsset.toLowerCase(),
    paused,
  };
}

/** Live check for a swap-to-repay order on the loan. While one is stored
 *  the contract refuses any collateral change (the order was sized
 *  against the collateral as it stood) — including after its deadline,
 *  until it is cancelled. `getIntentCommit` reverts `IntentNoCommit` when
 *  there is none.
 *
 *  Three answers, not two (#2389 r1): only that specific revert means
 *  "no order". Any other failure — transport, rate limit, decoding — is
 *  `unknown`, and the page refuses to open the wallet on it rather than
 *  treating an unread answer as a clear one. */
export async function swapToRepayOrderState(opts: {
  publicClient: PublicClient;
  diamondAddress: `0x${string}`;
  loanId: bigint;
}): Promise<'live' | 'none' | 'unknown'> {
  try {
    await opts.publicClient.readContract({
      address: opts.diamondAddress,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getIntentCommit',
      args: [opts.loanId],
    });
    return 'live';
  } catch (err) {
    return isIntentNoCommit(err) ? 'none' : 'unknown';
  }
}

/** Pure — what the card cannot vouch for while it shows an amount
 *  (#2389 r4). The pre-check re-reads every one of these before the
 *  wallet opens and blocks on any it cannot answer; the card must not
 *  meanwhile present the withdrawal as unconditionally available. Each
 *  unknown is STATED beside the amount rather than hidden until submit:
 *    - `pause-unknown` — the pause read failed;
 *    - `sale-unknown` — no sale-listing answer: the probe failed, or the
 *      deployment predates the bounded-listing check, where a legacy
 *      listing can still exist. */
export type WithdrawCaveat = 'pause-unknown' | 'sale-unknown';

export function withdrawCaveats(a: {
  paused: boolean | undefined;
  /** `useSaleListingHold().data` once it is not resolving. */
  saleHold: SaleListingHoldState | undefined;
}): WithdrawCaveat[] {
  const out: WithdrawCaveat[] = [];
  if (a.paused === undefined) out.push('pause-unknown');
  if (a.saleHold === undefined || a.saleHold === 'unknown') out.push('sale-unknown');
  return out;
}

/** Pure — the decision the page makes from its live pre-checks, just
 *  before the wallet opens (#2389 r2). One rule for every check: a
 *  blocking answer names its obstacle, and an UNANSWERED check blocks
 *  too, with "couldn't check" — never a send on a question the app did
 *  not get an answer to. Order matters only for which reason is shown;
 *  any non-null result sends nothing. */
export type WithdrawPreflightBlock =
  | 'paused'
  | 'pause-unchecked'
  | 'sale-listed'
  | 'sale-unchecked'
  | 'swap-order'
  | 'swap-unchecked'
  | 'over-max'
  | 'none-left';

export function withdrawPreflightBlock(a: {
  /** #2389 r3 — the live pause read; 'unknown' when it failed. */
  paused: boolean | 'unknown';
  saleState: SaleListingHoldState;
  swapOrder: 'live' | 'none' | 'unknown';
  liveMax: bigint;
  wei: bigint;
}): WithdrawPreflightBlock | null {
  if (a.paused === true) return 'paused';
  if (a.paused !== false) return 'pause-unchecked';
  if (a.saleState === 'live' || a.saleState === 'clearable' || a.saleState === 'accepted') {
    return 'sale-listed';
  }
  if (a.saleState !== 'none') return 'sale-unchecked';
  if (a.swapOrder === 'live') return 'swap-order';
  if (a.swapOrder !== 'none') return 'swap-unchecked';
  if (a.wei > a.liveMax) return a.liveMax > 0n ? 'over-max' : 'none-left';
  return null;
}

/** True only for the contract's own "no order stored" revert. */
export function isIntentNoCommit(err: unknown): boolean {
  if (!(err instanceof BaseError)) return false;
  const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
  return (
    revert instanceof ContractFunctionRevertedError &&
    revert.data?.errorName === 'IntentNoCommit'
  );
}
