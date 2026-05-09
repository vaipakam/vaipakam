/**
 * T-042 Phase 2 — live-value reader for the admin dashboard.
 *
 * Issues a single batched read against the diamond (and the
 * `VPFIBuyReceiver` standalone contract on Base where applicable)
 * for every governance-tunable knob defined in `adminKnobsZones.ts`.
 * The dashboard cards subscribe to the returned map and render
 * each knob's current value relative to its hard bound + soft zones.
 *
 * Returns one entry per knob:
 *   - `value`:   bigint for numeric knobs, boolean for bool, string
 *                (lowercased hex) for address / bytes32. `null` if
 *                the read failed (RPC hiccup, missing facet on the
 *                selected chain, etc.).
 *   - `loading`: true while the initial read is in flight.
 *   - `error`:   the error string when the read failed (otherwise
 *                undefined).
 *
 * Why per-knob status instead of a single global `loading`: the
 * dashboard renders cards as soon as their values are available
 * rather than blocking on the slowest read. A misconfigured chain
 * (e.g. testnet without a Pyth oracle deployed) shows "(not
 * configured)" on those specific cards while the rest of the panel
 * loads.
 */

import { useEffect, useMemo, useState } from 'react';
import { type Abi } from 'viem';
import { useDiamondPublicClient, useReadChain } from '../contracts/useDiamond';
import { DIAMOND_ABI_VIEM, VPFIBuyReceiverABI } from '../contracts/abis';
import { ADMIN_KNOBS, type KnobMeta } from '../lib/protocolConsoleKnobs';
import { getDeployment } from '../contracts/deployments';

export type KnobReadValue = bigint | boolean | string | null;

export interface KnobReadResult {
  value: KnobReadValue;
  loading: boolean;
  error?: string;
}

export type KnobValuesMap = Record<string, KnobReadResult>;

/**
 * Read a knob's current value from the diamond (or, for the
 * `VPFIBuyReceiver` knob, from the canonical-Base receiver address
 * resolved from the deployments JSON).
 *
 * We don't use the project's `Multicall3` helper here because the
 * helper is specialised for "same function across many targets" —
 * our ~17 knobs hit different selectors on different facets / on a
 * separate contract. Promise.all of plain reads is cheaper to write
 * and the dashboard loads infrequently enough that batching wouldn't
 * meaningfully reduce request count.
 */
export function useAdminKnobValues(): KnobValuesMap {
  const client = useDiamondPublicClient();
  const chain = useReadChain();
  const [values, setValues] = useState<KnobValuesMap>(() =>
    Object.fromEntries(
      ADMIN_KNOBS.map((k) => [k.id, { value: null, loading: true } as KnobReadResult]),
    ),
  );

  // Resolve the standalone-contract addresses we may need beyond the
  // diamond. VPFIBuyReceiver lives at its own address on the
  // canonical-VPFI chain.
  const vpfiBuyReceiver = useMemo(() => {
    const dep = getDeployment(chain.chainId) as
      | { vpfiBuyReceiver?: string }
      | undefined;
    return dep?.vpfiBuyReceiver ?? null;
  }, [chain.chainId]);

  useEffect(() => {
    if (!chain.diamondAddress) return;
    let cancelled = false;

    const target = (knob: KnobMeta): { address: string; abi: Abi } | null => {
      // VPFIBuyReceiver knobs read from the standalone contract;
      // every other knob targets the diamond.
      if (knob.getter.facet === 'VPFIBuyReceiver') {
        if (!vpfiBuyReceiver) return null;
        return {
          address: vpfiBuyReceiver,
          abi: VPFIBuyReceiverABI as unknown as Abi,
        };
      }
      return {
        address: chain.diamondAddress!,
        abi: DIAMOND_ABI_VIEM,
      };
    };

    const reads = ADMIN_KNOBS.map(async (knob) => {
      const t = target(knob);
      if (!t) {
        return [knob.id, { value: null, loading: false, error: 'no-target' }] as const;
      }
      try {
        const result = await client.readContract({
          address: t.address as `0x${string}`,
          abi: t.abi,
          functionName: knob.getter.fn,
        });
        return [knob.id, { value: normalizeRead(result), loading: false }] as const;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return [
          knob.id,
          { value: null, loading: false, error: msg.slice(0, 120) },
        ] as const;
      }
    });

    Promise.all(reads).then((entries) => {
      if (cancelled) return;
      const next = Object.fromEntries(entries) as KnobValuesMap;
      setValues(next);
    });

    return () => {
      cancelled = true;
    };
  }, [client, chain.diamondAddress, vpfiBuyReceiver]);

  return values;
}

/**
 * Coerce viem's read result into the union the dashboard expects.
 * - `bigint`        for numeric returns (uint*, int*).
 * - `boolean`       for bool returns.
 * - lowercased hex  for address / bytes32 returns.
 * - `null`          for everything else.
 */
function normalizeRead(raw: unknown): KnobReadValue {
  if (typeof raw === 'bigint') return raw;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    return raw.toLowerCase();
  }
  if (typeof raw === 'number') {
    return BigInt(raw);
  }
  return null;
}
