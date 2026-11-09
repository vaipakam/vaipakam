/**
 * ACC-RISK — progressive risk access, as the protocol states it. Each wallet
 * carries a risk level it chose itself (every wallet starts at blue-chip
 * only); a pair whose riskier leg needs a higher level is refused until the
 * wallet raises it, an illiquid pair also needs the wallet's agreement to
 * that exact pair, and a wallet in strict mode needs an acknowledgement for
 * each liquid pair. A raise or an agreement may wait out a waiting period the
 * protocol configures before it counts.
 *
 * WHICH step a flow needs is never decided here: it comes from the
 * protocol's own answer for that flow (the accept preview's code, or the
 * create dry run's refusal), so this module cannot drift from the gate. What
 * this module adds is the detail the step needs, read in one block through
 * the wallet's connection, and the one rule that turns it into a plan: the
 * transaction to offer, or the time to wait for.
 */
import type { Abi, PublicClient } from 'viem';
import { ConfigFacetABI, RiskAccessFacetABI, RiskPreviewFacetABI } from '@vaipakam/contracts/abis';

type Hex = `0x${string}`;

const RISK_ACCESS = RiskAccessFacetABI as Abi;
const RISK_PREVIEW = RiskPreviewFacetABI as Abi;
const CONFIG = ConfigFacetABI as Abi;

