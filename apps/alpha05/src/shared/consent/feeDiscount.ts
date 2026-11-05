/**
 * RW-07 — the shared fee-discount consent: ONE platform-level flag per
 * network, not per offer or loan. Off, the holding discount is 0 whatever
 * VPFI the vault holds. On, a borrower's loan initiation fee is reduced at
 * acceptance when the lending asset is liquid (in the lending asset, no VPFI
 * moved; an illiquid loan pays the full fee), and a lender's fee on
 * interest is discounted at each settlement, delivered one of two ways the
 * deployment's VPFI price configuration selects:
 * - `vpfi`: a price source is configured, so the discounted fee is paid in
 *   VPFI from the lender's vault and the lender keeps all the interest,
 *   when at that settlement a quote reads and enough unlocked, tracked VPFI
 *   is in the vault; a settlement where it cannot be paid that way gets no
 *   holding discount (the contract's own fallback), and the copy says so;
 * - `direct`: none is configured, so the fee itself is reduced in the loan's
 *   asset and no VPFI moves.
 * Toggling never broadcasts a tier to other networks.
 */
import type { Abi, PublicClient } from 'viem';
import { VPFIDiscountFacetABI } from '@vaipakam/contracts/abis';
import type { CopyAccess } from '../copy/useCopy';
import type { Receipt } from '../receipt/types';

export const VPFI_DISCOUNT_ABI = VPFIDiscountFacetABI as Abi;
export const SET_CONSENT_SIGNATURE = 'setVPFIDiscountConsent(bool)';

export type DeliveryMode = 'vpfi' | 'direct';

const ZERO = '0x0000000000000000000000000000000000000000';

export async function readFeeDiscountConsent(client: PublicClient, diamond: `0x${string}`, account: `0x${string}`): Promise<boolean> {
  return (await client.readContract({ address: diamond, abi: VPFI_DISCOUNT_ABI, functionName: 'getVPFIDiscountConsent', args: [account] })) as boolean;
}

/** The lender discount's delivery mode, from the price configuration: VPFI
 *  payment only when BOTH the rate and its reference asset are set (the rule
 *  the settlement applies). */
export function modeFrom(weiPerVpfi: bigint, ethPriceAsset: string): DeliveryMode {
  return weiPerVpfi !== 0n && ethPriceAsset.toLowerCase() !== ZERO ? 'vpfi' : 'direct';
}

export async function readDeliveryMode(client: PublicClient, diamond: `0x${string}`): Promise<DeliveryMode> {
  const [weiPerVpfi, ethPriceAsset] = (await client.readContract({ address: diamond, abi: VPFI_DISCOUNT_ABI, functionName: 'getVPFIDiscountConfig' })) as readonly [
    bigint,
    `0x${string}`,
  ];
  return modeFrom(weiPerVpfi, ethPriceAsset);
}

/** What the open review was built from; the receipt renders from this. */
export interface Reviewed {
  target: boolean;
  /** null: the delivery mode could not be read, and the receipt says so. */
  mode: DeliveryMode | null;
  readAt: number;
}

/** The review's receipt (RB-CONFIDENCE): what turning the flag on or off
 *  changes, how a lender's discount is delivered, and what stays unchanged.
 *  The size of the discount is the tier's at the moment a fee is charged, so
 *  no figure is promised. */
export function consentReceipt(r: Reviewed, chainName: string, copy: Pick<CopyAccess, 'text' | 'format'>): Receipt {
  const { text, format } = copy;
  const state = text(r.target ? 'consent.stateOn' : 'consent.stateOff');
  const lend =
    !r.target
      ? { kind: 'text' as const, text: text('consent.lendOff') }
      : r.mode === null
        ? { kind: 'unknown' as const, why: text('consent.modeUnknown') }
        : { kind: 'text' as const, text: text(r.mode === 'vpfi' ? 'consent.lendVpfi' : 'consent.lendDirect') };
  const consequences = !r.target
    ? [text('consent.loseOff')]
    : r.mode === 'vpfi'
      ? [text('consent.loseVpfi')]
      : r.mode === null
        ? [text('consent.loseUnknown')]
        : [];
  return {
    title: text(r.target ? 'consent.titleOn' : 'consent.titleOff'),
    rows: [
      { label: text('consent.rowSetting'), value: { kind: 'text', text: format('consent.settingValue', { chain: chainName, state }) }, binding: true },
      { label: text('consent.rowBorrow'), value: { kind: 'text', text: text(r.target ? 'consent.borrowOn' : 'consent.borrowOff') }, binding: true },
      { label: text('consent.rowLend'), value: lend, binding: true },
      ...(r.target ? [{ label: text('consent.rowSize'), value: { kind: 'text' as const, text: text('consent.size') }, binding: false }] : []),
      { label: text('consent.rowUnchanged'), value: { kind: 'text', text: text('consent.unchanged') }, binding: false },
    ],
    consequences,
    prompts: 1,
    readAt: r.readAt,
  };
}
