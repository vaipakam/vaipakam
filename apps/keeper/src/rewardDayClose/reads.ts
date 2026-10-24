// apps/keeper/src/rewardDayClose/reads.ts
//
// Every chain read the pass judges by. Each returns a Fact (known, or unknown
// with why), never a default standing in for a failed read: what a caller
// does with an unknown is the caller's rule, stated where it is applied.
//
// A read refused because the run's deadline has passed (`PastRunDeadline`)
// is not a fact about the chain: it stops the run, which a later run repeats.

import type { Abi, Address, PublicClient } from 'viem';
import { boundedRead, PastRunDeadline } from '../batchRead';
import { ABI, MESSENGER_ABI, NO_SELECTOR, READ_CHUNK, REASON_FINALIZED } from './constants';
import type { ChainRun, PeerReader } from './deps';
import { classify, revertName, shortErr } from './errors';
import { known, unknown, type Fact, type PerDay } from './fact';
import type { DestinationState } from './plan';

/** One read, as a Fact. A failure is logged with `label`. */
export async function readOne<T>(client: PublicClient, address: Address, abi: Abi, functionName: string, args: readonly unknown[], label: string, blockNumber?: bigint): Promise<Fact<T>> {
  try {
    return known((await client.readContract({ address, abi, functionName, args, ...(blockNumber === undefined ? {} : { blockNumber }) })) as T);
  } catch (err) {
    if (err instanceof PastRunDeadline) throw err;
    console.error(`[keeper] rewardDayClose ${label} unread: ${shortErr(err)}`);
    return unknown(shortErr(err));
  }
}

/** One batched read of a view an older Diamond may not route: its value;
 *  `null` when the Diamond ANSWERED that it routes no such function
 *  (`FunctionDoesNotExist`), which is the one definitive sign the build keeps
 *  no such record; otherwise unknown. A failed read is never taken for an
 *  older build: that would turn a transient RPC error into a fallback the
 *  caller records for good (#2645 r1). */
export function routedOrAbsent<T>(r: { status: string; result?: unknown; error?: unknown } | undefined, what: string): Fact<T> | null {
  if (r?.status === 'success') return known(r.result as T);
  if (r !== undefined && revertName(r.error) === NO_SELECTOR) return null;
  return unknown(`${what} unread${r?.error === undefined ? '' : ` (${shortErr(r.error)})`}`);
}

/** `contracts` read in aggregates of {@link READ_CHUNK}, results in order. A
 *  slice that fails reads as failures for its own entries only. */
async function chunkedRead(client: PublicClient, contracts: readonly unknown[], label: string, deadline: number): Promise<Awaited<ReturnType<typeof boundedRead>>> {
  const out: Awaited<ReturnType<typeof boundedRead>> = [];
  for (let i = 0; i < contracts.length; i += READ_CHUNK) {
    // eslint-disable-next-line no-await-in-loop
    out.push(...(await boundedRead(client as never, contracts.slice(i, i + READ_CHUNK), label, deadline)));
  }
  return out;
}

/** One per-day view of the run's own Diamond over `days`, batched. */
export async function readDays<T>(c: ChainRun, days: readonly number[], functionName: string): Promise<PerDay<T>> {
  const out: PerDay<T> = new Map();
  if (days.length === 0) return out;
  const res = await chunkedRead(
    c.deps.readClient,
    days.map((d) => ({ address: c.diamond, abi: ABI, functionName, args: [BigInt(d)] })),
    `rewardDayClose ${c.where} ${functionName}`,
    c.deps.sendDeadline,
  );
  days.forEach((d, i) => out.set(d, res[i]?.status === 'success' ? known(res[i].result as T) : unknown(`${functionName} unread`)));
  return out;
}

/** Per day, which expected chains Base has recorded a report from, and which
 *  it could not be read for: a failed read is UNKNOWN, never "missing", so it
 *  can neither complete coverage nor be stated as an absent report. */
