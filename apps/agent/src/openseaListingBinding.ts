/**
 * Bind a `POST /opensea/listing` order to protocol state before the
 * OpenSea key is spent on it (#2755).
 *
 * The proxy used to shape-check the body and forward it, so anyone who
 * could reach it could post any Seaport order to OpenSea under the
 * project's API key. A Vaipakam listing is not just any order: the Diamond
 * builds it in `postPrepayListing` (or the Dutch, atomic, auto-list and
 * parallel-sale paths) and registers its hash with the collateral-listing
 * executor, which is what the borrower vault's ERC-1271 check asks. So the
 * proxy publishes an order only when the chain says it is one of ours:
 *
 *   1. the chain has a Vaipakam deployment, and this Worker an RPC for it;
 *   2. the Diamond names a collateral-listing executor
 *      (`getCollateralListingExecutor`; zero means listings are off);
 *   3. the order's zone IS that executor, and `protocol_address` is the
 *      Seaport the executor is bound to (`seaport()`);
 *   4. Seaport's own `getOrderHash` over the submitted components gives a
 *      hash the executor reports live (`isOrderValid`).
 *
 * The hash is computed by Seaport from the components the agent parsed,
 * never taken from the caller, so a body cannot pair a live hash with
 * different contents. A chain read that fails refuses the post (503):
 * an order this Worker could not check is not published.
 *
 * What it does not check, stated: an executor rotated by governance
 * leaves listings registered on the previous executor unpublishable here,
 * because only the Diamond's CURRENT executor is trusted. Those orders stay
 * valid on-chain; only their OpenSea discoverability is lost.
 *
 * Two of the reads are against the executor, whose ABI is not exported to
 * `@vaipakam/contracts` (it is not a Diamond facet). They are declared
 * here as fragments, and `test/openseaListingBinding.test.ts` pins both
 * against the contract source. Seaport is third-party; its fragment is the
 * shared `SEAPORT_VERIFY_ABI`.
 */

import { getDeployment } from '@vaipakam/contracts/deployments';
import { PrepayListingFacetABI } from '@vaipakam/contracts/abis';
import { SEAPORT_VERIFY_ABI } from '@vaipakam/lib/prepayOrderShape';
import { createPublicClient, http, type Address, type Hex } from 'viem';
import { getRpcChains, type Env } from './env';
import { redactedError } from '@vaipakam/lib/errorDescription';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const UINT = /^(0|[1-9][0-9]{0,77})$/;
/** Seaport `ItemType` runs 0..5. */
const MAX_ITEM_TYPE = 5;
/** Seaport `OrderType` runs 0..4. */
const MAX_ORDER_TYPE = 4;
/** A prepay listing carries one offer item and a few consideration legs
 *  (the one proceeds leg to the Diamond, then any collection fees). The cap
 *  bounds what a body can make Seaport hash; it is far above real use. */
const MAX_ITEMS = 32;

/** The executor reads this module makes; see the module doc for why they
 *  are fragments. */
export const LISTING_EXECUTOR_ABI = [
  { type: 'function', name: 'seaport', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  {
    type: 'function',
    name: 'isOrderValid',
    stateMutability: 'view',
    inputs: [{ name: 'hash', type: 'bytes32' }],
    outputs: [{ type: 'bool' }],
  },
] as const;

interface OfferItem {
  itemType: number;
  token: Address;
  identifierOrCriteria: bigint;
  startAmount: bigint;
  endAmount: bigint;
}

interface ConsiderationItem extends OfferItem {
  recipient: Address;
}

/** Seaport `OrderComponents`, parsed: what `getOrderHash` consumes. */
export interface OrderComponents {
  offerer: Address;
  zone: Address;
  offer: OfferItem[];
  consideration: ConsiderationItem[];
  orderType: number;
  startTime: bigint;
  endTime: bigint;
  zoneHash: Hex;
  salt: bigint;
  conduitKey: Hex;
  counter: bigint;
}

function smallInt(v: unknown, max: number): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : null;
}

function uint(v: unknown): bigint | null {
  return typeof v === 'string' && UINT.test(v) ? BigInt(v) : null;
}

function address(v: unknown): Address | null {
  return typeof v === 'string' && ADDRESS.test(v) ? (v as Address) : null;
}

function bytes32(v: unknown): Hex | null {
  return typeof v === 'string' && BYTES32.test(v) ? (v as Hex) : null;
}

function item(raw: unknown): OfferItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const itemType = smallInt(o.itemType, MAX_ITEM_TYPE);
  const token = address(o.token);
  const identifierOrCriteria = uint(o.identifierOrCriteria);
  const startAmount = uint(o.startAmount);
  const endAmount = uint(o.endAmount);
  if (itemType === null || !token || identifierOrCriteria === null || startAmount === null || endAmount === null) {
    return null;
  }
  return { itemType, token, identifierOrCriteria, startAmount, endAmount };
}

