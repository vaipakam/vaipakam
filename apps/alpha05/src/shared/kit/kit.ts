/**
 * #3773 — the embedded lending kit's hand-off, as the app reads it.
 *
 * A kit link opens `/kit` with what an integrator's page asked for: borrow
 * against an asset, lend an amount, or rent a token, and the integrator's id.
 * The link is read with the kit's own parser (`@vaipakam/lend-kit`), so a link
 * the kit would refuse the app refuses too. Nothing is signed on `/kit`: the
 * user continues to the platform's own page, filled in, and meets the usual
 * review there.
 *
 * The integrator travels with the hand-off as a choice the user can drop. It
 * reaches a transaction only where the protocol reads it from the borrower's
 * own action (accepting a lender's offer, or posting a borrow request); on a
 * lender's offer it is attribution only, and a rental pays no initiation fee.
 * The registry's answer for it is read from the chain and stated, never
 * assumed: registered and active, suspended, or not registered.
 */
import type { Abi } from 'viem';
import { IntegratorFacetABI } from '@vaipakam/contracts/abis';
import { KitLinkError, parseKitParams, SHARE_RULE, type KitRequest, type ShareRule } from '@vaipakam/lend-kit';
import { DEFAULT_INPUT, type PostInput } from '../post/postModel';

type Hex = `0x${string}`;

const INTEGRATOR = IntegratorFacetABI as Abi;

/** #3773 — the borrow form a "borrow against this" link opens on. A link
 *  naming an NFT carries its token id (and an ERC-1155 quantity) into the
 *  form; continuing a new link starts the form fresh, so nothing typed for
 *  an earlier collateral (another token, another amount) stays beside it.
 *  Null for any other action. */
export function kitRequestInput(r: KitRequest): PostInput | null {
  if (r.action !== 'borrow') return null;
  return {
    ...DEFAULT_INPUT,
    tokenId: r.tokenId !== undefined ? r.tokenId.toString() : '',
    collateral: r.quantity !== undefined ? r.quantity.toString() : '',
  };
}

/** Where the hand-off is kept while the user moves to the filled-in page. */
export const KIT_HANDOFF_KEY = 'kit.handoff';

/** What the user continued with from `/kit`: the request, and the integrator
 *  still named (null once the user dropped it). */
export interface KitHandoff {
  request: KitRequest;
  integrator: Hex | null;
}

export type KitRead = { ok: true; request: KitRequest } | { ok: false; reason: string };

/** The link's query, read with the kit's own rule. */
export function readKitLink(search: URLSearchParams): KitRead {
  try {
    return { ok: true, request: parseKitParams(search) };
  } catch (e) {
    if (e instanceof KitLinkError) return { ok: false, reason: e.message };
    throw e;
  }
}

export { SHARE_RULE, type ShareRule };

/** The registry's entry for an integrator, as `getIntegrator` returns it. */
export interface IntegratorEntry {
  status: 'active' | 'suspended' | 'none';
  /** The registered name; empty when not registered. */
  name: string;
}

const STATUS = ['none', 'active', 'suspended'] as const;

/** Reads `integrator`'s registry entry. Throws when the read fails, so the
 *  own rail tries its next source and the page states it as unread. */
export async function readIntegratorEntry(c: { readContract: (a: any) => Promise<unknown> }, diamond: Hex, integrator: Hex): Promise<IntegratorEntry> {
  const v = (await c.readContract({ address: diamond, abi: INTEGRATOR, functionName: 'getIntegrator', args: [integrator] })) as { status: number; name: string };
  const status = STATUS[Number(v.status)];
  if (status === undefined) throw new Error(`the registry answered an unknown status (${String(v.status)})`);
  return { status, name: status === 'none' ? '' : v.name };
}

/** Why the protocol would pay a named integrator nothing on a loan this
 *  borrower opens now (`LibIntegrator.Refusal`, in its order). */
const REFUSAL = ['none', 'not-named', 'not-registered', 'suspended', 'flagged', 'borrower-is-integrator'] as const;
export type ShareRefusal = (typeof REFUSAL)[number];

/** What the protocol answers for `integrator` on a loan `borrower` opens now:
 *  the rate it would be paid at (basis points of the loan initiation fee,
 *  before the per-loan ceiling) or the reason it would be paid nothing. The
 *  answer is the chain's at the read; acceptance asks again. */
export interface IntegratorShare {
  rateBps: bigint;
  refusal: ShareRefusal;
}

/** Reads `integratorRateFor`. Throws when the read fails. */
export async function readIntegratorShare(
  c: { readContract: (a: any) => Promise<unknown> },
  diamond: Hex,
  integrator: Hex,
  borrower: Hex,
): Promise<IntegratorShare> {
  const [rateBps, code] = (await c.readContract({ address: diamond, abi: INTEGRATOR, functionName: 'integratorRateFor', args: [integrator, borrower] })) as readonly [bigint, number];
  const refusal = REFUSAL[Number(code)];
  if (refusal === undefined) throw new Error(`the registry answered an unknown refusal (${String(code)})`);
  return { rateBps, refusal };
}

/** Whether a share can be paid on this action, given the entry: only a
 *  borrower's action naming an active entry can bring one. */
export function shareApplies(request: KitRequest, entry: IntegratorEntry | null): boolean | null {
  if (SHARE_RULE[request.action] !== 'may-apply') return false;
  if (entry === null) return null;
  return entry.status === 'active';
}

/** The route the request continues on. */
export function kitRoute(request: KitRequest): '/borrow' | '/lend' | '/rent' {
  return request.action === 'borrow' ? '/borrow' : request.action === 'lend' ? '/lend' : '/rent';
}
