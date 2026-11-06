/**
 * OFF-22 — the creator's opt-in to the Full VPFI fee tariff on an offer.
 *
 * The protocol owns every rule here, and the app only asks it:
 * - the master switch (`getFeeEntitlementConfig().enabled`, RB-SWITCH class
 *   1a, off by default), which the surface states either way;
 * - the tariff itself (`quoteCStar`), which depends on the lending asset,
 *   the principal and the term, so a range has one figure per end;
 * - the free VPFI in the creator's vault, read exactly as the charge reads
 *   it: the vault's balance capped by the protocol's tracked balance, less
 *   the active liens (`LibFeeEntitlement.freeVpfiBalance`).
 *
 * The opt-in is its own transaction (`setOfferCreatorFullTariff`), sent by
 * the creator after posting and before any lender takes the offer. Each
 * loan the offer opens pays its own tariff, priced at that loan's principal
 * when it opens, and only when every condition holds at that moment; a
 * failed condition refuses the loan unless the creator allowed it to open
 * without the tariff.
 */
import { erc20Abi, type Abi, type PublicClient } from 'viem';
import { ConfigFacetABI, FeeEntitlementFacetABI, MetricsFacetABI, ProfileFacetABI, VPFIDiscountFacetABI, VPFITokenFacetABI } from '@vaipakam/contracts/abis';
import type { AtBlock } from '../tx/anchored';
import { OFFER_CANCEL, readVault } from './reads';

type Hex = `0x${string}`;

const ZERO: Hex = '0x0000000000000000000000000000000000000000';
export const VPFI_DECIMALS = 18;

export const CONFIG = ConfigFacetABI as Abi;
export const FEE_ENTITLEMENT = FeeEntitlementFacetABI as Abi;
export const PROFILE = ProfileFacetABI as Abi;
const METRICS = MetricsFacetABI as Abi;
const VPFI_DISCOUNT = VPFIDiscountFacetABI as Abi;
const VPFI_TOKEN = VPFITokenFacetABI as Abi;

/** The errors the opt-in and the charge raise, by name. */
export const TARIFF_ERRORS: ReadonlySet<string> = new Set(['FeeEntitlementDisabled', 'FeeEntitlementFullOptInFailed', 'FeeEntitlementTariffAboveAuth', 'FullTariffMaxCStarRequired']);

/** What the creator authorizes: the most VPFI one loan may take, and
 *  whether a loan the tariff cannot be taken on opens without it (true) or
 *  is refused (false). */
export interface TariffChoice {
  maxCStar: bigint;
  allowDowngrade: boolean;
}

export interface TariffQuote {
  /** VPFI wei (1e18) per Full party for one loan of that principal. */
  cStar: bigint;
  /** False when the protocol cannot price the lending asset: no tariff can
   *  be taken then. */
  numeraireOk: boolean;
}

const at = (b?: AtBlock) => (b ? { blockNumber: b.blockNumber } : {});

/** The master switch. */
export async function readTariffSwitch(client: PublicClient, diamond: Hex, b?: AtBlock): Promise<boolean> {
  const r = (await client.readContract({ address: diamond, abi: CONFIG, functionName: 'getFeeEntitlementConfig', ...at(b) })) as readonly [boolean, bigint, bigint];
  return r[0];
}

/** The tariff for one loan of `principal` over `durationDays`. */
export async function readTariffQuote(client: PublicClient, diamond: Hex, lending: Hex, principal: bigint, durationDays: number): Promise<TariffQuote> {
  const r = (await client.readContract({
    address: diamond,
    abi: FEE_ENTITLEMENT,
    functionName: 'quoteCStar',
    args: [lending, principal, BigInt(durationDays)],
  })) as readonly [bigint, boolean];
  return { cStar: r[0], numeraireOk: r[1] };
}

/** The VPFI the charge could take from this wallet's vault now: none
 *  without a vault; otherwise the balance capped by the tracked balance,
 *  less the active liens, the same figure the charge checks. */
export async function readFreeVpfi(client: PublicClient, diamond: Hex, account: Hex): Promise<bigint> {
  const vault = await readVault(client, diamond, account);
  if (vault.toLowerCase() === ZERO) return 0n;
  const vpfi = (await client.readContract({ address: diamond, abi: VPFI_TOKEN, functionName: 'getVPFIToken' })) as Hex;
  if (vpfi.toLowerCase() === ZERO) return 0n;
  const [raw, tracked] = await Promise.all([
    client.readContract({ address: vpfi, abi: erc20Abi, functionName: 'balanceOf', args: [vault] }) as Promise<bigint>,
    client.readContract({ address: diamond, abi: VPFI_DISCOUNT, functionName: 'getTrackedVPFIBalance', args: [account] }) as Promise<bigint>,
  ]);
  const held = raw < tracked ? raw : tracked;
  return (await client.readContract({ address: diamond, abi: METRICS, functionName: 'getFreeBalance', args: [account, vpfi, 0n, held] })) as bigint;
}

/** The opt-in as an offer stores it (`getOffer`). */
export interface StoredTariff {
  creatorFull: boolean;
  creatorMaxCStar: bigint;
  creatorAllowFullDowngrade: boolean;
}

