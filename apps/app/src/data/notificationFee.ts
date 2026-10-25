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
    // Own-wallet state, patched from the mined write; the net reconciles a
    // fee retune by governance.
    refetchInterval: signalAware(60_000),
    queryFn: async (): Promise<NotificationFeeConsent> => {
      if (!publicClient || !address) throw new Error('unreachable');
      const diamond = readChain.diamondAddress;
      const [config, consent] = await Promise.all([
        publicClient.readContract({
          address: diamond,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getNotificationFeeConfig',
        }) as Promise<readonly [bigint, bigint]>,
        publicClient.readContract({
          address: diamond,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getNotificationFeeConsent',
          args: [address],
        }) as Promise<readonly [bigint, boolean]>,
      ]);
      return { feeVpfi: config[0], capVpfi: consent[0], coversCurrentFee: consent[1] };
    },
  });
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
   *  on this chain, and only when the record does not already cover it. */
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
}): PaidPushConsentView {
  const { consent } = args;
  const billed = paidPushBilledOn(args.billing, args.chainId);
  const state: PaidPushConsentView['consent'] =
    consent.capVpfi === 0n ? 'none' : consent.coversCurrentFee ? 'covers' : 'below';
  return {
    billed,
    consent: state,
    offerAgree: billed === 'billed' && state !== 'covers',
    offerWithdraw: state !== 'none',
    lowVaultBalance:
      billed === 'billed' &&
      state === 'covers' &&
      args.freeVpfi !== undefined &&
      args.freeVpfi < consent.feeVpfi,
  };
}
