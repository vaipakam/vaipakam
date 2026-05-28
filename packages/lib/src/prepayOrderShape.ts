/**
 * T-086 step 14 — JS-side reconstruction of the canonical Seaport
 * `OrderComponents` shape the diamond locks in
 * `NFTPrepayListingFacet.postPrepayListing` /
 * `updatePrepayListing`.
 *
 * The on-chain construction lives in
 * `contracts/src/libraries/LibPrepayOrder.sol::_components`. The
 * shape MUST match exactly — OpenSea will call `isValidSignature`
 * on the borrower's vault, and the vault's ERC-1271 only returns
 * the magic value for the orderHash recorded by `_buildAndRecord`.
 * Any divergence in field order, units, or item ordering produces a
 * different orderHash and OpenSea rejects the listing.
 *
 * The defensive pattern this module uses:
 *   1. Build the components in JS from on-chain reads + the
 *      caller-supplied `salt` / `conduitKey` / `askPrice`.
 *   2. Re-compute the orderHash via Seaport's own `getOrderHash`
 *      staticcall using the constructed components.
 *   3. Compare to the orderHash the diamond emitted in
 *      `PrepayListingPosted`. If they disagree, the reconstruction
 *      diverged — surface the failure to the caller and DO NOT
 *      POST to OpenSea (a wrong-orderHash POST would silently fail
 *      OpenSea's downstream `isValidSignature` check).
 *
 * Seaport item-type enum mirrors the on-chain `ItemType`:
 *   NATIVE   = 0, ERC20 = 1, ERC721 = 2, ERC1155 = 3, …
 * Seaport order-type enum mirrors `OrderType`:
 *   FULL_OPEN = 0, PARTIAL_OPEN = 1, FULL_RESTRICTED = 2,
 *   PARTIAL_RESTRICTED = 3, CONTRACT = 4. T-086 uses 2.
 */

/** Solidity-side `AssetType` enum (LibVaipakam.AssetType). */
export const ASSET_TYPE_ERC20 = 0;
export const ASSET_TYPE_ERC721 = 1;
export const ASSET_TYPE_ERC1155 = 2;

/** Seaport `ItemType` values consumed by the order's offer + consideration. */
export const SEAPORT_ITEM_TYPE_ERC20 = 1;
export const SEAPORT_ITEM_TYPE_ERC721 = 2;
export const SEAPORT_ITEM_TYPE_ERC1155 = 3;

/** Seaport `OrderType.FULL_RESTRICTED` — T-086 listings use this
 *  exclusively (executor must be the only fill caller, full-balance
 *  ERC1155 invariant, FULL_RESTRICTED routing). */
export const SEAPORT_ORDER_TYPE_FULL_RESTRICTED = 2;

/**
 * Inputs the diamond's `_buildAndRecord` consumed when it computed
 * the orderHash. Pulled together by the caller from a mix of:
 *   - `getLoanDetails(loanId)` / `getPrepayContext(loanId, asOf)`
 *   - The post tx's block timestamp (= the diamond's `block.timestamp`
 *     at the post call)
 *   - Borrower's inputs (`askPrice`, `salt`, `conduitKey`)
 *   - Seaport's `getCounter(vault)` view
 */
export interface PrepayOrderInput {
  /** Borrower's vault address (= `s.userVaipakamVaults[loan.borrower]`). */
  vault: string;
  /** Executor address (= `s.collateralListingExecutor`). */
  executor: string;
  /** Collateral asset type — `AssetType.ERC721` (1) or `ERC1155` (2).
   *  ERC20 collateral is rejected at the facet boundary; we still
   *  accept it here defensively but the construction will throw. */
  collateralAssetType: number;
  /** Collateral NFT contract address. */
  collateralAsset: string;
  /** Collateral token id. */
  collateralTokenId: bigint;
  /** Collateral quantity — `1` for ERC721, the full vaulted balance
   *  for ERC1155 (T-086 §7 full-balance invariant). */
  collateralQuantity: bigint;
  /** Principal asset (ERC20) the consideration legs are denominated
   *  in. T-086 enforces ERC20-principal at the availability gate. */
  principalAsset: string;
  /** Live lender leg from `getPrepayContext.lenderLeg` AT
   *  `asOfTimestamp == post tx block.timestamp`. */
  lenderLeg: bigint;
  /** Live treasury leg from `getPrepayContext.treasuryLeg` at the
   *  post tx block.timestamp. */
  treasuryLeg: bigint;
  /** Borrower's ask price. The remainder leg is
   *  `askPrice - lenderLeg - treasuryLeg`. */
  askPrice: bigint;
  /** Current lender-NFT holder (`getPrepayContext.lenderNftOwner`).
   *  Recipient of the lender leg. */
  lenderNftOwner: string;
  /** Current borrower-NFT holder (`getPrepayContext.borrowerNftOwner`).
   *  Recipient of the borrower remainder leg. */
  borrowerNftOwner: string;
  /** Treasury address (`s.treasury`). Recipient of the treasury leg. */
  treasury: string;
  /** Post tx's block.timestamp (= the diamond's `block.timestamp`
   *  when `postPrepayListing` ran). For an update, this is the
   *  update tx's block.timestamp. */
  startTime: bigint;
  /** `pctx.graceEnd` at post time (= loan endTime + grace seconds).
   *  Deterministic from the loan; readable via
   *  `getPrepayContext.graceEnd`. */
  graceEnd: bigint;
  /** Borrower's chosen salt (random uint256). */
  salt: bigint;
  /** Borrower's chosen conduit key (32-byte hex). */
  conduitKey: `0x${string}`;
  /** Vault's Seaport counter at post time (= `seaport.getCounter(vault)`). */
  counter: bigint;
}

