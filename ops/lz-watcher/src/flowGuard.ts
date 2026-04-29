/**
 * Oversized-flow scanner.
 *
 * For each VPFI / VPFIMirror contract, scan ERC20 `Transfer` events
 * since the per-(chain, contract) cursor stored in `scan_cursor`.
 * Any event with `value > FLOW_THRESHOLD_VPFI` triggers an alert —
 * useful for catching:
 *   - A successful forge that mints to an attacker's wallet on a mirror.
 *   - A drained adapter / mirror moving > expected per-tx volume.
 *   - A buggy upgrade that lets a borrower extract more than the cap.
 *
 * MVP: single-event detection, no cross-correlation with OFT
 * Sent/Received events. A real attack moving 100k+ VPFI in one tx is
 * unusual enough that a noisy alert with manual triage is the right
 * trade-off vs. complexity. Cross-correlation is a v2 target if
 * Phase 2 traffic produces benign large transfers.
 */

import {
  createPublicClient,
  decodeEventLog,
  http,
  parseAbiItem,
  type Address,
  type PublicClient,
} from 'viem';
import { ERC20_ABI } from './abis';
import type { ChainCtx } from './chains';
import {
  decideAndRecordAlert,
  getScanCursor,
  setScanCursor,
  type AlertVerb,
} from './db';

/** How far back to start when a chain has no cursor yet — covers
 *  ~30 minutes of L2 blocks at 12s/block. Keeps the very first run
 *  cheap; subsequent runs only scan the delta. */
const INITIAL_LOOKBACK_BLOCKS = 150n;

/** Cap on blocks scanned in a single tick. Defends against an
 *  RPC outage causing a multi-day backlog from melting the
 *  Workers free-tier subrequest budget on next recovery. */
const MAX_BLOCKS_PER_TICK = 5_000n;

const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

export interface OversizedFlowAlert {
  verb: AlertVerb;
  chainName: string;
  contract: Address;
  contractRole: 'vpfi_token' | 'vpfi_mirror';
  txHash: `0x${string}`;
  blockNumber: bigint;
  from: Address;
  to: Address;
  value: bigint;
  threshold: bigint;
}

interface ContractTarget {
  chain: ChainCtx;
  address: Address;
  role: 'vpfi_token' | 'vpfi_mirror';
}

function targetsFor(chains: ChainCtx[]): ContractTarget[] {
  const out: ContractTarget[] = [];
  for (const c of chains) {
    if (c.isCanonical && c.vpfiToken) {
      out.push({ chain: c, address: c.vpfiToken, role: 'vpfi_token' });
    }
    const mirror = c.oapps.find((o) => o.role === 'vpfi_mirror');
    if (mirror) {
      out.push({ chain: c, address: mirror.address, role: 'vpfi_mirror' });
    }
  }
  return out;
}

function clientFor(chain: ChainCtx): PublicClient {
  return createPublicClient({ transport: http(chain.rpc) });
}

export async function scanOversizedFlows(
  db: D1Database,
  chains: ChainCtx[],
  threshold: bigint,
  now: number,
): Promise<OversizedFlowAlert[]> {
  const alerts: OversizedFlowAlert[] = [];

  for (const t of targetsFor(chains)) {
    try {
      const newAlerts = await scanOne(db, t, threshold, now);
      alerts.push(...newAlerts);
    } catch (err) {
      console.error(
        `[lz-watcher] flow scan failed chain=${t.chain.name} contract=${t.address}: ${String(err).slice(0, 200)}`,
      );
    }
  }

  return alerts;
}

async function scanOne(
  db: D1Database,
  t: ContractTarget,
  threshold: bigint,
  now: number,
): Promise<OversizedFlowAlert[]> {
  const client = clientFor(t.chain);
  const head = await client.getBlockNumber();
  const scannerKey = `flow:${t.address.toLowerCase()}`;
  const cursor = await getScanCursor(db, t.chain.chainId, scannerKey);

  const fromBlock = cursor === 0n ? clamp(head - INITIAL_LOOKBACK_BLOCKS, 0n) : cursor + 1n;
  if (fromBlock > head) return [];

  const toBlock = head < fromBlock + MAX_BLOCKS_PER_TICK
    ? head
    : fromBlock + MAX_BLOCKS_PER_TICK - 1n;

  const logs = await client.getLogs({
    address: t.address,
    event: TRANSFER_EVENT,
    fromBlock,
    toBlock,
  });

  const alerts: OversizedFlowAlert[] = [];
  for (const log of logs) {
    let value: bigint;
    let from: Address;
    let to: Address;
    try {
      const decoded = decodeEventLog({
        abi: ERC20_ABI,
        data: log.data,
        topics: log.topics,
      });
      // Note: parseAbi narrows by event name
      if (decoded.eventName !== 'Transfer') continue;
      const args = decoded.args as { from: Address; to: Address; value: bigint };
      value = args.value;
      from = args.from;
      to = args.to;
    } catch {
      continue;
    }

    if (value <= threshold) continue;

    const key = `${t.chain.chainId}:${log.transactionHash}:${log.logIndex}`;
    const verb = await decideAndRecordAlert(
      db,
      'oversized_flow',
      key,
      value.toString(),
      now,
    );
    if (verb === 'suppressed' || verb === 'recovered') continue;

    alerts.push({
      verb,
      chainName: t.chain.name,
      contract: t.address,
      contractRole: t.role,
      txHash: log.transactionHash as `0x${string}`,
      blockNumber: log.blockNumber!,
      from,
      to,
      value,
      threshold,
    });
  }

  await setScanCursor(db, t.chain.chainId, scannerKey, toBlock, now);
  return alerts;
}

function clamp(value: bigint, min: bigint): bigint {
  return value < min ? min : value;
}

export function formatOversizedFlowAlert(a: OversizedFlowAlert): string {
  const head = `[lz-watcher] ${a.verb.toUpperCase()} oversized_flow`;
  return [
    head,
    `Chain: ${a.chainName}`,
    `Contract: ${a.contract} (${a.contractRole})`,
    `Tx: ${a.txHash}`,
    `Block: ${a.blockNumber.toString()}`,
    `from: ${a.from}`,
    `to:   ${a.to}`,
    `value: ${a.value.toString()} (threshold: ${a.threshold.toString()})`,
    '',
    'Action: confirm a corresponding OFT Sent/Received exists, else investigate forgery.',
  ].join('\n');
}
