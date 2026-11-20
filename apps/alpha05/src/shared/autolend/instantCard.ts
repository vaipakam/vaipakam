/**
 * #3761 §3.5 — an Auto-lend that exists already gains no instant-market
 * consent by itself. Its card offers one line, and the owner sets the
 * consents through the same kind of review and signature as a new setup: a
 * dry run of `setInstantSlot` from the wallet, then that one call. The flash
 * line is absent until its setter exists; renewal is sent off until it is
 * built.
 */
import type { PublicClient } from 'viem';
import type { IntentSummary } from '../offers/intents';
import { INSTANT, anyInstant, readInstantAvailability, readInstantSlot, type InstantAvailability, type InstantSlotRecord } from './preset';

type Hex = `0x${string}`;

/** What the card stands on. */
export interface InstantCardFacts {
  record: InstantSlotRecord;
  availability: InstantAvailability;
}

/** The choices the review sends. */
export interface InstantChoice {
  fills: boolean;
  takeover: boolean;
}

export const INSTANT_CHOICE_PRESELECTED: InstantChoice = { fills: true, takeover: true };

/**
 * Whether the card offers the line: an active slot that takes interest by
 * time and any filler, with no instant consent set, on a pair the market
 * takes now. A slot the market cannot take shows nothing rather than an
 * offer that would be refused.
 */
export function offersInstant(intent: Pick<IntentSummary, 'acceptsProRata' | 'requiresKeeperAuth'>, active: boolean, facts: InstantCardFacts | null): boolean {
  if (!active || facts === null) return false;
  if (!intent.acceptsProRata || intent.requiresKeeperAuth) return false;
  if (facts.availability !== 'available') return false;
  return !anyInstant(facts.record);
}

export async function readInstantCardFacts(c: PublicClient, diamond: Hex, owner: Hex, lending: Hex, collateral: Hex, slot: number): Promise<InstantCardFacts> {
  const [record, availability] = await Promise.all([
    readInstantSlot(c, diamond, owner, lending, collateral, slot),
    readInstantAvailability(c, diamond, owner, lending, collateral, slot),
  ]);
  return { record, availability };
}

/** The one call the review sends. */
export function instantSlotCall(lending: Hex, collateral: Hex, slot: number, choice: InstantChoice, validUntil: bigint) {
  return {
    abi: INSTANT,
    functionName: 'setInstantSlot' as const,
    // Renewal is sent off: it is not built (`RENEWAL_BUILT`).
    args: [lending, collateral, slot, choice.fills, false, choice.takeover, true, validUntil] as const,
  };
}
