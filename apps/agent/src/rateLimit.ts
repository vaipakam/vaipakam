/**
 * The agent's side of the one rate-limit rule (#2755, #2756). The rule
 * itself, the slot outcomes and their refusal names live in
 * `@vaipakam/lib/rateLimit`, shared with the indexer; this module adds
 * the agent's HTTP answer (with its CORS headers) and its per-API-key
 * credential budgets.
 */

import {
  slotRefusalStatus,
  takeSlot,
  type RateLimitBinding,
  type SlotOutcome,
} from '@vaipakam/lib/rateLimit';

export {
  callerKey,
  slotRefusalStatus,
  takeCallerSlot,
  takeSlot,
  type RateLimitBinding,
  type SlotOutcome,
} from '@vaipakam/lib/rateLimit';

/**
 * The HTTP answer for a slot that was not taken, or `null` when it was,
 * with the status and name from the shared mapping (`slotRefusalStatus`)
 * and the agent's CORS headers.
 */
export function slotRefusal(
  outcome: SlotOutcome,
  corsOrigin: string,
  refusedError = 'rate-limited',
): Response | null {
  const refusal = slotRefusalStatus(outcome, refusedError);
  if (!refusal) return null;
  const { status, error } = refusal;
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': corsOrigin,
      Vary: 'Origin',
    },
  });
}

// ── Credential budgets ───────────────────────────────────────────────────

/** The operator-held API keys whose spend is budgeted, each with the
 *  binding that meters it. Every route that calls the upstream with that
 *  key draws from the same budget. */
export const CREDENTIAL_BUDGETS = {
  oneinch: 'ONEINCH_UPSTREAM_RATELIMIT',
  opensea: 'OPENSEA_UPSTREAM_RATELIMIT',
} as const;

export type Credential = keyof typeof CREDENTIAL_BUDGETS;

/** Take one slot of `credential`'s budget, immediately before one call
 *  to its upstream. */
export function takeCredentialSlot(
  env: Readonly<Partial<Record<(typeof CREDENTIAL_BUDGETS)[Credential], RateLimitBinding>>>,
  credential: Credential,
): Promise<SlotOutcome> {
  return takeSlot(env[CREDENTIAL_BUDGETS[credential]], credential);
}
