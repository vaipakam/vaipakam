// apps/keeper/src/tierExclusionRefresh.ts
//
// #3097 — the TIER-EXCLUSION REFRESH, step 5 of `protocolUpkeep`: the
// keeper's call of `EncumbranceMutateFacet.refreshTierExclusion(loanIds)`.
//
// A loan's VPFI fee-tier exclusion (#2342) keeps VPFI that is owed to another
// wallet out of the vault owner's fee-discount tier: on a terminal loan whose
// position NFT changed hands, what the side is owed; on a FallbackPending VPFI
// loan, the custody row. The contract re-derives it at every edge that
// changes its inputs (a status edge, a position transfer or burn, an
// encumbrance or custody row write). A loan that was terminal before the rule
// was installed passes none of those edges again, and a ledger write on it
// does not notify while its record is unset, so only the permissionless
// refresh brings it into line. The refresh derives everything from on-chain
// state, so a call can only make a record correct, and a repeat call is a
// no-op that emits nothing.
//
// Per chain, per run:
//
//   1. PAGE — one page of the loan id range (`MetricsFacet.getAllLoansPaginated`,
//      every loan ever created, any status), from a stored position that
//      moves on each run and wraps at the end.
//   2. PREVIEW — `refreshTierExclusion(page)` simulated with its logs
//      (`eth_simulateV1`). The contract emits `TierExclusionUpdated` only for
//      a side whose record would change (or fold a pre-#2342 freeze record),
//      so the logs ARE the list of loans the call is due for. A page whose
//      preview shows none costs one simulation, not gas.
//   3. REFRESH — `refreshTierExclusion(due)` for exactly those loans,
//      simulated again by the sender before it goes out. The run's line
//      names each side the receipt re-derived, with the vault owner charged
//      and the VPFI excluded.
//
// The page position moves only once its page is settled: previewed with
// nothing due, or refreshed and landed. A page the run could not preview or
// send waits for the next run rather than being passed.
//
// Permissionless; pays only gas and moves no value. Sale-vehicle records are
// skipped by the paging view and are not refreshed here.
//
// Gated by KEEPER_ENABLED + PROTOCOL_UPKEEP_ENABLED +
// TIER_EXCLUSION_REFRESH_ENABLED. Ships disarmed.

import { decodeEventLog, encodeFunctionData, type Abi, type Address, type Hex, type PublicClient } from 'viem';
import { EncumbranceMutateFacetABI, MetricsFacetABI } from '@vaipakam/contracts/abis';
import { deadlineClient, PastRunDeadline } from './batchRead';
import { boundedCall } from './passReader';
import { shortErr } from './callErrors';
import { priorStageCutoffMs, readCutoffMs } from './runWindow';
import type { ScanCursors } from './scanCursors';
import type { StepSender } from './stepSender';

export const TIER_EXCLUSION_ABI = [...(EncumbranceMutateFacetABI as Abi), ...(MetricsFacetABI as Abi)] as Abi;

/** Loan ids one run previews: ids READ, not loans found (the view skips
 *  sale vehicles, so a page may hold fewer). */
export const TIER_EXCLUSION_PAGE = 100;
/** The stored position in the loan id range where the next page starts. */
export const TIER_EXCLUSION_NEXT_ITEM = 'tier-exclusion-next';
const UPDATED_EVENT = 'TierExclusionUpdated';
const ZERO_ADDRESS = /^0x0{40}$/i;

/** What the step reads and signs with. */
export interface TierExclusionDeps {
  /** Plain client; every read here carries its own cutoff. */
  readClient: PublicClient;
  /** The keeper's address, which the preview is simulated from. */
  keeper: Address | null;
  sendDeadline: number;
  cursors: ScanCursors;
}

/** What the step did on one chain. */
export interface TierExclusionReport {
  /** Why it did nothing this run, when it did nothing. */
  off: string | null;
  /** The loan id positions the page read (`from`..`to`, 1-based ids), and
   *  how many loans it held. */
  page: { from: bigint; to: bigint; loans: number } | null;
  /** Loans the preview showed a refresh would change. */
  due: bigint[];
  /** Sides the landed refresh re-derived, from its receipt:
   *  `7 lender: 0x… 120 wei` or `7 borrower: none`. */
  refreshed: string[];
  /** Whether the landed refresh's receipt was read. */
  landedUnread: boolean;
}

export function emptyTierExclusionReport(): TierExclusionReport {
  return { off: null, page: null, due: [], refreshed: [], landedUnread: false };
}

/** The step's figures for the run's line. */
export function describeTierExclusion(r: TierExclusionReport | null): string[] {
  if (r === null) return ['tier-exclusion-refresh=off (TIER_EXCLUSION_REFRESH_ENABLED not armed)'];
  if (r.off !== null) return [`tier-exclusion-refresh=not worked (${r.off})`];
  const page = r.page === null ? 'none' : `ids ${r.page.from}-${r.page.to} (${r.page.loans} loans)`;
  return [
    `tier-exclusion-page=${page}`,
    `tier-exclusion-due=${r.due.join(',') || 'none'}`,
    ...(r.refreshed.length > 0 ? [`tier-exclusion-refreshed=${r.refreshed.join('; ')}`] : []),
    ...(r.landedUnread ? ['tier-exclusion-event-unread=the refresh landed and its receipt was not read'] : []),
  ];
}

/** One side's re-derived exclusion, from a `TierExclusionUpdated` log. */
export interface ExclusionUpdate {
  loanId: bigint;
  lenderSide: boolean;
  vaultOwner: Address;
  excludedVpfi: bigint;
}