function items<T>(raw: unknown, each: (v: unknown) => T | null): T[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ITEMS) return null;
  const out: T[] = [];
  for (const v of raw) {
    const parsed = each(v);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

/**
 * Parse the body's `parameters` as Seaport `OrderComponents`, in the
 * shape `@vaipakam/lib/prepayOrderShape` builds: addresses and bytes32 as
 * hex, every uint256 as a decimal string, the two enums as numbers.
 * Anything else is refused, so only fields Seaport hashes reach the
 * upstream. (`totalOriginalConsiderationItems`, which OpenSea's API wants
 * and Seaport does not hash, is derived by the proxy, never taken.)
 */
export function parseOrderComponents(raw: unknown): OrderComponents | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const offerer = address(o.offerer);
  const zone = address(o.zone);
  const offer = items(o.offer, item);
  const consideration = items(o.consideration, (v) => {
    // `item` refuses anything that is not an object, so `v` is read for its
    // recipient only once it has parsed as one.
    const base = item(v);
    if (!base) return null;
    const recipient = address((v as Record<string, unknown>).recipient);
    return recipient ? { ...base, recipient } : null;
  });
  const orderType = smallInt(o.orderType, MAX_ORDER_TYPE);
  const startTime = uint(o.startTime);
  const endTime = uint(o.endTime);
  const zoneHash = bytes32(o.zoneHash);
  const salt = uint(o.salt);
  const conduitKey = bytes32(o.conduitKey);
  const counter = uint(o.counter);
  if (
    !offerer ||
    !zone ||
    !offer ||
    !consideration ||
    orderType === null ||
    startTime === null ||
    endTime === null ||
    !zoneHash ||
    salt === null ||
    !conduitKey ||
    counter === null
  ) {
    return null;
  }
  return { offerer, zone, offer, consideration, orderType, startTime, endTime, zoneHash, salt, conduitKey, counter };
}

/** The OpenSea `parameters` envelope for parsed components: decimal
 *  strings for every uint256, plus the item count OpenSea requires. */
export function openSeaParameters(c: OrderComponents): Record<string, unknown> {
  const s = (v: bigint) => v.toString();
  const offerItem = (i: OfferItem) => ({
    itemType: i.itemType,
    token: i.token,
    identifierOrCriteria: s(i.identifierOrCriteria),
    startAmount: s(i.startAmount),
    endAmount: s(i.endAmount),
  });
  return {
    offerer: c.offerer,
    zone: c.zone,
    offer: c.offer.map(offerItem),
    consideration: c.consideration.map((i) => ({ ...offerItem(i), recipient: i.recipient })),
    orderType: c.orderType,
    startTime: s(c.startTime),
    endTime: s(c.endTime),
    zoneHash: c.zoneHash,
    salt: s(c.salt),
    conduitKey: c.conduitKey,
    counter: s(c.counter),
    totalOriginalConsiderationItems: c.consideration.length,
  };
}

/** The chain reads the binding needs; injectable for tests. */
export interface ListingChainReader {
  listingExecutor(diamond: Address): Promise<Address>;
  executorSeaport(executor: Address): Promise<Address>;
  orderHash(seaport: Address, components: OrderComponents): Promise<Hex>;
  isOrderValid(executor: Address, hash: Hex): Promise<boolean>;
}

/** The reader over one chain's RPC. */
export function rpcListingReader(rpcUrl: string): ListingChainReader {
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 5_000, retryCount: 0 }) });
  return {
    listingExecutor: (diamond) =>
      client.readContract({
        address: diamond,
        abi: PrepayListingFacetABI,
        functionName: 'getCollateralListingExecutor',
      }) as Promise<Address>,
    executorSeaport: (executor) =>
      client.readContract({ address: executor, abi: LISTING_EXECUTOR_ABI, functionName: 'seaport' }),
    orderHash: (seaport, components) =>
      client.readContract({
        address: seaport,
        abi: SEAPORT_VERIFY_ABI,
        functionName: 'getOrderHash',
        args: [components],
      }),
    isOrderValid: (executor, hash) =>
      client.readContract({
        address: executor,
        abi: LISTING_EXECUTOR_ABI,
        functionName: 'isOrderValid',
        args: [hash],
      }),
  };
}

/** The binding's verdict. `bound` carries the Seaport the order is for;
 *  `refused` carries the HTTP status and the error name to answer with. */
export type ListingBinding =
  | { kind: 'bound'; seaport: Address; orderHash: Hex }
  | { kind: 'refused'; status: number; error: string };

const refuse = (status: number, error: string): ListingBinding => ({ kind: 'refused', status, error });

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Decide whether `components`, posted for `protocolAddress` on `chainId`,
 * is a live Vaipakam listing. See the module doc for the four checks.
 *
 * `reader` defaults to one over the chain's configured RPC; it is passed
 * only by tests.
 */
export async function bindListingToProtocol(
  env: Env,
  chainId: number,
  components: OrderComponents,
  protocolAddress: Address,
  reader?: ListingChainReader,
): Promise<ListingBinding> {
  const deployment = getDeployment(chainId);
  if (!deployment?.diamond) return refuse(400, 'no-deployment-for-chain');
  let chain = reader;
  if (!chain) {
    const rpc = getRpcChains(env).find((c) => c.id === chainId)?.rpc;
    if (!rpc) return refuse(503, 'listing-check-unavailable');
    chain = rpcListingReader(rpc);
  }
  try {
    const executor = await chain.listingExecutor(deployment.diamond as Address);
    if (/^0x0{40}$/i.test(executor)) return refuse(400, 'listings-not-enabled');
    if (!same(components.zone, executor)) return refuse(400, 'order-not-a-vaipakam-listing');
    const seaport = await chain.executorSeaport(executor);
    if (!same(protocolAddress, seaport)) return refuse(400, 'wrong-protocol-address');
    const orderHash = await chain.orderHash(seaport, components);
    if (!(await chain.isOrderValid(executor, orderHash))) return refuse(400, 'order-not-live');
    return { kind: 'bound', seaport, orderHash };
  } catch (err) {
    console.error('[opensea/listing] chain check failed; refusing the post', redactedError(err));
    return refuse(503, 'listing-check-unavailable');
  }
}
