/**
 * Rate Desk phase 3 (#1131) signed-offer spec helpers — the gasless
 * order book's fork-side plumbing, shared conventions with lib/desk.ts.
 *
 *  - `fundVaultFreeBalance` gives a maker the vault FREE balance a
 *    vault-backed signed offer commits (nothing escrows at signing —
 *    the fill pulls the maker leg from vault free balance, so without
 *    this every fill reverts `SignedOfferInsufficientFreeBalance`).
 *  - `fetchSignedBook` reads the stub's market-scoped signed book
 *    (the same GET the app's `useDeskSignedBook` consumes).
 *  - `signedOrderHashOnChain` asks the DIAMOND for the order hash of a
 *    wire order — the cross-check that the stub/app hashing agrees
 *    with `LibSignedOffer.hashStruct` byte-for-byte.
 */
import { encodeFunctionData } from 'viem';
import { anvilRpc, setBalance } from './anvil';
import {
  DIAMOND,
  DIAMOND_ABI_VIEM,
  ERC20_MIN_ABI,
  forkChain,
  pub,
  walletFor,
} from './chain';
import { accountFor, type Role } from './wallets';

const STUB_ORIGIN = `http://127.0.0.1:${Number(process.env.ALPHA02_E2E_STUB_PORT ?? 8788)}`;

/** The 28-field wire order as the book serves it (mirror of the app's
 *  `SignedOrderWire` — decimal-string uints, lowercase addresses). */
export interface WireOrder {
  offerType: string;
  lendingAsset: string;
  amount: string;
  amountMax: string;
  interestRateBps: string;
  interestRateBpsMax: string;
  collateralAsset: string;
  collateralAmount: string;
  collateralAmountMax: string;
  durationDays: string;
  assetType: string;
  collateralAssetType: string;
  tokenId: string;
  quantity: string;
  collateralTokenId: string;
  collateralQuantity: string;
  prepayAsset: string;
  allowsPartialRepay: boolean;
  allowsPrepayListing: boolean;
  allowsParallelSale: boolean;
  expiresAt: string;
  fillMode: string;
  periodicInterestCadence: string;
  refinanceTargetLoanId: string;
  useFullTermInterest: boolean;
  signer: string;
  nonce: string;
  deadline: string;
}

export interface SignedBookRow {
  orderHash: `0x${string}`;
  signer: string;
  order: WireOrder;
  signature: string;
  status: string;
  filledAmount: string;
  expiresAt: number;
  deadline: number;
}

/** The stub's market-scoped signed book for WETH-side `lend` /
 *  `coll` at `days` — the exact route the app reads. */
export async function fetchSignedBook(
  lend: string,
  coll: string,
  days: number,
): Promise<SignedBookRow[]> {
  const params = new URLSearchParams({
    chainId: '84532',
    lendingAsset: lend.toLowerCase(),
    collateralAsset: coll.toLowerCase(),
    durationDays: String(days),
  });
  const res = await fetch(`${STUB_ORIGIN}/signed-offers?${params}`);
  if (res.status !== 200) {
    throw new Error(`stub GET /signed-offers answered ${res.status}`);
  }
  const body = (await res.json()) as { chainId: number; offers: SignedBookRow[] };
  if (body.chainId !== 84532) {
    throw new Error(`stub signed book carried chainId ${body.chainId}`);
  }
  return body.offers;
}

/** Wire order → the bigint-typed tuple the Diamond's SignedOffer ABI
 *  expects (mirror of the app's `signedOfferTypedMessage`). */
