/**
 * LN-53 — where a wallet stands with the sanctions screen, read from the
 * protocol's own views, and what that means for money the protocol holds for
 * it (RB-FROZEN).
 *
 * The protocol never seizes a flagged party's proceeds and never lets a
 * close-out wait on them: a repayment, a default or a liquidation completes so
 * the other party is made whole, and the flagged party's share is parked in a
 * vault, locked, until the wallet is de-listed. What the app can say from the
 * chain:
 * - no screen configured: nothing is frozen on this chain;
 * - the screen flags the wallet: every claim refuses it now (each claim
 *   screens its caller first), so what is held for it waits, locked, not lost;
 * - the screen cannot be read, and the wallet was confirmed flagged before
 *   (the protocol's registry): a payout frozen for it stays locked until the
 *   screen answers again (release is fail-closed), while a payout never frozen
 *   still pays, because an outage alone never freezes anyone;
 * - otherwise nothing is frozen for this wallet.
 *
 * What it cannot say: which loan sides recorded this wallet as their frozen
 * party (the protocol keeps that per loan with no view), so a claim on a side
 * frozen for an EARLIER holder is refused only by the dry run, whose refusal
 * is then stated in these words too (#3340 asks for the view).
 */
import type { Abi, PublicClient } from 'viem';
import { ProfileFacetABI } from '@vaipakam/contracts/abis';
import type { CopyAccess } from '../copy/useCopy';
import type { Refusal } from '../eligibility/types';
import { answerOrNull } from '../reads/answer';

type Hex = `0x${string}`;

const PROFILE = ProfileFacetABI as Abi;
const ZERO = '0x0000000000000000000000000000000000000000';

/** `LibVaipakam.SanctionsRead`, in its order. */
const READS = ['clean', 'flagged', 'unavailable'] as const;
export type SanctionsRead = (typeof READS)[number];

export interface SanctionsPosture {
  /** A screen is configured on this chain; null when unread. */
  configured: boolean | null;
  /** The screen's answer for the wallet; null when unread or not asked
   *  (no screen configured). */
  read: SanctionsRead | null;
  /** The protocol's registry of wallets confirmed flagged while the screen
   *  could be read; null when unread or not asked. */
  registered: boolean | null;
}

/** The wallet's posture at one block (or the head). Every read is a
 *  contract's own answer or null; a failed source is thrown, so the own rail
 *  tries the next one. */
export async function readSanctionsPosture(c: PublicClient, diamond: Hex, account: Hex, blockNumber?: bigint): Promise<SanctionsPosture> {
  const at = blockNumber === undefined ? {} : { blockNumber };
  const read = <T>(functionName: string, args: readonly unknown[] = []) =>
    answerOrNull(c.readContract({ address: diamond, abi: PROFILE, functionName, args, ...at }) as Promise<T>);
  const oracle = await read<Hex>('getSanctionsOracle');
  if (oracle === null) return { configured: null, read: null, registered: null };
  if (oracle.toLowerCase() === ZERO) return { configured: false, read: null, registered: null };
  const [status, registered] = await Promise.all([read<number | bigint>('sanctionsStatus', [account]), read<boolean>('isSanctionsConfirmedFlagged', [account])]);
  return { configured: true, read: status === null ? null : (READS[Number(status)] ?? null), registered };
}

/** What the posture means for money held for the wallet:
 *  - `flagged`: the screen flags it, so nothing can be collected now;
 *  - `outage`: the screen cannot be read and the wallet was confirmed
 *    flagged before, so anything frozen for it stays locked until it can;
 *  - `unknown`: the posture could not be read;
 *  - null: nothing is frozen for this wallet. */
export type FrozenState = 'flagged' | 'outage' | 'unknown' | null;

export function frozenState(p: SanctionsPosture | null | undefined): FrozenState {
  if (!p || p.configured === null) return 'unknown';
  if (!p.configured) return null;
  if (p.read === null) return 'unknown';
  if (p.read === 'flagged') return 'flagged';
  if (p.read === 'unavailable') return p.registered === null ? 'unknown' : p.registered ? 'outage' : null;
  return null;
}

/** The errors with which a claim refuses a frozen party: the caller is
 *  flagged, or a fail-closed release could not prove the recorded party
 *  clean (`SanctionsOracleUnavailable` when the screen cannot be read). */
const FROZEN_CODES = new Set(['SanctionedAddress', 'SanctionsOracleUnavailable']);

export function isFrozenRefusal(r: Pick<Refusal, 'code'> | null | undefined): boolean {
  return !!r && FROZEN_CODES.has(r.code);
}

/** The refusal a claim states for a frozen party, in one set of words
 *  everywhere: `flagged` for this wallet now, `outage` when release waits
 *  for the screen, `recorded` when the dry run refused for a party the
 *  protocol recorded on that loan side (the app cannot read who). */
export function frozenRefusal(kind: 'flagged' | 'outage' | 'recorded', copy: Pick<CopyAccess, 'text'>): Refusal {
  const key = kind === 'flagged' ? 'frozen.claimFlagged' : kind === 'outage' ? 'frozen.claimOutage' : 'frozen.claimRecorded';
  return { code: 'SanctionedAddress', reason: copy.text(key), reopensAt: null, remedy: null };
}
