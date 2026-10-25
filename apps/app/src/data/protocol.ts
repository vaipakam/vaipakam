/**
 * Live protocol config reads. Copy that quotes a fee/buffer must use
 * these, never a hardcoded number — governance can retune them.
 */
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import type { PublicClient } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { useActiveChain } from '../chain/useActiveChain';
import { readProtocolConfigBundle, type ProtocolBundleValue } from '@vaipakam/lib/protocolKnobs';
import { fetchFreshConfigValues } from './indexer';
import { readGraceSecondsLive } from '../contracts/preflights';
import { defaultGraceSeconds, formatGraceSeconds } from '../lib/grace';
import {
  autoRefinancePostureFrom,
  type AutoMatchSwitches,
  type AutoRefinancePosture,
} from './autoRefinancePosture';

/** Deploy default (5%) — display fallback only. Money paths must use
 *  {@link readRentalBufferBps} or gate on `ready`. */
const RENTAL_BUFFER_BPS_DEFAULT = 500;

/**
 * #2812 — the LIVE configuration bundle, by field name, through the one
 * shared reader (`readProtocolConfigBundle`): decoded only when the chain's
 * answer has the shape this build's ABI describes. Any other shape means the
 * deployed ConfigFacet is not the code this build was compiled against, and
 * a positional read would hand back a neighbouring field's number, so this
 * THROWS with the reason instead. Submit paths fail closed on that like on
 * any failed read; display hooks fall back to their deploy default and stay
 * not-ready.
 */
export async function readConfigBundleLive(
  publicClient: PublicClient,
  diamondAddress: `0x${string}`,
): Promise<Record<string, ProtocolBundleValue>> {
  const r = await readProtocolConfigBundle({
    client: publicClient,
    diamond: diamondAddress,
    abi: DIAMOND_ABI_VIEM,
  });
  if (r.kind === 'unreadable') throw new Error(r.reason);
  return r.values;
}

/** One named integer field of the bundle (a decimal string in both the
 *  snapshot and the shared reader's output), or a throw: a field that is
 *  absent or not an integer is never read as a number. */
export function bundleInteger(values: object, field: string): number {
  const v = (values as Readonly<Record<string, unknown>>)[field];
  if (typeof v !== 'string' || !/^\d+$/.test(v)) {
    throw new Error(`the configuration bundle carries no integer ${field}`);
  }
  return Number(v);
}

/** Direct read of the LIVE buffer — for submit paths. Throws on read
 *  failure instead of substituting a default: an under-read buffer
 *  under-approves the renter's prepay and the accept reverts AFTER the
 *  user signed (governance can raise the buffer to 2,000 bps). */
export async function readRentalBufferBps(
  publicClient: PublicClient,
  diamondAddress: `0x${string}`,
): Promise<number> {
  return bundleInteger(await readConfigBundleLive(publicClient, diamondAddress), 'rentalBufferBps');
}

/** NFT-rental prepay buffer in bps (the bundle's `rentalBufferBps`).
 *  `ready` is false while the value is still the fallback — display may
 *  proceed, signing must not. */
export function useRentalBufferBps(): { bps: number; ready: boolean } {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });

  const { data } = useQuery({
    queryKey: ['rentalBufferBps', readChain.chainId],
    enabled: Boolean(publicClient),
    staleTime: 5 * 60_000,
    // RPC read-diet PR B — display from the indexer snapshot's named
    // `rentalBufferBps`, chain fallback; submit paths use
    // readRentalBufferBps directly and never come here.
    queryFn: async () => {
      const snap = await fetchFreshConfigValues(readChain.chainId);
      if (snap?.rentalBufferBps !== undefined) return bundleInteger(snap, 'rentalBufferBps');
      return readRentalBufferBps(publicClient!, readChain.diamondAddress);
    },
  });

  return { bps: data ?? RENTAL_BUFFER_BPS_DEFAULT, ready: data !== undefined };
}

/** LIVE grace label for receipts — governance can override the
 *  default schedule with buckets, and the shown grace must match the
 *  window repayment is actually judged against. The label falls back
 *  to the default-schedule wording while loading (identical on
 *  deploys with no buckets configured) so DISPLAY can proceed, but
 *  `ready` stays false until the live bucket answer lands — SIGNING
 *  must gate on it, exactly like {@link useRentalBufferBps}: on a
 *  chain with retuned buckets the fallback label is a wrong term. */
export function useGraceLabel(durationDays: number): {
  label: string;
  ready: boolean;
  isError: boolean;
  refetch: () => void;
} {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  const { data, isError, refetch } = useQuery({
    queryKey: ['graceSeconds', readChain.chainId, durationDays],
    enabled: Boolean(publicClient) && durationDays > 0,
    staleTime: 5 * 60_000,
    queryFn: () =>
      readGraceSecondsLive({
        publicClient: publicClient!,
        diamondAddress: readChain.diamondAddress,
        durationDays,
      }),
  });
  return {
    label: formatGraceSeconds(data ?? defaultGraceSeconds(durationDays)),
    ready: data !== undefined,
    isError,
    refetch: () => void refetch(),
  };
}