export async function readReported(c: ChainRun, days: readonly number[], expected: readonly number[]): Promise<Map<number, { reported: Set<number>; unknown: Set<number> }>> {
  const out = new Map<number, { reported: Set<number>; unknown: Set<number> }>();
  for (const d of days) out.set(d, { reported: new Set(), unknown: new Set() });
  const pairs = days.flatMap((d) => expected.map((x) => [d, x] as const));
  if (pairs.length === 0) return out;
  const res = await chunkedRead(
    c.deps.readClient,
    pairs.map(([d, x]) => ({ address: c.diamond, abi: ABI, functionName: 'isChainReported', args: [BigInt(d), x] })),
    `rewardDayClose ${c.where} isChainReported`,
    c.deps.sendDeadline,
  );
  pairs.forEach(([d, x], i) => {
    const day = out.get(d)!;
    if (res[i]?.status !== 'success') day.unknown.add(x);
    else if (res[i].result === true) day.reported.add(x);
  });
  return out;
}

/** What a mirror reads of one day on Base: whether Base has finalized it,
 *  whether it holds this chain's report,
 *  and whether it included that report in the finalized day (#2626). `included`
 *  is `null` only on a Base that answered it keeps no such record (built
 *  before #2626); a failed read of it is unknown, like every other. Each read
 *  stands alone: a failed one must not hide another. */
export interface BaseDay {
  finalized: Fact<boolean>;
  counted: Fact<boolean>;
  included: Fact<boolean> | null;
}

export async function readBaseDays(base: PeerReader, days: readonly number[], self: number, deadline: number): Promise<Map<number, BaseDay>> {
  const out = new Map<number, BaseDay>();
  if (days.length === 0) return out;
  const res = await chunkedRead(
    base.client,
    days.flatMap((d) => [
      { address: base.diamond, abi: ABI, functionName: 'isDayReadyToFinalize', args: [BigInt(d)] },
      { address: base.diamond, abi: ABI, functionName: 'isChainReported', args: [BigInt(d), self] },
      { address: base.diamond, abi: ABI, functionName: 'isChainIncluded', args: [BigInt(d), self] },
    ]),
    'rewardDayClose base day view',
    deadline,
  );
  days.forEach((d, i) => {
    const ready = res[3 * i];
    const counted = res[3 * i + 1];
    const included = res[3 * i + 2];
    const r = ready?.status === 'success' ? (ready.result as readonly [boolean, number]) : null;
    out.set(d, {
      finalized: r === null ? unknown('readiness on Base unread') : known(Number(r[1]) === REASON_FINALIZED),
      counted: counted?.status === 'success' ? known(counted.result === true) : unknown("Base's record of this chain's report unread"),
      included: routedOrAbsent<boolean>(included, "Base's record of whether it included this chain's report"),
    });
  });
  return out;
}

/** A chain's reward-clock launch timestamp. */
export async function launchOf(p: PeerReader, where: string): Promise<Fact<number>> {
  const f = await readOne<bigint>(p.client, p.diamond, ABI, 'getInteractionLaunchTimestamp', [], `${where}: reward clock of the peer at ${p.diamond}`);
  return f.known ? known(Number(f.value)) : f;
}

/** A peer Diamond's reward role (canonical, mirror, or neither). */
export async function roleOf(p: PeerReader, where: string): Promise<Fact<number>> {
  const f = await readOne<number | bigint>(p.client, p.diamond, ABI, 'getRewardRole', [], `${where}: reward role of the peer at ${p.diamond}`);
  return f.known ? known(Number(f.value)) : f;
}

/** A Diamond's expected-source list (meaningful on Base). */
export async function expectedSources(p: PeerReader, where: string): Promise<Fact<number[]>> {
  const f = await readOne<readonly (number | bigint)[]>(p.client, p.diamond, ABI, 'getExpectedSourceChainIds', [], `${where}: Base's expected-source list`);
  return f.known ? known(f.value.map(Number)) : f;
}

/** The reward messenger the Diamond held at `blockNumber` (or now). */
export async function messengerAt(c: ChainRun, blockNumber: bigint | 'latest'): Promise<Fact<Address>> {
  const at = blockNumber === 'latest' ? undefined : blockNumber;
  const f = await readOne<readonly [Address, ...unknown[]]>(c.deps.client, c.diamond, ABI, 'getRewardReporterConfig', [], `${c.where}: reward messenger at block ${blockNumber}`, at);
  return f.known ? known(f.value[0]) : f;
}

