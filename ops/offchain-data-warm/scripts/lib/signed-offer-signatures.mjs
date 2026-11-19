/**
 * #2899 — re-check every archived signed order's signature before the restore
 * puts it back on the book.
 *
 * The indexer's POST route admits an order only when its signature recovers
 * the signer over the order on that chain's Diamond. A row written straight
 * into the database before the backup ran skipped that check. It could never
 * be filled (the Diamond checks the signature at fill), but a restore that
 * trusted it would list it until it expired, and a taker trying it would pay
 * gas for a revert. So the converter applies the route's own rule again,
 * from the one shared statement of it (`packages/lib/src/signedOfferCrypto.mjs`).
 *
 * A row passes when:
 *   - its chain has a Diamond in this build's deployment bundle (the route
 *     refuses an order for any other chain);
 *   - `order_hash` is the struct hash of `order_json` (the route stores the
 *     row under the hash it computes); and
 *   - the signature recovers the order's signer under that Diamond's
 *     EIP-712 domain, for the order alone or in the set its `offer_set`
 *     placement names.
 *
 * Its own module, kept out of `restore-from-archive.mjs`, because it needs
 * viem: this package's dependency, resolved from here. The converter loads
 * it only when it runs, so the indexer's classification check, which imports
 * the converter from inside the pnpm workspace, never needs it.
 */
import { readFileSync } from 'node:fs';
import { concat, encodeAbiParameters, hashDomain, hashStruct, keccak256, recoverAddress } from 'viem';
import { signedOfferCrypto } from '../../../../packages/lib/src/signedOfferCrypto.mjs';
import { parseStoredOrderJson } from '../../../../packages/lib/src/signedOfferWire.mjs';

const rule = signedOfferCrypto({ concat, encodeAbiParameters, hashDomain, hashStruct, keccak256, recoverAddress });

/** This build's deployment bundle, the same file the indexer's route reads
 *  its Diamond from. */
export const DEPLOYMENTS_PATH = new URL('../../../../packages/contracts/src/deployments.json', import.meta.url);

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Chain id to Diamond address, from a parsed deployment bundle. */
export function bundleDiamonds(bundle) {
  const diamonds = new Map();
  for (const [key, dep] of Object.entries(bundle ?? {})) {
    const chainId = Number(key);
    if (!Number.isSafeInteger(chainId) || chainId <= 0 || String(chainId) !== key) continue;
    if (typeof dep?.diamond === 'string' && ADDRESS.test(dep.diamond)) diamonds.set(chainId, dep.diamond);
  }
  return diamonds;
}

/** {@link bundleDiamonds} of the committed bundle. */
export function committedDiamonds() {
  return bundleDiamonds(JSON.parse(readFileSync(DEPLOYMENTS_PATH, 'utf8')));
}

/** The key a verdict is filed under. */
export const verdictKey = (chainId, orderHash) => `${chainId}:${orderHash}`;

/**
 * Why one archived row fails the route's signature rule, or null when it
 * passes. A row whose own shape is wrong gets a problem here too; the
 * converter refuses such a row outright before it reads this verdict.
 */
export async function signedOfferSignatureProblem(row, diamonds) {
  const diamond = diamonds.get(row?.chain_id);
  if (diamond === undefined) {
    return `chain ${JSON.stringify(row?.chain_id)} has no Diamond in this build's deployment bundle, so the book would refuse the order`;
  }
  const parsed = parseStoredOrderJson(row.order_json);
  if ('error' in parsed) return parsed.error;
  if (row.order_hash !== rule.orderHashOf(parsed.order)) return 'order_hash is not the struct hash of order_json';
  let placement = null;
  if (row.offer_set !== null && row.offer_set !== undefined) {
    try {
      placement = JSON.parse(row.offer_set);
    } catch {
      return 'offer_set is not JSON';
    }
  }
  const ok = await rule.verifySignedOffer(parsed.order, row.signature, row.chain_id, diamond, placement);
  return ok ? null : `the signature does not recover the signer for chain ${row.chain_id}'s Diamond ${diamond}`;
}

/**
 * A verdict for every `signed_offers` row of an archive: a Map from
 * {@link verdictKey} to null (passes) or the problem. The converter refuses
 * to restore the table without one for each row.
 */
export async function signedOfferVerdicts(archive, diamonds = committedDiamonds()) {
  const verdicts = new Map();
  const table = (archive?.d1?.archive ?? []).find((t) => t?.name === 'signed_offers');
  for (const row of Array.isArray(table?.rows) ? table.rows : []) {
    verdicts.set(verdictKey(row?.chain_id, row?.order_hash), await signedOfferSignatureProblem(row, diamonds));
  }
  return verdicts;
}