/** The `TierExclusionUpdated` logs the Diamond emitted, in order. Exported for tests. */
export function exclusionUpdates(diamond: Address, logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[]): ExclusionUpdate[] {
  const out: ExclusionUpdate[] = [];
  for (const log of logs) {
    if (log.address.toLowerCase() !== diamond.toLowerCase()) continue;
    let ev;
    try {
      ev = decodeEventLog({ abi: TIER_EXCLUSION_ABI, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    } catch {
      continue;
    }
    if (ev.eventName !== UPDATED_EVENT) continue;
    const a = ev.args as unknown as Record<string, unknown>;
    out.push({ loanId: BigInt(a.loanId as bigint), lenderSide: a.lenderSide === true, vaultOwner: a.vaultOwner as Address, excludedVpfi: BigInt(a.excludedVpfi as bigint) });
  }
  return out;
}

const describeUpdate = (u: ExclusionUpdate) =>
  `${u.loanId} ${u.lenderSide ? 'lender' : 'borrower'}: ${ZERO_ADDRESS.test(u.vaultOwner) ? 'none' : `${u.vaultOwner.toLowerCase()} ${u.excludedVpfi} wei`}`;

/** The stored page position, or the start of the range. */
function readPosition(raw: string | undefined): bigint {
  return raw !== undefined && /^\d+$/.test(raw) ? BigInt(raw) : 0n;
}

/** One chain's step. It never throws for running out of time: a stage that
 *  reaches its cutoff is reported in the step's own report and the page
 *  position stays where it is, so the next run reads the same page. */
export async function refreshTierExclusions(diamond: Address, sender: StepSender, deps: TierExclusionDeps): Promise<TierExclusionReport> {
  const out = emptyTierExclusionReport();
  // The preview by the read cutoff, which reserves the send's time; the page
  // (and the stored position) a stage reserve before it (runWindow.ts rule 3).
  const previewCutoff = readCutoffMs(deps.sendDeadline);
  const pageCutoff = priorStageCutoffMs(previewCutoff);
  if (deps.keeper === null) {
    sender.noteUnread('tier-exclusion', 'the keeper key (no account to preview the refresh from)');
    out.off = 'no keeper key to preview the refresh from';
    return out;
  }
  const keeper = deps.keeper;

  // 1. The page.
  let cursor: bigint;
  let ids: bigint[];
  let next: bigint;
  try {
    const stored = await boundedCall(pageCutoff, 'the tier-exclusion position', () => deps.cursors.get([TIER_EXCLUSION_NEXT_ITEM]));
    cursor = readPosition(stored.get(TIER_EXCLUSION_NEXT_ITEM));
    const pageClient = deadlineClient(deps.readClient, pageCutoff);
    const [got, nextCursor] = (await boundedCall(pageCutoff, 'the loan id page', () =>
      pageClient.readContract({ address: diamond, abi: TIER_EXCLUSION_ABI, functionName: 'getAllLoansPaginated', args: [cursor, BigInt(TIER_EXCLUSION_PAGE)] }),
    )) as readonly [readonly bigint[], bigint, bigint];
    ids = got.map((x) => BigInt(x));
    next = BigInt(nextCursor);
  } catch (err) {
    sender.noteUnread('tier-exclusion', `the loan id page (${shortErr(err)})`);
    out.off = 'the loan id page was not read';
    return out;
  }
  out.page = { from: cursor + 1n, to: next, loans: ids.length };
  // A page that read fewer ids than it asked for reached the end of the range:
  // the next run starts over at the first loan.
  const reachedEnd = next - cursor < BigInt(TIER_EXCLUSION_PAGE);
  // Written by the send deadline, not the read cutoff: it follows the send.
  const settle = () =>
    boundedCall(deps.sendDeadline, 'the tier-exclusion position', () => deps.cursors.put(TIER_EXCLUSION_NEXT_ITEM, reachedEnd ? '' : next.toString())).catch(
      () => undefined,
    );
  if (ids.length === 0) {
    await settle();
    return out;
  }

  // 2. The preview.
  let results;
  try {
    ({ results } = await boundedCall(previewCutoff, 'the tier-exclusion preview', () =>
      deps.readClient.simulateCalls({
        account: keeper,
        calls: [{ to: diamond, data: encodeFunctionData({ abi: TIER_EXCLUSION_ABI, functionName: 'refreshTierExclusion', args: [ids] }) }],
      }),
    ));
  } catch (err) {
    sender.noteUnread('tier-exclusion', `the refresh preview (eth_simulateV1: ${shortErr(err)})`);
    out.off = err instanceof PastRunDeadline ? 'the refresh preview was not read by its cutoff' : 'the refresh preview could not be read';
    return out;
  }
  const res = results[0];
  if (!res || res.status !== 'success' || res.logs === undefined) {
    // A preview that reverted is the refusal the sender would meet anyway; one
    // without logs has not shown which loans the call would change.
    const why = res?.status === 'success' ? 'the refresh preview reported no logs' : 'the refresh preview reverted';
    sender.noteUnread('tier-exclusion', why);
    out.off = why;
    return out;
  }
  const inPage = new Set(ids.map(String));
  out.due = [...new Set(exclusionUpdates(diamond, res.logs as never).map((u) => u.loanId).filter((id) => inPage.has(String(id))).map(String))].map(BigInt);
  if (out.due.length === 0) {
    await settle();
    return out;
  }

  // 3. The refresh, for exactly the loans it would change.
  const sent = await sender.call('tier-exclusion', `loans ${out.due.join(',')}`, 'refreshTierExclusion', [out.due]);
  if (sent !== 'landed') return out;
  if (sender.receipt === null) out.landedUnread = true;
  else out.refreshed = exclusionUpdates(diamond, sender.receipt.logs as never).map(describeUpdate);
  await settle();
  return out;
}
