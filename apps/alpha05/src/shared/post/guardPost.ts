/**
 * #3358 — a price-move guard armed with the post itself, so the offer is
 * never on the book unguarded. The protocol takes it as one transaction of
 * two steps through its batch entry (`MulticallFacet.multicall`, which keeps
 * the poster as the caller): `armOfferPriceGuard(bps)` arms the next offer
 * this wallet creates in the transaction, then `createOffer` posts it and
 * records the guard from the oracle prices at that moment. Either step
 * failing reverts both, with the step's own refusal. Only an offer of an
 * ERC-20 against ERC-20 collateral whose prices can both be read carries a
 * guard (`OfferPriceGuardUnpriced` otherwise).
 *
 * Without a guard the post is the plain `createOffer` call, unchanged. The
 * guard's rule and its wording are the offer page's (shared/offers/priceGuard).
 */
import { encodeFunctionData, type Abi, type Log, type PublicClient } from 'viem';
import { MulticallFacetABI, OracleFacetABI } from '@vaipakam/contracts/abis';
import type { CopyAccess } from '../copy/useCopy';
import { answerOrNull } from '../reads/answer';
import { bpsPercent, guardRecorded, PRICE_GUARD } from '../offers/priceGuard';
import type { ReceiptRow, ReceiptText } from '../receipt/types';
import type { LegOutcome } from '../tx/outcome';
import type { ParsedPost } from './postModel';

type Hex = `0x${string}`;
type Copy = Pick<CopyAccess, 'text' | 'format'>;

const MULTICALL = MulticallFacetABI as Abi;
const ORACLE = OracleFacetABI as Abi;

/** The batch entry plus every error either step can raise, so a refusal is
 *  named (and its arguments decoded) as it would be from the step alone:
 *  the batch re-raises the step's revert verbatim. */
function batchAbi(create: Abi): Abi {
  const seen = new Set<string>();
  const out: Abi[number][] = [];
  for (const item of [...MULTICALL, ...create.filter((i) => i.type === 'error'), ...PRICE_GUARD.filter((i) => i.type === 'error')]) {
    const key =
      item.type === 'error' || item.type === 'function' || item.type === 'event' ? `${item.type}:${item.name}:${JSON.stringify(item.inputs)}` : item.type;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out as Abi;
}

/** The post as one contract call: `createOffer(params)` alone, or, with a
 *  guard, the batch arming it first. The dry run and the write both take
 *  this, so the review is the protocol's verdict on what is sent. */
export function postCall(create: Abi, params: unknown, guardBps: number | null) {
  if (guardBps === null) return { abi: create, functionName: 'createOffer', args: [params] as const };
  const calls = [
    { callData: encodeFunctionData({ abi: PRICE_GUARD, functionName: 'armOfferPriceGuard', args: [guardBps] }), allowFailure: false },
    { callData: encodeFunctionData({ abi: create, functionName: 'createOffer', args: [params] }), allowFailure: false },
  ];
  return { abi: batchAbi(create), functionName: 'multicall', args: [calls] as const };
}

/**
 * Whether the protocol can record a guard on this pair now: both tokens
 * have a non-zero oracle price (the rule `LibPairCalm.price1e18` applies
 * when the post records the guard). Read on its own because the post's dry
 * run stops at the token pull before it reaches the guard, while an
 * approval is still owed; the dry run with the approval in place is the
 * verdict. A refused price read is `false`; a failed source throws.
 */
export async function readGuardPriced(c: PublicClient, diamond: Hex, lending: Hex, collateral: Hex, blockNumber?: bigint): Promise<boolean> {
  const priced = async (asset: Hex) => {
    const r = await answerOrNull(
      c.readContract({ address: diamond, abi: ORACLE, functionName: 'getAssetPrice', args: [asset], blockNumber }) as Promise<readonly [bigint, number]>,
    );
    return r !== null && r[0] > 0n;
  };
  const [p, q] = await Promise.all([priced(lending), priced(collateral)]);
  return p && q;
}

/** The guard's receipt row, bound by the post; none without a guard. */
export function guardRows(parsed: Pick<ParsedPost, 'guardBps'>, copy: Copy): ReceiptRow[] {
  if (parsed.guardBps === null) return [];
  return [
    {
      label: copy.text('priceGuard.rowLimit'),
      value: { kind: 'text', text: copy.format('request.guardRow', { limit: bpsPercent(parsed.guardBps) }) },
      binding: true,
    },
  ];
}

/** What the guard does to the posted offer, said before it is signed. */
export function guardConsequences(parsed: Pick<ParsedPost, 'guardBps'>, copy: Copy): ReceiptText[] {
  if (parsed.guardBps === null) return [];
  const { text, format } = copy;
  return [
    format('request.guardWhat', { limit: bpsPercent(parsed.guardBps) }),
    text('priceGuard.setCalm'),
    text('priceGuard.setRecorded'),
    text('priceGuard.setCheckpoints'),
    text('priceGuard.setOnlyRefuses'),
  ];
}

/** The guard as the transaction recorded it for the offer it created; none
 *  without a guard. */
export function guardPostLeg(parsed: Pick<ParsedPost, 'guardBps'>, logs: readonly Log[], diamond: Hex, offerId: bigint | null, copy: Copy): LegOutcome[] {
  if (parsed.guardBps === null) return [];
  const label = copy.format('priceGuard.legSet', { limit: bpsPercent(parsed.guardBps) });
  return offerId !== null && guardRecorded(logs, diamond, offerId, parsed.guardBps)
    ? [{ status: 'done', label }]
    : [{ status: 'not-done', label, reason: copy.text('priceGuard.legMissing') }];
}