/** The matching kill-switch (`ConfigFacet.getPartialFillEnabled`): while
 *  it is off, `matchOffers` / `matchIntent` refuse, so the desk's
 *  crossable-band surface (#1131 slice B) must key on it — a band whose
 *  Execute action the contract refuses is a lie. (It was the third value of
 *  `getMasterFlags` until #2812 retired the two range flags beside it and
 *  that tuple with them; ranged offers are always on.)
 *
 *  Long-staleTime read. `data === undefined` covers loading AND read
 *  failure — the ADVISORY surfaces treat that as "switch unknown → show
 *  nothing" (fail closed: rendering a matchable band while the switch might
 *  be OFF is worse than briefly hiding a real one). */
export function usePartialFillEnabled(): { data: boolean | undefined } {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  const { data } = useQuery({
    queryKey: ['partialFillEnabled', readChain.chainId],
    enabled: Boolean(publicClient),
    // Governance kill-switch — flips rarely; 10 min bounds the window a
    // just-flipped switch keeps the band visible (the Execute write
    // would revert harmlessly inside it).
    staleTime: 10 * 60_000,
    // RPC read-diet PR B — snapshot-first: a governance flip emits a
    // config event, so the snapshot updates within ~one ingest scan —
    // typically FRESHER than this hook's own 10-min staleTime window.
    // The crossable band's execute path still live-checks before the
    // write, so the advisory surface never turns a stale switch into a
    // doomed transaction. The chain read is the single-output getter, which
    // answers the same on every ConfigFacet build that has the switch.
    queryFn: async (): Promise<boolean> => {
      const snap = await fetchFreshConfigValues(readChain.chainId);
      if (typeof snap?.partialFillEnabled === 'boolean') return snap.partialFillEnabled;
      return (await publicClient!.readContract({
        address: readChain.diamondAddress,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'getPartialFillEnabled',
      })) as boolean;
    },
  });
  return { data };
}

/** The automatic-matching posture for refinance requests (#2349 / #2355):
 *  the protocol pause (`AdminFacet.paused`), the auto-refinance switch
 *  (`AdminFacet.getAutoRefinanceEnabled`) and the matching kill-switch
 *  (`ConfigFacet.getPartialFillEnabled`), read together in ONE
 *  query so a single read state covers all three. Neither matcher switch
 *  ever blocks a lender accepting the request directly, so the
 *  refinance surfaces DISCLOSE the posture — always, via
 *  {@link AutoMatchPostureBanner} — rather than gating the form on it.
 *  See `autoRefinancePostureFrom` for how every read state (in flight,
 *  failed, failed re-read, partly on) maps to a stated posture.
 *
 *  Read live from the chain rather than the indexer snapshot: this is an
 *  operational posture statement, and the snapshot can lag a flip.
 *  Polled every 60 s while mounted: governance flips these with no
 *  own-wallet action, and neither window focus nor the block-driven
 *  `LiveChainSync` keys cover them, so a page left open must still pick
 *  a flip up. The poll exists only while a refinance surface is on
 *  screen. */
export function useAutoRefinancePosture(): {
  posture: AutoRefinancePosture;
} {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  const { data, isError, isPaused } = useQuery({
    queryKey: ['autoMatchPosture', readChain.chainId],
    enabled: Boolean(publicClient),
    refetchInterval: 60_000,
    queryFn: async (): Promise<AutoMatchSwitches> => {
      // All three reads are PINNED to one block (#2355 r8): independent
      // `latest` reads can resolve against different blocks during a
      // staged governance flip and combine into a posture that never
      // existed on-chain.
      const blockNumber = await publicClient!.getBlockNumber();
      const [paused, autoRefinance, partialFill] = await Promise.all([
        publicClient!.readContract({
          address: readChain.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'paused',
          blockNumber,
        }) as Promise<boolean>,
        publicClient!.readContract({
          address: readChain.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getAutoRefinanceEnabled',
          blockNumber,
        }) as Promise<boolean>,
        publicClient!.readContract({
          address: readChain.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getPartialFillEnabled',
          blockNumber,
        }) as Promise<boolean>,
      ]);
      return { paused, autoRefinance, partialFill };
    },
  });
  return { posture: autoRefinancePostureFrom({ data, isError, isPaused }) };
}

/** Renter's total up-front payment for a rental:
 *  dailyFee × days, plus the refundable buffer. Mirrors OfferFacet's
 *  pull (`amount * durationDays * (BPS + buffer) / BPS`). */
export function totalRentalPrepay(
  dailyFeeWei: bigint,
  durationDays: number,
  bufferBps: number,
): bigint {
  const base = dailyFeeWei * BigInt(durationDays);
  return (base * (10_000n + BigInt(bufferBps))) / 10_000n;
}
