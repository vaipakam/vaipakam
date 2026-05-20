/**
 * OFT mint/burn imbalance check.
 *
 * The VPFI OFT V2 design pins all real VPFI on the canonical chain
 * (Base) — every cross-chain transfer locks tokens in
 * `VPFIOFTAdapter` on Base and mints an equal amount on the
 * destination's `VPFIMirror`. The reverse path burns mirror supply
 * and unlocks on Base. So at any moment:
 *
 *   VPFI.balanceOf(VPFIOFTAdapter) on Base  ==
 *     sum( VPFIMirror.totalSupply() over every mirror chain )
 *
 * Drift = a forged mint or a desynced burn somewhere. This is the
 * single highest-severity check we can do — a non-zero drift,
 * even by 1 wei, means something has gone wrong with cross-chain
 * messaging integrity. Alert critical.
 */

import {
  createPublicClient,
  http,
  type Address,
  type PublicClient,
} from 'viem';
import { ERC20_ABI } from './abis';
import type { ChainCtx } from './chains';
import { decideAndRecordAlert, recordOftSnapshot, type AlertVerb } from './db';

export interface ImbalanceAlert {
  verb: AlertVerb;
  baseLocked: bigint;
  sumMirrorSupply: bigint;
  drift: bigint;
  perChain: Array<{ chainName: string; supply: bigint }>;
}

function clientFor(chain: ChainCtx): PublicClient {
  return createPublicClient({ transport: http(chain.rpc) });
}

async function readBaseLocked(chains: ChainCtx[]): Promise<{
  locked: bigint;
  found: boolean;
}> {
  const base = chains.find((c) => c.isCanonical);
  if (!base || !base.vpfiToken) return { locked: 0n, found: false };
  const adapter = base.oapps.find((o) => o.role === 'vpfi_oft_adapter');
  if (!adapter) return { locked: 0n, found: false };

  const client = clientFor(base);
  try {
    const balance = (await client.readContract({
      address: base.vpfiToken,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [adapter.address],
    })) as bigint;
    return { locked: balance, found: true };
  } catch (err) {
    console.error(
      `[lz-watcher] base.balanceOf(adapter) failed: ${String(err).slice(0, 200)}`,
    );
    return { locked: 0n, found: false };
  }
}

async function readMirrorSupplies(chains: ChainCtx[]): Promise<{
  perChain: Array<{ chainName: string; supply: bigint; ok: boolean }>;
  sum: bigint;
  allOk: boolean;
}> {
  const perChain: Array<{ chainName: string; supply: bigint; ok: boolean }> = [];
  let sum = 0n;
  let allOk = true;

  for (const chain of chains) {
    if (chain.isCanonical) continue;
    const mirror = chain.oapps.find((o) => o.role === 'vpfi_mirror');
    if (!mirror) continue;
    const client = clientFor(chain);
    try {
      const supply = (await client.readContract({
        address: mirror.address as Address,
        abi: ERC20_ABI,
        functionName: 'totalSupply',
      })) as bigint;
      perChain.push({ chainName: chain.name, supply, ok: true });
      sum += supply;
    } catch (err) {
      console.error(
        `[lz-watcher] ${chain.name}.totalSupply failed: ${String(err).slice(0, 200)}`,
      );
      perChain.push({ chainName: chain.name, supply: 0n, ok: false });
      allOk = false;
    }
  }

  return { perChain, sum, allOk };
}

/** One-shot imbalance check. Returns null if the inputs were not
 *  fully readable this tick — partial reads must NOT trigger an
 *  alert (a single RPC blip should not page the team). */
export async function checkOftImbalance(
  db: D1Database,
  chains: ChainCtx[],
  now: number,
): Promise<ImbalanceAlert | null> {
  const { locked, found } = await readBaseLocked(chains);
  if (!found) return null;

  const { perChain, sum, allOk } = await readMirrorSupplies(chains);
  if (!allOk) return null;

  const drift = locked - sum;
  await recordOftSnapshot(db, now, locked, sum);

  // Single global key — there's only one canonical/mirror system.
  const value = drift === 0n ? null : drift.toString();
  const verb = await decideAndRecordAlert(db, 'oft_imbalance', 'global', value, now);
  if (verb === 'suppressed') return null;

  return {
    verb,
    baseLocked: locked,
    sumMirrorSupply: sum,
    drift,
    perChain: perChain.map((c) => ({ chainName: c.chainName, supply: c.supply })),
  };
}

export function formatImbalanceAlert(a: ImbalanceAlert): string {
  const head =
    a.verb === 'recovered'
      ? `[lz-watcher] RECOVERED oft_imbalance`
      : `[lz-watcher] ${a.verb.toUpperCase()} oft_imbalance — CRITICAL`;
  if (a.verb === 'recovered') {
    return `${head}\nBase-locked == sum(mirror supplies). System is in balance again.\nLocked: ${a.baseLocked.toString()}\nMirror sum: ${a.sumMirrorSupply.toString()}`;
  }
  const lines = [
    head,
    `Base-locked VPFI: ${a.baseLocked.toString()}`,
    `Sum mirror supply: ${a.sumMirrorSupply.toString()}`,
    `Drift (locked - sum): ${a.drift.toString()}`,
    '',
    'Per-chain mirror supply:',
    ...a.perChain.map((c) => `  - ${c.chainName}: ${c.supply.toString()}`),
    '',
    'Action: pause() every LZ-facing contract immediately, then investigate.',
  ];
  return lines.join('\n');
}
