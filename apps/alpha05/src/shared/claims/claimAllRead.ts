/**
 * LN-51 — what Claim everything stands on, read from the chain: every payout
 * source read together through the wallet's connection (the views at one
 * block; the loan rows and the rewards preview each pin the block they
 * read), then the protocol's
 * own dry run of the batch the reader picked (`multicall` run as a call, so
 * each payout answers for itself exactly as the transaction would run it).
 *
 * Sources: the loan payouts the position book finds (each read as its claim
 * reads it), the rewards claim run as a preview and a held reward, the
 * wallet's standing offers by owner (their un-lent capital), the free VPFI
 * in the wallet's vault, and the payroll streams paying the wallet. A source
 * whose read fails is null and the list names it as left out.
 */
import type { Abi, PublicClient } from 'viem';
import { AdminFacetABI, LenderIntentFacetABI, MulticallFacetABI, PayrollFacetABI, VaultDepositoryFacetABI } from '@vaipakam/contracts/abis';
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess } from '../copy/useCopy';
import { refusalFromError } from '../eligibility/refusal';
import type { Payouts } from '../positions/reads';
import { readProtection } from '../protection/payout';
import { answerOrNull } from '../reads/answer';
import { frozenState, readSanctionsPosture } from '../sanctions/posture';
import { askThrough } from '../tx/simulate';
import { batchCalls, batchOf, batchStop, claimAllList, legResults, type ClaimAllInputs, type ClaimAllList, type ClaimAllReview } from './claimAll';
import { readLoanClaimRows } from './loanClaimRows';
import { readHeldRewards, readPendingRewards, readVpfiToken } from './rewards';

type Hex = `0x${string}`;

const ADMIN = AdminFacetABI as Abi;
const INTENT = LenderIntentFacetABI as Abi;
const DEPOSITORY = VaultDepositoryFacetABI as Abi;
const PAYROLL = PayrollFacetABI as Abi;
export const MULTICALL = MulticallFacetABI as Abi;

/** Standing offers one page reads, and the pages read at most. */
const INTENT_PAGE = 50n;
const INTENT_PAGES = 4;
/** Payroll streams read at most (ids from 1); payroll is the protocol's own
 *  staff payroll, a short list. */
export const PAYROLL_MAX_STREAMS = 100;

type IntentRow = { intent: { owner: Hex; lendingAsset: Hex; collateralAsset: Hex; availableCapital: bigint }; active: boolean };

async function readIntents(c: PublicClient, diamond: Hex, account: Hex, blockNumber: bigint): Promise<ClaimAllInputs['intents']> {
  const rows: NonNullable<ClaimAllInputs['intents']>['rows'] = [];
  let offset = 0n;
  for (let n = 0; n < INTENT_PAGES; n++) {
    const [page, total] = (await c.readContract({
      address: diamond,
      abi: INTENT,
      functionName: 'getLenderIntentsByOwner',
      args: [account, offset, INTENT_PAGE],
      blockNumber,
    })) as readonly [readonly IntentRow[], bigint];
    for (const r of page) rows.push({ lendingAsset: r.intent.lendingAsset, collateralAsset: r.intent.collateralAsset, available: r.intent.availableCapital, active: r.active });
    offset += INTENT_PAGE;
    if (offset >= total) return { rows, complete: true };
  }
  return { rows, complete: false };
}

type Stream = { beneficiary: Hex; asset: Hex; exists: boolean };

async function readPayroll(c: PublicClient, diamond: Hex, account: Hex, blockNumber: bigint): Promise<ClaimAllInputs['payroll']> {
  const count = (await c.readContract({ address: diamond, abi: PAYROLL, functionName: 'getPayrollStreamCount', blockNumber })) as bigint;
  const ids = Array.from({ length: Math.min(Number(count), PAYROLL_MAX_STREAMS) }, (_, n) => BigInt(n + 1));
  const streams = await Promise.all(
    ids.map((id) => c.readContract({ address: diamond, abi: PAYROLL, functionName: 'getPayrollStream', args: [id], blockNumber }) as Promise<Stream>),
  );
  const mine = ids.filter((_, n) => streams[n]!.exists && streams[n]!.beneficiary.toLowerCase() === account.toLowerCase());
  const due = await Promise.all(
    mine.map((id) => c.readContract({ address: diamond, abi: PAYROLL, functionName: 'getWithdrawableSalary', args: [id], blockNumber }) as Promise<bigint>),
  );
  return {
    rows: mine.map((id, n) => ({ streamId: id, asset: streams[ids.indexOf(id)]!.asset, withdrawable: due[n]! })),
    complete: Number(count) <= PAYROLL_MAX_STREAMS,
  };
}

