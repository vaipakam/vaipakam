/**
 * Paid-Push billing consent (#2723) — what the connected wallet has agreed to
 * pay for paid Push alerts, read from the chain, and what the Alerts card may
 * honestly say and offer about it.
 *
 * The consent is the wallet's own on-chain record
 * (`NotificationFeeFacet.setNotificationFeeConsent`): the most VPFI it agrees
 * to be charged per loan side, zero meaning none. The billing role can charge
 * only a wallet whose record covers the fee configured at billing time, on an
 * active loan, once per loan side; the fee leaves the wallet's vault in VPFI.
 * Both figures come from the contract, never from a constant here:
 *   - the fee — `ConfigFacet.getNotificationFeeConfig()`'s first value;
 *   - the cap and whether it covers that fee —
 *     `NotificationFeeFacet.getNotificationFeeConsent(wallet)`.
 *
 * Whether anything actually charges the fee is a separate question, and it is
 * the alert service's answer (`PushBillingState`), not the chain's: the fee is
 * configured whether or not a biller exists.
 */
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { DIAMOND_ABI_VIEM } from '../contracts/diamond';
import { useActiveChain } from '../chain/useActiveChain';
import { signalAware } from '../chain/railHealth';
import type { PushBillingState } from './alerts';

export interface NotificationFeeConsent {
  /** The fee per loan side configured right now, VPFI in 18 decimals. */
  feeVpfi: bigint;
  /** The wallet's stored cap per loan side, VPFI in 18 decimals; 0n = none. */
  capVpfi: bigint;
  /** The contract's own answer: would a bill at the current fee pass the
   *  consent check (the loan must still be active as well). */
  coversCurrentFee: boolean;
  /** The block all three figures were read at, so a later write can tell
   *  whether this read already includes it. */
  atBlock: bigint;
}

/** A consent write this card saw mined: the cap it recorded, and where. */
export interface MinedConsentWrite {
  capVpfi: bigint;
  block: bigint;
}

/**
 * The record the card shows: the chain's read, unless this card's own mined
 * write is newer than that read, in which case the write's cap stands (a
 * lagging RPC must not make the click look undone) and coverage is the
 * contract's rule — a non-zero cap at or above the fee — applied to the fee
 * as last read. The fee itself, and whether that read is current, always
 * stay the read's: a write establishes the cap, nothing else.
 */
export function effectiveConsent(
  read: NotificationFeeConsent,
  written: MinedConsentWrite | null,
): NotificationFeeConsent {
  if (!written || read.atBlock >= written.block) return read;
  return {
    ...read,
    capVpfi: written.capVpfi,
    coversCurrentFee: written.capVpfi !== 0n && read.feeVpfi <= written.capVpfi,
  };
}

export function notificationFeeConsentKey(chainId: number, address: string | undefined) {
  return ['notifFeeConsent', chainId, address?.toLowerCase()] as const;
}

/**
 * The connected wallet's consent and the current fee on the read chain.
 * A failed read is an error state, never a zero: "no consent" is a fact the
 * card states, so it must not stand in for "could not read".
 */
export function useNotificationFeeConsent() {
  const { readChain, address } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  return useQuery({
    queryKey: notificationFeeConsentKey(readChain.chainId, address),
    enabled: Boolean(publicClient) && Boolean(address),
    // Own-wallet state. The cache is only ever written by this read, never
    // patched from a write, so its error state stays the truth about whether
    // the figures are current; the card overlays its own mined write with
    // `effectiveConsent` instead. The poll reconciles a fee retune.
    refetchInterval: signalAware(60_000),
    queryFn: async (): Promise<NotificationFeeConsent> => {
      if (!publicClient || !address) throw new Error('unreachable');
      const diamond = readChain.diamondAddress;
      // Both views at ONE block, so the fee, the cap and the contract's
      // coverage answer describe the same state, and the block says whether
      // a write the card saw mined is already in it.
      const atBlock = await publicClient.getBlockNumber();
      const [config, consent] = await Promise.all([
        publicClient.readContract({
          address: diamond,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getNotificationFeeConfig',
          blockNumber: atBlock,
        }) as Promise<readonly [bigint, bigint]>,
        publicClient.readContract({
          address: diamond,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getNotificationFeeConsent',
          args: [address],
          blockNumber: atBlock,
        }) as Promise<readonly [bigint, boolean]>,
      ]);
      return { feeVpfi: config[0], capVpfi: consent[0], coversCurrentFee: consent[1], atBlock };
    },
  });
}

/**
 * The identity a consent card's own state belongs to: one wallet on one
 * network. The card is keyed on it, so a confirmation or error produced for
 * one wallet is never shown for another, even when the write completes after
 * the switch.
 */
export function paidPushConsentScope(chainId: number, address: string | undefined): string {
  return `${chainId}:${address?.toLowerCase() ?? ''}`;
}

/** Whether the alert service charges the fee on this chain, as it says. */
export type PaidPushBilled = 'billed' | 'not-billed' | 'unknown';

export function paidPushBilledOn(billing: PushBillingState | undefined, chainId: number): PaidPushBilled {
  if (!billing || billing.kind === 'unknown') return 'unknown';
  return billing.chainIds.includes(chainId) ? 'billed' : 'not-billed';
}

export interface PaidPushConsentView {
  billed: PaidPushBilled;
  /** What the wallet's record says: none, a cap that covers the current fee,
   *  or a cap below it (which no bill can pass). */
  consent: 'none' | 'covers' | 'below';
  /** Offer agreeing to the current fee — only where the service says it bills
   *  on this chain, only when the record does not already cover it, and only
   *  from a CURRENT read: a cached fee may no longer be the fee. */
  offerAgree: boolean;
  /** Offer withdrawing — whenever any consent is stored, whatever the billing
   *  posture, the Terms or the protocol's pause state. */
  offerWithdraw: boolean;
  /** The vault's free VPFI is known and below the fee while a covering consent
   *  stands on a billed chain: a bill would fail, so the card warns. */
  lowVaultBalance: boolean;
}

/**
 * The card's whole decision, kept pure so every combination is pinned by a
 * unit test rather than by reading JSX.
 *
 * The contract's `coversCurrentFee` is used as given rather than recomputed
 * from the two figures: it is the check a bill runs, so it is the one to
 * report.
 */
export function paidPushConsentView(args: {
  billing: PushBillingState | undefined;
  chainId: number;
  consent: NotificationFeeConsent;
  /** The vault's free (unencumbered) VPFI, or undefined when unknown. */
  freeVpfi: bigint | undefined;
  /** The last refresh of `consent` failed, so it is the last-known record,
   *  not a current one. The card says so; withdrawing stays offered (a zero
   *  cap is right whatever the record became), agreeing does not. */
  stale: boolean;
}): PaidPushConsentView {
  const { consent } = args;
  const billed = paidPushBilledOn(args.billing, args.chainId);
  const state: PaidPushConsentView['consent'] =
    consent.capVpfi === 0n ? 'none' : consent.coversCurrentFee ? 'covers' : 'below';
  return {
    billed,
    consent: state,
    offerAgree: billed === 'billed' && state !== 'covers' && !args.stale,
    offerWithdraw: state !== 'none',
    lowVaultBalance:
      billed === 'billed' &&
      state === 'covers' &&
      args.freeVpfi !== undefined &&
      args.freeVpfi < consent.feeVpfi,
  };
}
