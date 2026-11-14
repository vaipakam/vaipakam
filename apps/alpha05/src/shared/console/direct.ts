/**
 * RW-77 — the protocol's settings read straight from the chain, every part
 * at ONE block, for when the index's snapshot may not be shown. It uses the
 * same shared readers the index uses to take its snapshot
 * (`@vaipakam/lib/protocolKnobs`), so the two sources name and decode each
 * setting by one rule.
 *
 * The settings bundle carries names only when this build's ABI describes
 * the code that answered it (its host on chain is the one this build's
 * deployment record names). When it does not, the protocol's code has
 * changed since this app was built: the bundle's settings are reported as
 * unanswered, with that reason, rather than shown under names that may
 * belong to other fields.
 */
import type { Abi, Address, PublicClient } from 'viem';
import { AdminFacetABI, DIAMOND_ABI_VIEM, PriceGuardABI, VaultPayoutFacetABI } from '@vaipakam/contracts/abis';
import type { DeploymentFacets } from '@vaipakam/contracts/deployments';
import { LABELLED_GETTER_HOST, abiDescribesGetterAt, abiOutputNames, readProtocolConfigBundle, readProtocolKnobGetters } from '@vaipakam/lib/protocolKnobs';
import type { SettingValues } from './snapshot';

const DIAMOND = DIAMOND_ABI_VIEM as Abi;

/** The settings bundle's output names in this build, in order. */
export const BUNDLE_KEYS: readonly string[] = abiOutputNames(DIAMOND, 'getProtocolConfigBundle') ?? [];

export interface DirectRead {
  block: bigint;
  /** The block's own time (unix seconds). */
  timestamp: number;
  values: SettingValues;
  unreported: string[];
  /** Why the bundle's settings are unanswered, when they are. */
  bundleIssue: { kind: 'codeChanged' } | { kind: 'unreadable'; reason: string } | null;
}

export async function readDirect(client: PublicClient, diamond: Address, facets: DeploymentFacets | undefined): Promise<DirectRead> {
  const head = await client.getBlock({ blockTag: 'latest' });
  const blockNumber = head.number;
  if (blockNumber === null) throw new Error('the chain did not name its latest block');
  const [bundle, bound, knobs] = await Promise.all([
    readProtocolConfigBundle({ client, diamond, abi: DIAMOND, blockNumber }),
    abiDescribesGetterAt({
      client,
      diamond,
      abi: DIAMOND,
      functionName: 'getProtocolConfigBundle',
      expectedHost: facets?.[LABELLED_GETTER_HOST.getProtocolConfigBundle],
      blockNumber,
    }),
    readProtocolKnobGetters({ client, diamond, abi: DIAMOND, guardAbi: PriceGuardABI as Abi, blockNumber, facets }),
  ]);
  const values: SettingValues = {};
  const unreported = [...knobs.unreported];
  let bundleIssue: DirectRead['bundleIssue'] = null;
  if (bundle.kind === 'unreadable') bundleIssue = { kind: 'unreadable', reason: bundle.reason };
  else if (!bound) bundleIssue = { kind: 'codeChanged' };
  if (bundle.kind === 'read' && bound) Object.assign(values, bundle.values);
  else unreported.push(...BUNDLE_KEYS);
  Object.assign(values, knobs.values);
  return { block: blockNumber, timestamp: Number(head.timestamp), values, unreported, bundleIssue };
}

/** The global administrative pause (RB-SWITCH class 2) at one block. It is
 *  live state, never taken from a snapshot: an automatic pause lapses with
 *  the clock and announces nothing when it does. */
export interface PauseRead {
  block: bigint;
  /** The block's own time (unix seconds). */
  timestamp: number;
  paused: boolean;
  /** Whether governance's pause, which has no set end, is in force. It can
   *  run together with an automatic window, so `pausedUntil` alone cannot
   *  say when a pause ends. */
  manual: boolean;
  /** When an automatic pause window ends (unix seconds); 0 when none runs. */
  pausedUntil: bigint;
  /** Under governance's pause, when its escape route reopens withdrawals of
   *  what is free in each vault (unix seconds); 0 when no route is scheduled
   *  (no governance pause, or a protocol not yet launched). */
  escapeOpensAt: bigint;
}

/** The pause log marks the interval of a governance pause in force with this
 *  end: an automatic window is written with its own end. */
const OPEN_END = 2n ** 64n - 1n;

/**
 * The global pause at one block. `paused` and `pausedUntil` cannot tell a
 * governance pause from an automatic window when both run, so a pause is
 * classified from the pause log: its last interval is open exactly while
 * governance's pause is in force. An answer the three reads do not agree
 * on is a failed read, never a guess.
 */
export async function readPauseAt(client: PublicClient, diamond: Address): Promise<PauseRead> {
  const head = await client.getBlock({ blockTag: 'latest' });
  const blockNumber = head.number;
  if (blockNumber === null) throw new Error('the chain did not name its latest block');
  const read = (functionName: 'paused' | 'pausedUntil' | 'getPauseIntervals', args?: readonly unknown[]) =>
    client.readContract({ address: diamond, abi: AdminFacetABI as Abi, functionName, args, blockNumber });
  const [paused, pausedUntil] = (await Promise.all([read('paused'), read('pausedUntil')])) as [boolean, bigint];
  let manual = false;
  let escapeOpensAt = 0n;
  if (paused) {
    // A start past the end returns no interval, only the count.
    const [, total] = (await read('getPauseIntervals', [2n ** 256n - 1n, 0n])) as [unknown, bigint];
    if (total === 0n) throw new Error('the protocol answered paused, but its pause log is empty');
    const [last] = (await read('getPauseIntervals', [total - 1n, 1n])) as [readonly { end: bigint }[], bigint];
    if (last.length !== 1) throw new Error('the pause log did not return its last interval');
    manual = last[0].end === OPEN_END;
    if (!manual && pausedUntil === 0n) throw new Error('the protocol answered paused, with neither a governance pause nor an automatic window');
    if (manual) {
      escapeOpensAt = (await client.readContract({ address: diamond, abi: VaultPayoutFacetABI as Abi, functionName: 'escapeOpensAt', blockNumber })) as bigint;
    }
  }
  return { block: blockNumber, timestamp: Number(head.timestamp), paused, manual, pausedUntil, escapeOpensAt };
}
