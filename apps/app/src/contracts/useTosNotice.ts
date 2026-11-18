/**
 * #3734 — what a CURRENT wallet should be told about a Terms change.
 *
 * The gate (`useTosAcceptance`) decides whether a wallet may use the app:
 * `hasAcceptedCurrentTerms` answers by the contract's rule, current = an
 * accepted version in force from the network's minimum to its latest. This
 * hook answers the two things a wallet that passes the gate may still need
 * to know (TermsAcceptanceEnforcementDesign.md, sections 5 and 7):
 *
 *  - A MATERIAL change is announced: the minimum moves to version N at a
 *    stated time. Until then the wallet stays current; from then, a wallet
 *    that has not accepted N takes on no new position (its offers and
 *    automatic lending stop filling). Accepting N early keeps it current
 *    with no gap. The app asks, with the date, and the ask can be put off.
 *  - A SMALL change made a newer version the latest without moving the
 *    minimum. Nobody has to accept it; the app shows a quiet line with the
 *    link and offers acceptance, never requires it.
 *
 * All three reads are pinned to one block so the answer is one snapshot.
 * A failed read is `null`: no notice is shown on a guess, and the gate,
 * which fails closed on its own, is unaffected.
 */
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { useActiveChain } from '../chain/useActiveChain';

export interface AnnouncedTos {
  version: number;
  hash: `0x${string}`;
  /** Unix seconds the minimum moves to `version`. */
  effectiveAt: number;
  /** False: a raise of the minimum to the version that is already the latest. */
  newVersion: boolean;
}

export interface TosNotice {
  latest: number;
  latestHash: `0x${string}`;
  minimum: number;
  /** Versions this wallet accepted on this network. */
  accepted: number[];
  /** The open announcement, or null. */
  announced: AnnouncedTos | null;
}

/** What to show a wallet that passed the gate. Pure; tested on its own. */
export type TosNoticeKind =
  | { kind: 'none' }
  /** A material change is announced and this wallet has not accepted it. */
  | { kind: 'material'; version: number; hash: `0x${string}`; effectiveAt: number }
  /** A newer latest version exists that this wallet has not accepted. Optional. */
  | { kind: 'small'; version: number; hash: `0x${string}` };

export function tosNoticeOf(n: TosNotice | null): TosNoticeKind {
  if (n === null || n.latest === 0) return { kind: 'none' };
  if (n.announced !== null && !n.accepted.includes(n.announced.version)) {
    return {
      kind: 'material',
      version: n.announced.version,
      hash: n.announced.hash,
      effectiveAt: n.announced.effectiveAt,
    };
  }
  if (n.announced === null && !n.accepted.includes(n.latest)) {
    return { kind: 'small', version: n.latest, hash: n.latestHash };
  }
  return { kind: 'none' };
}

export function tosNoticeQueryKey(chainId: number, address: string | undefined) {
  return ['tosNotice', chainId, address?.toLowerCase()] as const;
}

export function useTosNotice(enabled: boolean): TosNoticeKind {
  const { address, readChain } = useActiveChain();
  const client = usePublicClient({ chainId: readChain.chainId });
  const q = useQuery({
    queryKey: tosNoticeQueryKey(readChain.chainId, address),
    enabled: enabled && Boolean(client) && Boolean(address),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
    queryFn: async (): Promise<TosNotice> => {
      const blockNumber = await client!.getBlockNumber();
      const read = <T,>(functionName: string, args: readonly unknown[] = []) =>
        client!.readContract({
          address: readChain.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName,
          args,
          blockNumber,
        } as never) as Promise<T>;
      const [versions, announced, accepted] = await Promise.all([
        read<readonly [number, `0x${string}`, number]>('getTosVersions'),
        read<readonly [number, `0x${string}`, bigint, number, boolean]>('getAnnouncedTos'),
        read<readonly number[]>('getUserAcceptedTosVersions', [address!]),
      ]);
      return {
        latest: Number(versions[0]),
        latestHash: versions[1],
        minimum: Number(versions[2]),
        accepted: accepted.map(Number),
        announced:
          Number(announced[0]) === 0
            ? null
            : {
                version: Number(announced[0]),
                hash: announced[1],
                effectiveAt: Number(announced[2]),
                newVersion: announced[4],
              },
      };
    },
  });
  return tosNoticeOf(q.isError ? null : (q.data ?? null));
}

/**
 * "Remind me later", per wallet, network and version, in this browser.
 *
 * Putting off a SMALL change hides that version for good: nobody has to
 * accept it. Putting off a MATERIAL change hides it only until the last
 * week before it takes effect, so the wallet is asked again while there
 * is still time to accept without a gap. Storage failures read as "not
 * put off": the cost is one extra notice, never a missed one.
 */
export const LATER_FINAL_WEEK_SEC = 7 * 24 * 60 * 60;

export function tosNoticeLaterKey(chainId: number, address: string) {
  return `app.tosNotice.later.${chainId}.${address.toLowerCase()}`;
}

export function noticeHiddenByLater(
  notice: TosNoticeKind,
  laterVersion: number | null,
  nowSec: number,
): boolean {
  if (notice.kind === 'none' || laterVersion !== notice.version) return false;
  if (notice.kind === 'small') return true;
  return nowSec < notice.effectiveAt - LATER_FINAL_WEEK_SEC;
}

export function readLater(chainId: number, address: string): number | null {
  try {
    const raw = window.localStorage.getItem(tosNoticeLaterKey(chainId, address));
    const n = raw === null ? NaN : Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function writeLater(chainId: number, address: string, version: number): void {
  try {
    window.localStorage.setItem(tosNoticeLaterKey(chainId, address), String(version));
  } catch {
    /* a lost "later" only shows the notice again */
  }
}
