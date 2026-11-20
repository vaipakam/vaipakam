/**
 * The first risk-access step a wallet lacks for an ERC-20 pair, as a fill on
 * that pair checks them. Shared by every review that opens a loan from a
 * standing source (Auto-lend, Borrow now).
 */
import type { OwnStateClient } from '../../chain/ownRail';
import { erc20Pair, readRiskStatus, riskPlan, type RiskNeed } from './riskAccess';

type Hex = `0x${string}`;

/** The protocol's `RiskAccessLevel.IlliquidCustom`. */
const ILLIQUID_LEVEL = 2;

/** The first risk-access step this wallet lacks for the pair, in the order
 *  the protocol checks them at a fill (level, illiquid pair consent, strict
 *  acknowledgement), read through the same rule the risk step applies; null
 *  when none is needed. */
export async function readRiskNeed(own: OwnStateClient, diamond: Hex, lending: Hex, collateral: Hex): Promise<RiskNeed | null> {
  const pair = erc20Pair(lending, collateral);
  const status = (need: RiskNeed) => own.read((c) => readRiskStatus(c, diamond, own.account, need, { kind: 'pair', pair })).then((x) => x.value);
  const tier = await status('tier');
  if (riskPlan(tier).kind !== 'met') return 'tier';
  // Only the illiquid boundary carries a per-pair consent, checked at every
  // fill like the level.
  if (tier.gateOn && tier.required === ILLIQUID_LEVEL && riskPlan(await status('pair-consent')).kind !== 'met') return 'pair-consent';
  if (riskPlan(await status('mid-tier-ack')).kind !== 'met') return 'mid-tier-ack';
  return null;
}