/** The messenger's broadcast destinations (no messenger, or one that
 *  predates the list, reads as unknown like a failed read). */
export async function broadcastDestinations(client: PublicClient, messenger: Address, where: string): Promise<Fact<number[]>> {
  const f = await readOne<readonly bigint[]>(client, messenger, MESSENGER_ABI, 'getBroadcastDestinations', [], `${where}: broadcast destinations`);
  return f.known ? known(f.value.map(Number)) : f;
}

/** On Base: when each of `chains` sent its report for `day`, read on that
 *  chain (0 = not sent; unknown = not served by this keeper, or unread). */
export async function peerSentAt(c: ChainRun, chains: readonly number[], day: number): Promise<Map<number, Fact<number>>> {
  const out = new Map<number, Fact<number>>();
  const where = c.where;
  for (const x of chains) {
    // eslint-disable-next-line no-await-in-loop
    const p = await c.peers.peer(x);
    if (!p) {
      out.set(x, unknown('not served by this keeper'));
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const f = await readOne<bigint>(p.client, p.diamond, ABI, 'getChainReportSentAt', [BigInt(day)], `${where}: chain ${x}'s report time for day ${day}`);
    out.set(x, f.known ? known(Number(f.value)) : f);
  }
  return out;
}

/** Each destination's state for `day`: read on that chain when served. */
export async function destinationStates(c: ChainRun, destinations: readonly number[], day: number): Promise<Map<number, DestinationState>> {
  const out = new Map<number, DestinationState>();
  const where = c.where;
  for (const x of destinations) {
    // eslint-disable-next-line no-await-in-loop
    const p = await c.peers.peer(x);
    if (!p) {
      out.set(x, 'unserved');
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const f = await readOne<readonly [bigint, bigint, boolean]>(p.client, p.diamond, ABI, 'getKnownGlobalInterestNumeraire18', [BigInt(day)], `${where}: day ${day} on chain ${x}`);
    out.set(x, !f.known ? 'unread' : f.value[2] ? 'received' : 'missing');
  }
  return out;
}

/** The messenger's fee for the report `closeDay` sends: the one report shape
 *  (#2621), sent to the chain this Diamond names as Base, which is the route
 *  `closeDay` asks the messenger for. The payload is fixed-width, so zero
 *  figures price it exactly. A refusal the messenger names is returned by name
 *  (a messenger routed to another Base refuses with `ReportRouteMismatch`, and
 *  so would the close); an unnamed one is a messenger without this report
 *  shape. */
export async function reportFee(client: PublicClient, messenger: Address, baseChainId: number, day: number): Promise<{ fee: bigint } | { refused: string } | 'unread'> {
  const report = {
    dayId: BigInt(day),
    lenderNumeraire18: 0n,
    borrowerNumeraire18: 0n,
    recycledCumulative18: 0n,
    recycledForDay18: 0n,
    commitRetiredCumulative18: 0n,
    commitReleasedCumulative18: 0n,
    custodyEra: 0n,
    rewardLaunchTimestamp: 0n,
  };
  try {
    const fee = (await client.readContract({ address: messenger, abi: MESSENGER_ABI, functionName: 'quoteSendChainReport', args: [BigInt(baseChainId), report] })) as bigint;
    return { fee };
  } catch (err) {
    if (err instanceof PastRunDeadline) throw err;
    if ('unread' in classify(err)) return 'unread';
    const name = revertName(err);
    return { refused: name === undefined ? 'the messenger has no quote for the report closeDay sends (it predates the one report shape)' : `the messenger would not quote the report fee (${name})` };
  }
}

export type Quote = { fee: bigint } | { refused: string } | { unread: string };

/** A Diamond fee quote, the reason the contract refused it, or that the RPC
 *  did not answer (logged; never reported as a refusal). */
export async function quote(client: PublicClient, diamond: Address, functionName: string, args: readonly unknown[]): Promise<Quote> {
  try {
    return { fee: (await client.readContract({ address: diamond, abi: ABI, functionName, args })) as bigint };
  } catch (err) {
    if (err instanceof PastRunDeadline) throw err;
    const c = classify(err);
    if ('unread' in c) console.error(`[keeper] rewardDayClose ${functionName} unread, the RPC did not answer: ${c.unread}`);
    return c;
  }
}
