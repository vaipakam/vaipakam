/**
 * DVN-count drift detector.
 *
 * For every (chain, OApp, peer eid) triple where `peers(eid) != 0`,
 * read the ULN config from the LZ V2 endpoint for both the send
 * library and the receive library, decode the UlnConfig, and assert
 * the policy:
 *
 *   requiredDVNCount     == 3
 *   optionalDVNCount     == 2
 *   optionalDVNThreshold == 1
 *
 * Any deviation indicates either an accidental misconfiguration
 * (someone called `endpoint.setConfig` without going through
 * `ConfigureLZConfig.s.sol`) or — worst case — a successful
 * compromise of the OApp delegate key writing a weakened config.
 * Both cases warrant an immediate Telegram ping.
 *
 * The check is deliberately silent on confirmation drift, DVN
 * address rotation, and library swaps — those are caught by the
 * Foundry-side `LZConfig.t.sol`, which runs against the build
 * artifact pre-deploy. This Worker's job is the post-deploy
 * runtime check that the on-chain state hasn't been mutated since.
 */

import {
  createPublicClient,
  decodeAbiParameters,
  http,
  type Address,
  type PublicClient,
} from 'viem';
import {
  CONFIG_TYPE_ULN,
  ENDPOINT_V2_ABI,
  OAPP_CORE_ABI,
  ULN_CONFIG_DECODE_TYPE,
} from './abis';
import { peerEidCandidates, type ChainCtx, type OAppEntry } from './chains';
import { decideAndRecordAlert, type AlertVerb } from './db';

const POLICY_REQUIRED_DVN_COUNT = 3;
const POLICY_OPTIONAL_DVN_COUNT = 2;
const POLICY_OPTIONAL_DVN_THRESHOLD = 1;

interface UlnConfigDecoded {
  confirmations: bigint;
  requiredDVNCount: number;
  optionalDVNCount: number;
  optionalDVNThreshold: number;
  requiredDVNs: readonly Address[];
  optionalDVNs: readonly Address[];
}

export interface DvnAlert {
  verb: AlertVerb;
  chainName: string;
  oappRole: string;
  oappAddress: Address;
  peerEid: number;
  side: 'send' | 'receive';
  found: { req: number; opt: number; threshold: number };
  expected: { req: number; opt: number; threshold: number };
}

function clientFor(chain: ChainCtx): PublicClient {
  return createPublicClient({ transport: http(chain.rpc) });
}

function decodeUlnConfig(raw: `0x${string}`): UlnConfigDecoded {
  const [decoded] = decodeAbiParameters(ULN_CONFIG_DECODE_TYPE, raw);
  return decoded as UlnConfigDecoded;
}

async function isPeerWired(
  client: PublicClient,
  oapp: Address,
  eid: number,
): Promise<boolean> {
  try {
    const peer = (await client.readContract({
      address: oapp,
      abi: OAPP_CORE_ABI,
      functionName: 'peers',
      args: [eid],
    })) as `0x${string}`;
    return peer !== '0x0000000000000000000000000000000000000000000000000000000000000000';
  } catch {
    // OApp may have been redeployed without `peers` ABI (unlikely) — treat
    // as "no peer" rather than crashing the watcher.
    return false;
  }
}

async function checkPair(
  client: PublicClient,
  endpoint: Address,
  lib: Address,
  oapp: Address,
  eid: number,
): Promise<UlnConfigDecoded | null> {
  try {
    const raw = (await client.readContract({
      address: endpoint,
      abi: ENDPOINT_V2_ABI,
      functionName: 'getConfig',
      args: [oapp, lib, eid, CONFIG_TYPE_ULN],
    })) as `0x${string}`;
    if (!raw || raw === '0x') return null;
    return decodeUlnConfig(raw);
  } catch (err) {
    console.error(
      `[lz-watcher] getConfig failed oapp=${oapp} lib=${lib} eid=${eid}: ${String(err).slice(0, 150)}`,
    );
    return null;
  }
}

