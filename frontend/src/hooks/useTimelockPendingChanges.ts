/**
 * T-042 Phase 4b — Timelock pending-changes reader.
 *
 * Vaipakam's governance topology routes Safe → OpenZeppelin
 * `TimelockController` → Diamond. Every approved Safe proposal that
 * targets a governance setter on the Diamond first sits in the
 * Timelock for the configured delay window before it can be
 * executed. The admin dashboard surfaces this in two places:
 *
 *   - Per-knob badge on each card: "1 PENDING — executes in 47h".
 *   - Banner at the top of the dashboard when ANY pending change is
 *     in flight.
 *
 * This hook does the on-chain reading. Implementation:
 *
 *   1. Get the timelock address from `deployments.json` for the
 *      active chain. Soft-skip if unset (pre-handover deploys
 *      have no timelock yet — surfaces empty result).
 *   2. Pull `CallScheduled` events from the timelock for the last N
 *      blocks (chunked window — 24h–48h is plenty given the
 *      delay is typically 24-48h).
 *   3. Filter to events whose `target` is the Diamond on this chain.
 *   4. For each candidate, call `getOperationState(id)` to determine
 *      if it's still pending (Waiting=1 or Ready=2). Skip Done=3
 *      and Cancelled (a cancel-event-driven removal would also
 *      work; getOperationState is simpler + authoritative).
 *   5. Decode the call's first 4 bytes against `DIAMOND_ABI` to
 *      identify the setter, match it to the knob catalogue.
 *   6. Compute the executesAt timestamp (`scheduledAt + delay`).
 *
 * Returns a mapping from knob id → pending changes targeting it.
 */

import { useEffect, useState, useMemo } from 'react';
import {
  decodeFunctionData,
  keccak256,
  toBytes,
  type Abi,
  type Address,
} from 'viem';
import { useDiamondPublicClient, useReadChain } from '../contracts/useDiamond';
import { DIAMOND_ABI_VIEM } from '../contracts/abis';
import { ADMIN_KNOBS } from '../lib/adminKnobsZones';
import { getDeployment } from '../contracts/deployments';

/** Minimal TimelockController surface — events + state read. Avoids
 *  a full ABI export; OpenZeppelin's contract is stable + we only
 *  read 3 events and 1 view function. */