/** Canonical Seaport `OrderComponents` shape — keys + ordering MUST
 *  match the on-chain struct exactly for orderHash equivalence.
 *
 *  We use the wide `string` type for `offerer` / `zone` / `token`
 *  on the JSON payload we POST to OpenSea (their API takes
 *  case-insensitive hex strings); the chain-side read path that
 *  re-computes the orderHash via viem's strict-typed ABI casts
 *  these to `\`0x${string}\`` at the boundary. */
export interface SeaportOrderComponents {
  offerer: string;
  zone: string;
  offer: SeaportOfferItem[];
  consideration: SeaportConsiderationItem[];
  orderType: number;
  startTime: string;
  endTime: string;
  zoneHash: `0x${string}`;
  salt: string;
  conduitKey: `0x${string}`;
  counter: string;
}

export interface SeaportOfferItem {
  itemType: number;
  token: string;
  identifierOrCriteria: string;
  startAmount: string;
  endAmount: string;
}

export interface SeaportConsiderationItem extends SeaportOfferItem {
  recipient: string;
}

/**
 * Build the canonical `OrderComponents` exactly as
 * `LibPrepayOrder._components` does. Field order, item-type
 * mapping, and consideration ordering are load-bearing — see this
 * module's doc comment.
 */
export function buildPrepayOrderComponents(
  input: PrepayOrderInput,
): SeaportOrderComponents {
  // Offer — single item: the collateral NFT.
  let offer: SeaportOfferItem;
  if (input.collateralAssetType === ASSET_TYPE_ERC721) {
    offer = {
      itemType: SEAPORT_ITEM_TYPE_ERC721,
      token: input.collateralAsset,
      identifierOrCriteria: input.collateralTokenId.toString(),
      // ERC721 — amount is always 1.
      startAmount: '1',
      endAmount: '1',
    };
  } else if (input.collateralAssetType === ASSET_TYPE_ERC1155) {
    offer = {
      itemType: SEAPORT_ITEM_TYPE_ERC1155,
      token: input.collateralAsset,
      identifierOrCriteria: input.collateralTokenId.toString(),
      // ERC1155 — full vaulted balance per T-086 §7.
      startAmount: input.collateralQuantity.toString(),
      endAmount: input.collateralQuantity.toString(),
    };
  } else {
    throw new Error(
      `prepayOrderShape: unsupported collateralAssetType ${input.collateralAssetType}; ` +
        `T-086 requires ERC721 (1) or ERC1155 (2)`,
    );
  }

  // Consideration — three legs, in this exact order:
  //   [0] lender ERC20 → lenderNftOwner
  //   [1] treasury ERC20 → treasury
  //   [2] borrower-remainder ERC20 → borrowerNftOwner
  const borrowerLeg = input.askPrice - input.lenderLeg - input.treasuryLeg;
  if (borrowerLeg < 0n) {
    // Mirrors the on-chain `_requireAskCoversFloor` revert path.
    throw new Error(
      'prepayOrderShape: askPrice below lender+treasury legs; the diamond would have reverted',
    );
  }
  const consideration: SeaportConsiderationItem[] = [
    {
      itemType: SEAPORT_ITEM_TYPE_ERC20,
      token: input.principalAsset,
      identifierOrCriteria: '0',
      startAmount: input.lenderLeg.toString(),
      endAmount: input.lenderLeg.toString(),
      recipient: input.lenderNftOwner,
    },
    {
      itemType: SEAPORT_ITEM_TYPE_ERC20,
      token: input.principalAsset,
      identifierOrCriteria: '0',
      startAmount: input.treasuryLeg.toString(),
      endAmount: input.treasuryLeg.toString(),
      recipient: input.treasury,
    },
    {
      itemType: SEAPORT_ITEM_TYPE_ERC20,
      token: input.principalAsset,
      identifierOrCriteria: '0',
      startAmount: borrowerLeg.toString(),
      endAmount: borrowerLeg.toString(),
      recipient: input.borrowerNftOwner,
    },
  ];

  return {
    offerer: input.vault,
    zone: input.executor,
    offer: [offer],
    consideration,
    orderType: SEAPORT_ORDER_TYPE_FULL_RESTRICTED,
    startTime: input.startTime.toString(),
    endTime: input.graceEnd.toString(),
    // No zone-side payload — the executor reads loan state directly.
    zoneHash:
      '0x0000000000000000000000000000000000000000000000000000000000000000',
    salt: input.salt.toString(),
    conduitKey: input.conduitKey,
    counter: input.counter.toString(),
  };
}