export function storedTariffFrom(raw: Record<string, unknown>): StoredTariff {
  return {
    creatorFull: Boolean(raw.creatorFull),
    creatorMaxCStar: (raw.creatorMaxCStar as bigint | undefined) ?? 0n,
    creatorAllowFullDowngrade: Boolean(raw.creatorAllowFullDowngrade),
  };
}

/** The offer as the opt-in needs it: who may set it, whether a lender has
 *  taken it (the protocol refuses the opt-in then), and what is stored. */
export interface OfferTariffState {
  creator: Hex;
  accepted: boolean;
  stored: StoredTariff;
}

export async function readOfferTariff(client: PublicClient, diamond: Hex, offerId: bigint, b?: AtBlock): Promise<OfferTariffState> {
  const raw = (await client.readContract({ address: diamond, abi: OFFER_CANCEL, functionName: 'getOffer', args: [offerId], ...at(b) })) as Record<string, unknown>;
  return { creator: raw.creator as Hex, accepted: Boolean(raw.accepted), stored: storedTariffFrom(raw) };
}

/** The opt-in's signature, for the deployment's routing check. */
export const SET_TARIFF_SIGNATURE = 'setOfferCreatorFullTariff(uint256,bool,uint256,bool)';

/** Whether a stored opt-in is exactly the one chosen. */
export function tariffMatches(stored: StoredTariff, choice: TariffChoice): boolean {
  return stored.creatorFull && stored.creatorMaxCStar === choice.maxCStar && stored.creatorAllowFullDowngrade === choice.allowDowngrade;
}

/** What the protocol's own reads say about an opt-in before it is armed. */
export interface TariffRead {
  /** The switch; null when it could not be read. */
  enabled: boolean | null;
  /** The tariff for the smallest and the largest loan the offer can open;
   *  null when it could not be read. */
  smallest: TariffQuote | null;
  largest: TariffQuote | null;
  /** The lending asset's class now; null when it could not be read. The
   *  charge refuses an illiquid principal. */
  liquid: boolean | null;
  /** The VPFI the charge could take from the vault now; null when unread. */
  freeVpfi: bigint | null;
}

/**
 * What stands in the way of the tariff, judged only from the protocol's
 * reads. `fails` names a condition under which NO loan can take it (the
 * switch off, an unpriced or illiquid lending asset, a ceiling below the
 * smallest loan's tariff): with the downgrade allowed every loan opens
 * without it, otherwise every loan is refused. `partial` names one under
 * which a larger loan cannot (a ceiling below the largest loan's tariff, a
 * vault holding less than it). `unread` names what could not be read.
 */
export type TariffIssue =
  | { kind: 'off' }
  | { kind: 'unpriced' }
  | { kind: 'illiquid' }
  | { kind: 'ceiling-below-all'; smallest: bigint; ceiling: bigint }
  | { kind: 'ceiling-below-largest'; largest: bigint; ceiling: bigint }
  | { kind: 'vault-short'; free: bigint; needed: bigint }
  | { kind: 'unread'; what: 'switch' | 'quote' | 'liquidity' | 'vault' };

export const FAILS_EVERY_LOAN: ReadonlySet<TariffIssue['kind']> = new Set(['off', 'unpriced', 'illiquid', 'ceiling-below-all']);

export function tariffIssues(choice: TariffChoice, read: TariffRead): TariffIssue[] {
  const out: TariffIssue[] = [];
  if (read.enabled === false) out.push({ kind: 'off' });
  else if (read.enabled === null) out.push({ kind: 'unread', what: 'switch' });
  if (read.smallest === null || read.largest === null) out.push({ kind: 'unread', what: 'quote' });
  else if (!read.smallest.numeraireOk || !read.largest.numeraireOk) out.push({ kind: 'unpriced' });
  if (read.liquid === false) out.push({ kind: 'illiquid' });
  else if (read.liquid === null) out.push({ kind: 'unread', what: 'liquidity' });
  if (read.smallest !== null && read.largest !== null && read.smallest.numeraireOk && read.largest.numeraireOk) {
    if (choice.maxCStar < read.smallest.cStar) out.push({ kind: 'ceiling-below-all', smallest: read.smallest.cStar, ceiling: choice.maxCStar });
    else if (choice.maxCStar < read.largest.cStar) out.push({ kind: 'ceiling-below-largest', largest: read.largest.cStar, ceiling: choice.maxCStar });
    if (read.freeVpfi === null) out.push({ kind: 'unread', what: 'vault' });
    else if (read.freeVpfi < read.largest.cStar) out.push({ kind: 'vault-short', free: read.freeVpfi, needed: read.largest.cStar });
  }
  return out;
}

/** The ceiling the form fills in for an untouched field: today's tariff
 *  for the largest loan, which no loan of this offer exceeds at today's
 *  figures. */
export function suggestedCeiling(largest: TariffQuote | null): bigint | null {
  return largest !== null && largest.numeraireOk && largest.cStar > 0n ? largest.cStar : null;
}