/** `LibVaipakam.RiskAccessLevel`, by enum position. */
export const RISK_LEVELS = ['blue-chip', 'liquid', 'any'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export function riskLevel(n: number): RiskLevel {
  return RISK_LEVELS[n] ?? 'any';
}

/** The step the protocol's answer asks of this wallet. */
export type RiskNeed = 'tier' | 'pair-consent' | 'mid-tier-ack';

/** `LibRiskAccess.PairId`: the exact pair a level is checked against and an
 *  agreement binds to. ERC-20 legs carry token id 0 and no prepay token. */
export interface RiskPair {
  lendAsset: Hex;
  lendType: number;
  lendTokenId: bigint;
  collAsset: Hex;
  collType: number;
  collTokenId: bigint;
  prepayAsset: Hex;
}

const ZERO: Hex = '0x0000000000000000000000000000000000000000';

/** The pair of a loan of one ERC-20 against another. */
export function erc20Pair(lendAsset: Hex, collAsset: Hex): RiskPair {
  return { lendAsset, lendType: 0, lendTokenId: 0n, collAsset, collType: 0, collTokenId: 0n, prepayAsset: ZERO };
}

/** The pair of a loan of an ERC-20 against an NFT (NFT-13; `collType` 1
 *  for ERC-721, 2 for ERC-1155): the protocol keys a consent to the token's
 *  id, so each token is its own pair. */
export function nftCollateralPair(lendAsset: Hex, collAsset: Hex, collType: 1 | 2, tokenId: bigint): RiskPair {
  return { lendAsset, lendType: 0, lendTokenId: 0n, collAsset, collType, collTokenId: tokenId, prepayAsset: ZERO };
}

/** A stable name for a pair, to key a flow's review of it. */
export function pairName(p: RiskPair): string {
  return [p.lendAsset, p.lendType, p.lendTokenId, p.collAsset, p.collType, p.collTokenId, p.prepayAsset].map((x) => String(x).toLowerCase()).join(':');
}

/** The accept preview's codes (`previewOfferAcceptBlock`) for a block this
 *  wallet can act on. Code 4 is the illiquid pair the acceptance's
 *  acknowledgement once softened: a pair consent clears it, as it clears 2.
 *  The creator's own block is never this wallet's to fix. */
export function needFromAcceptCode(code: number): RiskNeed | null {
  if (code === 1) return 'tier';
  if (code === 2 || code === 4) return 'pair-consent';
  if (code === 3) return 'mid-tier-ack';
  return null;
}

/** The create dry run's refusals (`LibRiskAccess`'s errors), by name. */
export function needFromRefusal(code: string): RiskNeed | null {
  if (code === 'RiskTierTooLow') return 'tier';
  if (code === 'IlliquidPairNotConsented') return 'pair-consent';
  if (code === 'MidTierPairNotAcknowledged') return 'mid-tier-ack';
  return null;
}

/** What the step stands on, read in one block. */
export interface RiskStatus {
  need: RiskNeed;
  pair: RiskPair;
  /** The level the pair needs (the riskier leg governs). */
  required: number;
  /** The level the wallet last chose, whether or not it counts yet. */
  held: number;
  /** The level the protocol applies now. */
  effective: number;
  /** A risk-terms change since the wallet chose its level: it counts as
   *  blue-chip only until the wallet confirms it again. */
  stale: boolean;
  /** When a raise the wallet made counts (unix seconds); at or before
   *  `chainNow` once it does. */
  unlockAt: bigint;
  /** The protocol's waiting period for a raise or an agreement, seconds. */
  cooldown: bigint;
  /** The wallet's level-change counter and the risk-terms version, which a
   *  raise names so it is refused, changing nothing, if either moved. */
  nonce: bigint;
  termsVersion: bigint;
  /** For an agreement or acknowledgement: recorded, still in its waiting
   *  period. */
  pending: boolean;
  /** For an agreement or acknowledgement: in effect now. */
  inEffect: boolean;
  /** Whether the gate is switched on for this network at all. */
  gateOn: boolean;
  chainNow: bigint;
  blockNumber: bigint;
}

export type RiskPlan =
  /** Raise the level to `level` (the least the pair needs); a re-raise of a
   *  level a terms change made stale is `reaffirm`. */
  | { kind: 'raise' | 'reaffirm'; level: number }
  /** Agree to this exact illiquid pair. */
  | { kind: 'consent' }
  /** Acknowledge this exact liquid pair (strict mode). */
  | { kind: 'ack' }
  /** A raise is recorded and counts from `until`. */
  | { kind: 'wait-tier'; until: bigint }
  /** An agreement or acknowledgement is recorded and still in its waiting
   *  period. The protocol has no read for when that period ends (#3229), so
   *  no time is stated: one this session remembered could belong to an
   *  earlier grant that was revoked and given again since. */
  | { kind: 'wait-pair' }
  /** The reads say the step is no longer needed: the protocol's next answer
   *  for the flow decides. */
  | { kind: 'met' };

/**
 * The one rule from a status to the step. A raise already recorded and still
 * waiting is never offered again, because a second raise starts its waiting
 * period over; likewise an agreement still in its waiting period.
 */
export function riskPlan(s: RiskStatus): RiskPlan {
  if (!s.gateOn) return { kind: 'met' };
  if (s.need === 'tier') {
    if (s.effective >= s.required) return { kind: 'met' };
    if (s.held >= s.required && !s.stale && s.unlockAt > s.chainNow) return { kind: 'wait-tier', until: s.unlockAt };
    if (s.held >= s.required && s.stale) return { kind: 'reaffirm', level: s.held };
    return { kind: 'raise', level: s.required };
  }
  if (s.inEffect) return { kind: 'met' };
  if (s.pending) return { kind: 'wait-pair' };
  return { kind: s.need === 'pair-consent' ? 'consent' : 'ack' };
}

/** When a step taken now would count: at once, or after the waiting period
 *  (from the block that records it, so this is an estimate until then). */
export function effectiveAfter(s: Pick<RiskStatus, 'cooldown' | 'chainNow'>): bigint | null {
  return s.cooldown === 0n ? null : s.chainNow + s.cooldown;
}

/** The function a plan sends, with its arguments. */
export function planCall(plan: RiskPlan, s: RiskStatus): { functionName: string; args: readonly unknown[] } | null {
  switch (plan.kind) {
    case 'raise':
    case 'reaffirm':
      return { functionName: 'setVaultRiskTierChecked', args: [plan.level, s.nonce, s.termsVersion] };
    case 'consent':
      return { functionName: 'setIlliquidPairConsent', args: [s.pair, true] };
    case 'ack':
      return { functionName: 'setMidTierPairAck', args: [s.pair] };
    default:
      return null;
  }
}

export const PLAN_SIGNATURES: Readonly<Record<'tier' | 'consent' | 'ack', string>> = {
  tier: 'setVaultRiskTierChecked(uint8,uint64,uint64)',
  consent: 'setIlliquidPairConsent((address,uint8,uint256,address,uint8,uint256,address),bool)',
  ack: 'setMidTierPairAck((address,uint8,uint256,address,uint8,uint256,address))',
};

export const STRICT_SIGNATURE = 'setRiskStrictMode(bool)';

/** Where the step's pair comes from: the exact pair an acceptance of the
 *  offer is checked against (the protocol resolves it), or a pair the flow
 *  builds itself (a new request). */
export type PairSource = { kind: 'offer'; offerId: bigint } | { kind: 'pair'; pair: RiskPair };

function pairFrom(raw: Record<string, unknown>): RiskPair {
  return {
    lendAsset: raw.lendAsset as Hex,
    lendType: Number(raw.lendType),
    lendTokenId: raw.lendTokenId as bigint,
    collAsset: raw.collAsset as Hex,
    collType: Number(raw.collType),
    collTokenId: raw.collTokenId as bigint,
    prepayAsset: raw.prepayAsset as Hex,
  };
}

/** Every figure the step stands on, from one block. */
export async function readRiskStatus(c: PublicClient, diamond: Hex, account: Hex, need: RiskNeed, source: PairSource, blockNumber?: bigint): Promise<RiskStatus> {
  const block = await c.getBlock(blockNumber === undefined ? { blockTag: 'latest' } : { blockNumber });
  const at = { blockNumber: block.number };
  const read = <T>(abi: Abi, functionName: string, args: readonly unknown[] = []) => c.readContract({ address: diamond, abi, functionName, args, ...at }) as Promise<T>;
  const pair = source.kind === 'pair' ? source.pair : pairFrom(await read<Record<string, unknown>>(RISK_PREVIEW, 'acceptMidTierAckPair', [source.offerId]));
  const [gateOn, required, held, effective, tierVersion, termsVersion, unlockAt, cooldown, nonce] = await Promise.all([
    read<boolean>(CONFIG, 'getRiskAccessGateEnabled'),
    read<number>(RISK_ACCESS, 'pairRequiredRiskLevel', [pair]),
    read<number>(RISK_ACCESS, 'getVaultRiskTier', [account]),
    read<number>(RISK_ACCESS, 'getEffectiveRiskTier', [account]),
    read<bigint>(RISK_ACCESS, 'getVaultRiskTierVersion', [account]),
    read<bigint>(RISK_ACCESS, 'getCurrentRiskTermsVersion'),
    read<bigint>(RISK_ACCESS, 'getRiskTierUnlockAt', [account]),
    read<bigint>(RISK_ACCESS, 'getRiskAccessUnlockCooldown'),
    read<bigint>(RISK_ACCESS, 'getRiskTierMutationNonce', [account]),
  ]);
  let pending = false;
  let inEffect = false;
  if (need === 'pair-consent') {
    [pending, inEffect] = await Promise.all([
      read<boolean>(RISK_ACCESS, 'isPairConsentPending', [account, pair]),
      read<boolean>(RISK_ACCESS, 'hasIlliquidPairConsent', [account, pair]),
    ]);
  } else if (need === 'mid-tier-ack') {
    const [p, blocked] = await Promise.all([
      read<boolean>(RISK_ACCESS, 'isMidTierAckPending', [account, pair]),
      read<boolean>(RISK_ACCESS, 'midTierStrictBlocked', [account, pair]),
    ]);
    pending = p;
    inEffect = !blocked;
  }
  return {
    need,
    pair,
    required: Number(required),
    held: Number(held),
    effective: Number(effective),
    stale: Number(held) > 0 && tierVersion < termsVersion,
    unlockAt,
    cooldown,
    nonce,
    termsVersion,
    pending,
    inEffect,
    gateOn,
    chainNow: block.timestamp,
    blockNumber: block.number,
  };
}

/**
 * ACC-33 — the wallet's own risk-access settings on this network, read in one
 * block: the level it chose and the level that counts now, why they differ
 * (a raise still in its waiting period, or a risk-terms change since), and
 * strict mode with how long a switched-off strict mode still applies.
 */
export interface RiskSettings {
  gateOn: boolean;
  held: number;
  effective: number;
  stale: boolean;
  unlockAt: bigint;
  cooldown: bigint;
  nonce: bigint;
  termsVersion: bigint;
  /** The strict-mode switch as the wallet last set it. */
  strict: boolean;
  /** When a switched-off strict mode stops applying (unix seconds; 0 when it
   *  was never switched off, or switched on again since). */
  strictUntil: bigint;
  chainNow: bigint;
  blockNumber: bigint;
}

export async function readRiskSettings(c: PublicClient, diamond: Hex, account: Hex, blockNumber?: bigint): Promise<RiskSettings> {
  const block = await c.getBlock(blockNumber === undefined ? { blockTag: 'latest' } : { blockNumber });
  const at = { blockNumber: block.number };
  const read = <T>(abi: Abi, functionName: string, args: readonly unknown[] = []) => c.readContract({ address: diamond, abi, functionName, args, ...at }) as Promise<T>;
  const [gateOn, held, effective, tierVersion, termsVersion, unlockAt, cooldown, nonce, strict, strictUntil] = await Promise.all([
    read<boolean>(CONFIG, 'getRiskAccessGateEnabled'),
    read<number>(RISK_ACCESS, 'getVaultRiskTier', [account]),
    read<number>(RISK_ACCESS, 'getEffectiveRiskTier', [account]),
    read<bigint>(RISK_ACCESS, 'getVaultRiskTierVersion', [account]),
    read<bigint>(RISK_ACCESS, 'getCurrentRiskTermsVersion'),
    read<bigint>(RISK_ACCESS, 'getRiskTierUnlockAt', [account]),
    read<bigint>(RISK_ACCESS, 'getRiskAccessUnlockCooldown'),
    read<bigint>(RISK_ACCESS, 'getRiskTierMutationNonce', [account]),
    read<boolean>(RISK_ACCESS, 'getRiskStrictMode', [account]),
    read<bigint>(RISK_ACCESS, 'getStrictModeStrictUntil', [account]),
  ]);
  return {
    gateOn,
    held: Number(held),
    effective: Number(effective),
    stale: Number(held) > 0 && tierVersion < termsVersion,
    unlockAt,
    cooldown,
    nonce,
    termsVersion,
    strict,
    strictUntil: BigInt(strictUntil),
    chainNow: block.timestamp,
    blockNumber: block.number,
  };
}

export { RISK_ACCESS as RISK_ACCESS_ABI };
