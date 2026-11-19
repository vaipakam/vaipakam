// apps/keeper/src/tierVersionSync.ts
//
// #912 — the TIER-VERSION SYNC, step 8 of `protocolUpkeep`: the keeper's call
// of `ProtocolBroadcastFacet.broadcastTierTableVersionTo(destChainId)` for a
// mirror whose tier table is behind Base's.
//
// Every governance change to the VPFI tier thresholds or discounts raises
// Base's tier-table version (`getTierTableVersion`). Each mirror keeps the
// version it last received (`MirrorTierReceiverFacet.getCurrentTierTableVersion`)
// and reads a user's pushed tier against that table. A mirror whose version is
// lower is applying a table Base no longer uses, and nothing delivers the bump
// unless somebody calls `broadcastTierTableVersionTo` for that mirror.
//
// Runs on the canonical chain only (the facet refuses anywhere else). Per run:
//
//   1. READ — Base's version, then each mirror's version from that mirror's
//      own RPC, which must answer for the mirror's chain. A version Base has
//      never set (0) is said, and nothing is sent. A mirror that cannot be
//      read is named as unread, never treated as behind or current.
//   2. COMPARE — a mirror at or above Base's version is current (above is
//      named: it means the mirror took a version Base no longer holds).
//   3. WAIT — a bump this keeper sent for the SAME version within
//      `resendAfterSec` (default 6 hours) is still in flight over CCIP, so it
//      is not paid again; the line says the mirror is waiting for it. Past
//      that, a mirror still behind is sent again.
//   4. SEND — quote the lane (`quoteBroadcastTierTableVersionTo`), then
//      simulate and send with exactly that fee. The fee is paid from the
//      keeper's key, so it is held to this step's own ceiling
//      (TIER_VERSION_SYNC_MAX_FEE_WEI, `feeCeiling.ts`): a quote above it is
//      not paid and the mirror stays behind until the quote falls or the
//      ceiling is raised. The messenger refunds any unspent fee to the
//      keeper.
//
// Gated by KEEPER_ENABLED + PROTOCOL_UPKEEP_ENABLED + TIER_VERSION_SYNC_ENABLED.
// Ships disarmed.

import type { Abi, Address, PublicClient } from 'viem';
import { MirrorTierReceiverFacetABI, ProtocolBroadcastFacetABI } from '@vaipakam/contracts/abis';
import { PastRunDeadline } from './batchRead';
import { boundedCall } from './passReader';
import { shortErr } from './callErrors';
import { readCutoffMs } from './runWindow';
import type { ScanCursors } from './scanCursors';
import type { StepSender } from './stepSender';

export const TIER_VERSION_ABI = [...(ProtocolBroadcastFacetABI as Abi)] as Abi;
export const MIRROR_VERSION_ABI = MirrorTierReceiverFacetABI as Abi;

/** The step's name in the pass's sends, refusals and budgets. */
export const STEP = 'tier-version';
/** The fee ceiling variable this step's sends are held to. */
export const MAX_FEE_VAR = 'TIER_VERSION_SYNC_MAX_FEE_WEI';
/** How long a bump this keeper sent is left to arrive before the mirror,
 *  still behind on the same version, is paid for again. CCIP delivers in
 *  minutes; six hours leaves room for a slow lane without paying twice. */
export const DEFAULT_RESEND_AFTER_SEC = 6 * 60 * 60;
/** The cursor item recording the last bump sent to a mirror: `<version>:<unix sec>`. */
export const sentItem = (chainId: number) => `tier-version-sent:${chainId}`;

/** One mirror's version, read from the mirror's own RPC. Throws when it
 *  cannot be read; the step names that and moves on. */
export interface MirrorVersionRead {
  chainId: number;
  read: () => Promise<number>;
}

export interface TierVersionDeps {
  /** Base's client; the reads carry the run's cutoff themselves. */
  readClient: PublicClient;
  sendDeadline: number;
  cursors: ScanCursors;
  mirrors: readonly MirrorVersionRead[];
  /** The keeper's clock, unix seconds. */
  nowSec: number;
  resendAfterSec?: number;
}

export interface TierVersionReport {
  /** Why the step did nothing this run, when it did nothing. */
  off: string | null;
  /** Base's version, when read. */
  base: number | null;
  /** `<chainId>@<version>` of mirrors at Base's version. */
  current: string[];
  /** `<chainId>@<version>` of mirrors above Base's version. */
  ahead: string[];
  /** `<chainId>@<version>` of mirrors behind, with a bump still in flight. */
  waiting: string[];
  /** `<chainId>` of mirrors a bump was sent to this run. */
  sent: string[];
}

export function emptyTierVersionReport(): TierVersionReport {
  return { off: null, base: null, current: [], ahead: [], waiting: [], sent: [] };
}