/** Every source, read together (`payouts` from the position book; null
 *  while it is unread, which leaves the loans unread rather than empty). */
export async function readClaimAllInputs(c: PublicClient, diamond: Hex, account: Hex, payouts: Payouts | null): Promise<ClaimAllInputs> {
  const blockNumber = await c.getBlockNumber({ cacheTime: 0 });
  const at = { blockNumber };
  const [paused, loans, rewards, held, vpfiToken, intents, payroll, protection, posture] = await Promise.all([
    answerOrNull(c.readContract({ address: diamond, abi: ADMIN, functionName: 'paused', ...at }) as Promise<boolean>),
    payouts === null ? Promise.resolve(null) : answerOrNull(readLoanClaimRows(c, diamond, payouts)),
    answerOrNull(readPendingRewards(c, diamond, account)),
    answerOrNull(readHeldRewards(c, diamond, account)),
    answerOrNull(readVpfiToken(c, diamond)),
    answerOrNull(readIntents(c, diamond, account, blockNumber)),
    answerOrNull(readPayroll(c, diamond, account, blockNumber)),
    readProtection(c, diamond, account, blockNumber),
    answerOrNull(readSanctionsPosture(c, diamond, account, blockNumber)),
  ]);
  const vpfiFree =
    vpfiToken === null
      ? null
      : /^0x0{40}$/i.test(vpfiToken)
        ? 0n
        : await answerOrNull(c.readContract({ address: diamond, abi: DEPOSITORY, functionName: 'freeHolding', args: [account, 0, vpfiToken, 0n], ...at }) as Promise<bigint>);
  return { account, paused, frozen: frozenState(posture), protection, loans, rewards, held, vpfiToken, intents, vpfiFree, payroll };
}

export async function readClaimAllList(c: PublicClient, diamond: Hex, account: Hex, payouts: Payouts | null, copy: Pick<CopyAccess, 'text'>): Promise<ClaimAllList> {
  return claimAllList(await readClaimAllInputs(c, diamond, account, payouts), copy, Date.now());
}

/**
 * The review of the picked legs: the list read again, the batch bounded,
 * and the protocol's dry run of the legs this transaction would send. A leg
 * the dry run refuses is left out of the transaction, with the protocol's
 * reason; the rest are sent.
 */
export async function readClaimAllReview(
  own: OwnStateClient,
  diamond: Hex,
  payouts: Payouts | null,
  picked: readonly string[],
  identity: string,
  copy: Pick<CopyAccess, 'text'>,
): Promise<ClaimAllReview> {
  const account = own.account;
  const list = (await own.read((c: PublicClient) => readClaimAllList(c, diamond, account, payouts, copy))).value;
  const readAt = Date.now();
  const { now, later } = batchOf(list.legs, new Set(picked));
  const base = { identity, list, picked: [...picked], later, readAt };
  if (batchStop(list, copy) !== null || now.length === 0) return { ...base, send: [], refused: [], dryRun: 'skipped' };
  const dry = await askThrough(own, (c) =>
    c
      .simulateContract({ address: diamond, abi: MULTICALL, functionName: 'multicall', args: [batchCalls(now, account)], account })
      .then((x) => x.result as readonly { success: boolean; returnData: Hex }[]),
  );
  if (dry.kind === 'unreadable') return { ...base, send: [], refused: [], dryRun: 'unread' };
  if (dry.kind === 'reverted') return { ...base, send: [], refused: [], dryRun: refusalFromError(dry.error) };
  const results = legResults(now, dry.value);
  return {
    ...base,
    send: now.filter((l) => results.get(l.key) === null),
    refused: now.flatMap((l) => {
      const refusal = results.get(l.key);
      return refusal ? [{ leg: l, refusal }] : [];
    }),
    dryRun: null,
  };
}