export function wireToTyped(o: WireOrder) {
  return {
    offerType: Number(o.offerType),
    lendingAsset: o.lendingAsset as `0x${string}`,
    amount: BigInt(o.amount),
    amountMax: BigInt(o.amountMax),
    interestRateBps: BigInt(o.interestRateBps),
    interestRateBpsMax: BigInt(o.interestRateBpsMax),
    collateralAsset: o.collateralAsset as `0x${string}`,
    collateralAmount: BigInt(o.collateralAmount),
    collateralAmountMax: BigInt(o.collateralAmountMax),
    durationDays: BigInt(o.durationDays),
    assetType: Number(o.assetType),
    collateralAssetType: Number(o.collateralAssetType),
    tokenId: BigInt(o.tokenId),
    quantity: BigInt(o.quantity),
    collateralTokenId: BigInt(o.collateralTokenId),
    collateralQuantity: BigInt(o.collateralQuantity),
    prepayAsset: o.prepayAsset as `0x${string}`,
    allowsPartialRepay: o.allowsPartialRepay,
    allowsPrepayListing: o.allowsPrepayListing,
    allowsParallelSale: o.allowsParallelSale,
    expiresAt: BigInt(o.expiresAt),
    fillMode: Number(o.fillMode),
    periodicInterestCadence: Number(o.periodicInterestCadence),
    refinanceTargetLoanId: BigInt(o.refinanceTargetLoanId),
    useFullTermInterest: o.useFullTermInterest,
    signer: o.signer as `0x${string}`,
    nonce: BigInt(o.nonce),
    deadline: BigInt(o.deadline),
  };
}

/** `SignedOfferFacet.signedOfferOrderHash(order)` — the CONTRACT's own
 *  hash of the wire order, for pinning the stub/app hash against the
 *  on-chain source of truth. */
export async function signedOrderHashOnChain(order: WireOrder): Promise<`0x${string}`> {
  return (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'signedOfferOrderHash',
    args: [wireToTyped(order)],
  })) as `0x${string}`;
}

/** On-chain cumulative fill for an order hash (non-zero ⇒ consumed /
 *  cancelled in v0.5). */
export async function signedFilledAmount(orderHash: `0x${string}`): Promise<bigint> {
  return (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'signedOfferFilledAmount',
    args: [orderHash],
  })) as bigint;
}

/**
 * Give `role` a vault FREE balance of `amount` of `token` — the
 * direct-transfer + counter-record pattern the contracts test suite
 * uses (`SetupTest._fundActorVault`): move the tokens to the user's
 * vault proxy, then tick `recordVaultDepositERC20` AS the Diamond
 * (the counter setter is `onlyDiamondInternal`; on the fork we
 * impersonate the Diamond address via anvil — the e2e analogue of the
 * unit suite's `vm.prank(address(diamond))`). No user-facing deposit
 * entry exists for plain assets: production free balance arises from
 * protocol flows (refunds, repayments), which is exactly why the
 * gasless ticket only WARNS on a shortfall.
 */
export async function fundVaultFreeBalance(
  role: Role,
  token: `0x${string}`,
  amount: bigint,
): Promise<void> {
  const account = accountFor(role);
  const wallet = walletFor(account);

  // Ensure the vault proxy exists (idempotent), then resolve it.
  const createHash = await wallet.writeContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getOrCreateUserVault',
    args: [account.address],
    account,
    chain: forkChain,
  });
  await pub.waitForTransactionReceipt({ hash: createHash });
  const proxy = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getUserVaultAddress',
    args: [account.address],
  })) as `0x${string}`;

  // Real tokens into the proxy (the fill later disburses them).
  const transferHash = await wallet.writeContract({
    address: token,
    abi: ERC20_MIN_ABI,
    functionName: 'transfer',
    args: [proxy, amount],
    account,
    chain: forkChain,
  });
  await pub.waitForTransactionReceipt({ hash: transferHash });

  // Tick the protocol-tracked counter as the Diamond (msg.sender ==
  // address(this) satisfies onlyDiamondInternal).
  await anvilRpc('anvil_impersonateAccount', [DIAMOND]);
  await setBalance(DIAMOND, 10n ** 18n); // gas for the impersonated tx
  const data = encodeFunctionData({
    abi: DIAMOND_ABI_VIEM,
    functionName: 'recordVaultDepositERC20',
    args: [account.address, token, amount],
  });
  const recordHash = await anvilRpc<`0x${string}`>('eth_sendTransaction', [
    { from: DIAMOND, to: DIAMOND, data, gas: '0x2dc6c0' },
  ]);
  await pub.waitForTransactionReceipt({ hash: recordHash });
  await anvilRpc('anvil_stopImpersonatingAccount', [DIAMOND]);
}