/** The run line's figures for this step; nothing when the step is off. */
export function describeTierVersion(r: TierVersionReport | null): string[] {
  if (r === null) return [];
  if (r.off !== null) return [`tier-version=${r.off}`];
  const parts = [`tier-version-base=${r.base}`];
  if (r.current.length > 0) parts.push(`tier-version-current=${r.current.join(',')}`);
  if (r.ahead.length > 0) parts.push(`tier-version-ahead=${r.ahead.join(',')} (the mirror holds a version Base does not)`);
  if (r.waiting.length > 0) parts.push(`tier-version-in-flight=${r.waiting.join(',')}`);
  if (r.sent.length > 0) parts.push(`tier-version-sent=${r.sent.join(',')}`);
  return parts;
}

/** Bring every mirror behind Base's tier-table version up to it. */
export async function syncTierTableVersions(diamond: Address, sender: StepSender, deps: TierVersionDeps): Promise<TierVersionReport> {
  const report = emptyTierVersionReport();
  const cutoff = readCutoffMs(deps.sendDeadline);
  if (deps.mirrors.length === 0) {
    report.off = 'no mirror chain is configured for this keeper';
    return report;
  }
  let base: number;
  try {
    base = Number(
      await boundedCall(cutoff, "Base's tier-table version", () =>
        deps.readClient.readContract({ address: diamond, abi: TIER_VERSION_ABI, functionName: 'getTierTableVersion' }),
      ),
    );
  } catch (err) {
    if (err instanceof PastRunDeadline) throw err;
    sender.noteUnread(`${STEP}:base`, `Base's tier-table version (${shortErr(err)})`);
    report.off = "Base's version was not read this run";
    return report;
  }
  report.base = base;
  if (base === 0) {
    report.off = 'Base has no tier-table version set, so there is nothing to send';
    return report;
  }

  const resendAfter = deps.resendAfterSec ?? DEFAULT_RESEND_AFTER_SEC;
  const sentRows = await deps.cursors.get(deps.mirrors.map((m) => sentItem(m.chainId)));
  for (const m of deps.mirrors) {
    const key = `${STEP}:${m.chainId}`;
    let version: number;
    try {
      version = await boundedCall(cutoff, `chain ${m.chainId}'s tier-table version`, m.read);
    } catch (err) {
      if (err instanceof PastRunDeadline) throw err;
      sender.noteUnread(key, `the mirror's tier-table version (${shortErr(err)})`);
      continue;
    }
    if (version === base) {
      report.current.push(`${m.chainId}@${version}`);
      continue;
    }
    if (version > base) {
      report.ahead.push(`${m.chainId}@${version}`);
      continue;
    }
    const last = parseSent(sentRows.get(sentItem(m.chainId)));
    if (last !== null && last.version === base && deps.nowSec - last.atSec < resendAfter) {
      report.waiting.push(`${m.chainId}@${version} (bump to ${base} sent ${deps.nowSec - last.atSec}s ago)`);
      continue;
    }
    let fee: bigint;
    try {
      fee = (await boundedCall(cutoff, `the lane fee to chain ${m.chainId}`, () =>
        deps.readClient.readContract({ address: diamond, abi: TIER_VERSION_ABI, functionName: 'quoteBroadcastTierTableVersionTo', args: [BigInt(m.chainId)] }),
      )) as bigint;
    } catch (err) {
      if (err instanceof PastRunDeadline) throw err;
      sender.noteUnread(key, `the lane fee (${shortErr(err)})`);
      continue;
    }
    const result = await sender.call(STEP, m.chainId, 'broadcastTierTableVersionTo', [BigInt(m.chainId)], fee);
    if (result === 'landed') {
      report.sent.push(`${m.chainId} (${version} to ${base}, fee ${fee} wei)`);
      await deps.cursors.put(sentItem(m.chainId), `${base}:${deps.nowSec}`);
    }
    if (sender.stopped) break;
  }
  return report;
}

/** A stored `<version>:<unix sec>`, or null when absent or damaged. */
export function parseSent(raw: string | undefined): { version: number; atSec: number } | null {
  const m = /^(\d+):(\d+)$/.exec(raw ?? '');
  return m ? { version: Number(m[1]), atSec: Number(m[2]) } : null;
}

/** A mirror's reader over its own RPC, refusing an RPC that serves another chain. */
export function mirrorVersionReader(chainId: number, diamond: Address, client: PublicClient): MirrorVersionRead {
  return {
    chainId,
    read: async () => {
      const served = await client.getChainId();
      if (served !== chainId) throw new Error(`the RPC configured for chain ${chainId} serves chain ${served}`);
      return Number(await client.readContract({ address: diamond, abi: MIRROR_VERSION_ABI, functionName: 'getCurrentTierTableVersion' }));
    },
  };
}