/** OpenSea chain slugs — one per chain id the proxy accepts. Kept
 *  identical to `apps/agent/src/openseaProxy.ts:OPENSEA_CHAINS` so
 *  the frontend deep-link points at the same surface the proxy
 *  POSTs to. */
const OPENSEA_CHAIN_SLUGS: Record<number, { host: string; slug: string }> = {
  1: { host: 'opensea.io', slug: 'ethereum' },
  8453: { host: 'opensea.io', slug: 'base' },
  42161: { host: 'opensea.io', slug: 'arbitrum' },
  10: { host: 'opensea.io', slug: 'optimism' },
  11155111: { host: 'testnets.opensea.io', slug: 'sepolia' },
  84532: { host: 'testnets.opensea.io', slug: 'base_sepolia' },
  421614: { host: 'testnets.opensea.io', slug: 'arbitrum_sepolia' },
  11155420: { host: 'testnets.opensea.io', slug: 'optimism_sepolia' },
};

/**
 * Construct the OpenSea asset URL for a given collateral NFT.
 * OpenSea's marketplace UI uses `/assets/{chainSlug}/{contract}/{tokenId}`
 * for both ERC721 and ERC1155 — the listing surface for our orderHash
 * appears on this page once the proxy POST has been accepted.
 *
 * Returns `null` for unsupported chains so the caller can omit the
 * deep-link without crashing.
 */
export function openSeaAssetUrl(
  chainId: number,
  collateralAsset: string,
  collateralTokenId: bigint,
): string | null {
  const chain = OPENSEA_CHAIN_SLUGS[chainId];
  if (!chain) return null;
  return `https://${chain.host}/assets/${chain.slug}/${collateralAsset.toLowerCase()}/${collateralTokenId.toString()}`;
}

/** Minimum Seaport ABI fragment the frontend's verification step
 *  needs — `getOrderHash` for the JS-vs-chain reconciliation, and
 *  `getCounter` for the vault's order counter at post time. */
export const SEAPORT_VERIFY_ABI = [
  {
    type: 'function',
    name: 'getOrderHash',
    stateMutability: 'view',
    inputs: [
      {
        name: 'order',
        type: 'tuple',
        components: [
          { name: 'offerer', type: 'address' },
          { name: 'zone', type: 'address' },
          {
            name: 'offer',
            type: 'tuple[]',
            components: [
              { name: 'itemType', type: 'uint8' },
              { name: 'token', type: 'address' },
              { name: 'identifierOrCriteria', type: 'uint256' },
              { name: 'startAmount', type: 'uint256' },
              { name: 'endAmount', type: 'uint256' },
            ],
          },
          {
            name: 'consideration',
            type: 'tuple[]',
            components: [
              { name: 'itemType', type: 'uint8' },
              { name: 'token', type: 'address' },
              { name: 'identifierOrCriteria', type: 'uint256' },
              { name: 'startAmount', type: 'uint256' },
              { name: 'endAmount', type: 'uint256' },
              { name: 'recipient', type: 'address' },
            ],
          },
          { name: 'orderType', type: 'uint8' },
          { name: 'startTime', type: 'uint256' },
          { name: 'endTime', type: 'uint256' },
          { name: 'zoneHash', type: 'bytes32' },
          { name: 'salt', type: 'uint256' },
          { name: 'conduitKey', type: 'bytes32' },
          { name: 'counter', type: 'uint256' },
        ],
      },
    ],
    outputs: [{ name: 'orderHash', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'getCounter',
    stateMutability: 'view',
    inputs: [{ name: 'offerer', type: 'address' }],
    outputs: [{ name: 'counter', type: 'uint256' }],
  },
] as const;