const TIMELOCK_ABI: Abi = [
  {
    type: 'event',
    name: 'CallScheduled',
    inputs: [
      { name: 'id', type: 'bytes32', indexed: true },
      { name: 'index', type: 'uint256', indexed: true },
      { name: 'target', type: 'address', indexed: false },
      { name: 'value', type: 'uint256', indexed: false },
      { name: 'data', type: 'bytes', indexed: false },
      { name: 'predecessor', type: 'bytes32', indexed: false },
      { name: 'delay', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'function',
    name: 'getOperationState',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'getTimestamp',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
];

/** TimelockController operation states. */
const OP_STATE_UNSET = 0;
// Note: state value 1 is "Waiting" — implicit (we accept anything
// other than UNSET / DONE as pending). Inlined comment instead of
// an unused const so tsc's noUnusedLocals stays happy.
const OP_STATE_READY = 2;
const OP_STATE_DONE = 3;

/** A pending governance change waiting in the timelock. */
export interface PendingChange {
  /** Timelock operation id. Stable across the schedule → execute
   *  lifecycle so the indicator can deduplicate. */
  id: `0x${string}`;
  /** Knob this change targets. `null` when the calldata doesn't map
   *  to any knob in the dashboard catalogue (e.g. a low-level
   *  diamond cut, a facet upgrade, etc.). Pending changes with
   *  `knobId === null` show up in the global banner but not on
   *  any specific card. */
  knobId: string | null;
  /** Function name decoded from the calldata. Used in the badge
   *  copy ("1 PENDING — setStakingApr"). */
  functionName: string;
  /** Decoded args. Best-effort; some calls may fail to decode if
   *  the ABI doesn't match (shouldn't happen in practice since the
   *  diamond ABI bundle covers every setter). */
  args: ReadonlyArray<unknown> | null;
  /** Unix seconds at which the operation becomes executable. */
  executesAt: number;
  /** True when the timelock delay has elapsed and the operation can
   *  be executed (state = Ready). Useful for the badge to
   *  distinguish "will be executable" from "already executable —
   *  waiting on a final approval click". */
  ready: boolean;
}

export type PendingChangesByKnob = Record<string, PendingChange[]>;

interface Hook {
  byKnob: PendingChangesByKnob;
  /** All pending changes including ones not matched to a knob.
   *  Used by the dashboard banner. */
  all: PendingChange[];
  loading: boolean;
  error?: string;
}

/** Lookback window in blocks. 50_000 ≈ ~7 days on a 12s-block chain
 *  (Ethereum), ~28h on Base/Optimism (2s blocks), ~3h on Polygon
 *  (~1s blocks). Generous for any timelock delay we'd run with;
 *  bounds the `eth_getLogs` call so public RPCs accept it. */
const LOOKBACK_BLOCKS = 50_000n;

export function useTimelockPendingChanges(): Hook {
  const client = useDiamondPublicClient();
  const chain = useReadChain();

  const timelockAddr = useMemo(() => {
    const dep = getDeployment(chain.chainId);
    return (dep?.timelock as Address | undefined) ?? null;
  }, [chain.chainId]);

  // Pre-compute selector → knob.id map for fast calldata matching.
  const selectorMap = useMemo(() => buildSelectorMap(), []);

  const [state, setState] = useState<Hook>({
    byKnob: {},
    all: [],
    loading: true,
  });

  useEffect(() => {
    if (!timelockAddr || !chain.diamondAddress) {
      setState({ byKnob: {}, all: [], loading: false });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const head = await client.getBlockNumber();
        const fromBlock =
          head > LOOKBACK_BLOCKS ? head - LOOKBACK_BLOCKS : 0n;
        const events = await client.getContractEvents({
          address: timelockAddr,
          abi: TIMELOCK_ABI,
          eventName: 'CallScheduled',
          fromBlock,
          toBlock: head,
        });
        const diamondLower = chain.diamondAddress!.toLowerCase();
        // Filter to ops that target the Diamond. Ignore ops to other
        // contracts (e.g. timelock-self-management, facet upgrades —
        // those don't show up as knob changes).
        const candidates = events.filter((ev) => {
          const args = ev.args as { target?: Address };
          return (args.target ?? '').toLowerCase() === diamondLower;
        });
        // Resolve each candidate's current state + the resolved
        // executesAt timestamp.
        const resolved = await Promise.all(
          candidates.map(async (ev) => {
            const args = ev.args as {
              id: `0x${string}`;
              target: Address;
              data: `0x${string}`;
              delay: bigint;
            };
            try {
              const stateNum = (await client.readContract({
                address: timelockAddr,
                abi: TIMELOCK_ABI,
                functionName: 'getOperationState',
                args: [args.id],
              })) as number;
              if (
                stateNum === OP_STATE_UNSET ||
                stateNum === OP_STATE_DONE
              ) {
                return null;
              }
              const timestamp = (await client.readContract({
                address: timelockAddr,
                abi: TIMELOCK_ABI,
                functionName: 'getTimestamp',
                args: [args.id],
              })) as bigint;
              const decoded = tryDecodeCalldata(args.data);
              const knobId = decoded
                ? selectorMap[decoded.selector] ?? null
                : null;
              const change: PendingChange = {
                id: args.id,
                knobId,
                functionName: decoded?.functionName ?? '<unknown>',
                args: decoded?.args ?? null,
                executesAt: Number(timestamp),
                ready: stateNum === OP_STATE_READY,
              };
              return change;
            } catch {
              return null;
            }
          }),
        );
        if (cancelled) return;
        const all: PendingChange[] = resolved.filter(
          (c): c is PendingChange => c !== null,
        );
        const byKnob: PendingChangesByKnob = {};
        for (const c of all) {
          if (c.knobId == null) continue;
          if (!byKnob[c.knobId]) byKnob[c.knobId] = [];
          byKnob[c.knobId].push(c);
        }
        setState({ byKnob, all, loading: false });
      } catch (err) {
        if (cancelled) return;
        setState({
          byKnob: {},
          all: [],
          loading: false,
          error: err instanceof Error ? err.message.slice(0, 160) : String(err),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, chain.diamondAddress, chain.chainId, timelockAddr, selectorMap]);

  return state;
}

/** Build a `{selector → knobId}` map by walking the knob catalogue
 *  and computing each setter's 4-byte selector via the diamond ABI.
 *  Cached for the lifetime of the page (knobs don't change at
 *  runtime). */
function buildSelectorMap(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const knob of ADMIN_KNOBS) {
    // Skip VPFIBuyReceiver knobs — those target the standalone
    // contract, not the diamond, so the timelock won't see them
    // unless they're also routed through the timelock (which
    // they aren't on the standalone receiver path).
    if (knob.setter.facet === 'VPFIBuyReceiver') continue;
    const selector = computeSelector(knob.setter.fn, DIAMOND_ABI_VIEM);
    if (selector) out[selector] = knob.id;
  }
  return out;
}

/** Find the function selector for a given function name in the
 *  ABI. Returns 0x-prefixed 4-byte hex on match, null on miss. */
function computeSelector(fnName: string, abi: Abi): string | null {
  for (const entry of abi) {
    if (entry.type !== 'function' || entry.name !== fnName) continue;
    // viem doesn't expose `getFunctionSelector` from a top-level path
    // we control, but `decodeFunctionData` can match purely by name +
    // signature. We compute the selector via a minimal keccak walk
    // on the canonical signature.
    const sig = `${fnName}(${entry.inputs?.map((i) => i.type).join(',') ?? ''})`;
    return selectorFromSignature(sig);
  }
  return null;
}

/** keccak256(canonical signature) → first 4 bytes. */
function selectorFromSignature(sig: string): string {
  return keccak256(toBytes(sig)).slice(0, 10).toLowerCase();
}

/** Decode the call's selector + args via the diamond ABI bundle.
 *  Returns null if the selector doesn't match any function on the
 *  diamond (e.g. the call targets a future facet not yet exported). */
function tryDecodeCalldata(
  data: `0x${string}`,
): { selector: string; functionName: string; args: ReadonlyArray<unknown> } | null {
  try {
    const decoded = decodeFunctionData({
      abi: DIAMOND_ABI_VIEM,
      data,
    });
    return {
      selector: data.slice(0, 10).toLowerCase(),
      functionName: decoded.functionName,
      args: (decoded.args ?? []) as ReadonlyArray<unknown>,
    };
  } catch {
    return null;
  }
}