/** Run the DVN-count check across every (chain, OApp, peer) triple.
 *  Returns the alerts that should fire this tick (already deduped
 *  against `lz_alert_state`). */
export async function checkDvnDrift(
  db: D1Database,
  chains: ChainCtx[],
  now: number,
): Promise<DvnAlert[]> {
  const alerts: DvnAlert[] = [];

  for (const chain of chains) {
    if (chain.oapps.length === 0) continue;
    const client = clientFor(chain);
    const peerEids = peerEidCandidates(chain, chains);
    if (peerEids.length === 0) continue;

    for (const oapp of chain.oapps) {
      for (const eid of peerEids) {
        if (!(await isPeerWired(client, oapp.address, eid))) continue;

        for (const side of ['send', 'receive'] as const) {
          const lib = side === 'send' ? chain.uln302SendLib : chain.uln302ReceiveLib;
          const cfg = await checkPair(client, chain.endpoint, lib, oapp.address, eid);
          const verb = await evaluateAndDedup({
            db,
            chain,
            oapp,
            eid,
            side,
            cfg,
            now,
          });
          if (verb !== 'suppressed') {
            alerts.push({
              verb,
              chainName: chain.name,
              oappRole: oapp.role,
              oappAddress: oapp.address,
              peerEid: eid,
              side,
              found: cfg
                ? {
                    req: cfg.requiredDVNCount,
                    opt: cfg.optionalDVNCount,
                    threshold: cfg.optionalDVNThreshold,
                  }
                : { req: 0, opt: 0, threshold: 0 },
              expected: {
                req: POLICY_REQUIRED_DVN_COUNT,
                opt: POLICY_OPTIONAL_DVN_COUNT,
                threshold: POLICY_OPTIONAL_DVN_THRESHOLD,
              },
            });
          }
        }
      }
    }
  }

  return alerts;
}

interface EvalArgs {
  db: D1Database;
  chain: ChainCtx;
  oapp: OAppEntry;
  eid: number;
  side: 'send' | 'receive';
  cfg: UlnConfigDecoded | null;
  now: number;
}

async function evaluateAndDedup(args: EvalArgs): Promise<AlertVerb> {
  const key = `${args.chain.chainId}:${args.oapp.address.toLowerCase()}:${args.eid}:${args.side}`;
  const isOk =
    args.cfg !== null &&
    args.cfg.requiredDVNCount === POLICY_REQUIRED_DVN_COUNT &&
    args.cfg.optionalDVNCount === POLICY_OPTIONAL_DVN_COUNT &&
    args.cfg.optionalDVNThreshold === POLICY_OPTIONAL_DVN_THRESHOLD;

  if (isOk) {
    return decideAndRecordAlert(args.db, 'dvn_count', key, null, args.now);
  }

  const value = args.cfg
    ? `req=${args.cfg.requiredDVNCount},opt=${args.cfg.optionalDVNCount},th=${args.cfg.optionalDVNThreshold}`
    : 'unread';
  return decideAndRecordAlert(args.db, 'dvn_count', key, value, args.now);
}

export function formatDvnAlert(a: DvnAlert): string {
  const head = a.verb === 'recovered'
    ? `[lz-watcher] RECOVERED dvn_count`
    : `[lz-watcher] ${a.verb.toUpperCase()} dvn_count drift`;
  const meta = `${a.chainName} / ${a.oappRole} (${a.oappAddress}) / peer eid ${a.peerEid} / ${a.side}`;
  if (a.verb === 'recovered') {
    return `${head}\n${meta}\nConfig is back to policy: req=${a.expected.req} opt=${a.expected.opt} th=${a.expected.threshold}.`;
  }
  return `${head}\n${meta}\nFound: req=${a.found.req} opt=${a.found.opt} th=${a.found.threshold}\nExpected: req=${a.expected.req} opt=${a.expected.opt} th=${a.expected.threshold}\nAction: investigate setConfig calls + consider pause() on the OApp until verified.`;
}
