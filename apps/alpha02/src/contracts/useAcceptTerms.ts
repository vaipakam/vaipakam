/**
 * `AcceptTerms` EIP-712 builder + signer — PORTED from
 * apps/defi/src/hooks/useAcceptTermsSigning.ts (#662/#725/#730; only
 * the wallet/chain plumbing changed). Every accept entry point
 * requires the acceptor to sign typed terms binding EVERY
 * loan-affecting offer field; the contract refuses an accept whose
 * signed terms don't match the stored offer (`OfferTermsMismatch`).
 *
 * Terms are built from the CANONICAL on-chain offer (`getOffer`), not
 * from any indexer row — a stale cache can therefore never make the
 * user sign wrong terms. The single risk-and-terms consent checkbox
 * is folded INTO the signed terms (no second checkbox).
 *
 * The risk-terms hash read FAILS CLOSED (see inline comments) — do
 * not soften that behaviour; a zero-hash ack on a gated Diamond
 * wastes the user's gas.
 */
import { useCallback } from 'react';
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  encodeAbiParameters,
  keccak256,
} from 'viem';
import type { Address, Hex } from 'viem';
import { usePublicClient, useWalletClient } from 'wagmi';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { useActiveChain } from '../chain/useActiveChain';
import { copy } from '../content/copy';

const ACCEPT_DEADLINE_SECONDS = 30 * 60; // 30 minutes, matching the Permit2 window.

// EIP-712 type for `AcceptTerms`. Field ORDER + types MUST match
// `LibAcceptTerms.ACCEPT_TERMS_TYPEHASH` exactly (enums encoded as
// `uint8`), or the recovered signature won't match on-chain.
const ACCEPT_TERMS_TYPES = {
  AcceptTerms: [
    { name: 'acceptor', type: 'address' },
    { name: 'offerCreator', type: 'address' },
    { name: 'offerKey', type: 'bytes32' },
    { name: 'offerType', type: 'uint8' },
    { name: 'lendingAsset', type: 'address' },
    { name: 'collateralAsset', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'collateralAmount', type: 'uint256' },
    { name: 'interestRateBps', type: 'uint256' },
    { name: 'durationDays', type: 'uint256' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'collateralTokenId', type: 'uint256' },
    { name: 'quantity', type: 'uint256' },
    { name: 'collateralQuantity', type: 'uint256' },
    { name: 'assetType', type: 'uint8' },
    { name: 'collateralAssetType', type: 'uint8' },
    { name: 'prepayAsset', type: 'address' },
    { name: 'useFullTermInterest', type: 'bool' },
    { name: 'allowsPartialRepay', type: 'bool' },
    { name: 'allowsPrepayListing', type: 'bool' },
    { name: 'allowsParallelSale', type: 'bool' },
    { name: 'refinanceTargetLoanId', type: 'uint256' },
    { name: 'linkedLoanId', type: 'uint256' },
    { name: 'parallelSaleOrderHash', type: 'bytes32' },
    { name: 'periodicInterestCadence', type: 'uint8' },
    { name: 'riskAndTermsConsent', type: 'bool' },
    { name: 'acknowledgedIlliquidLendingAsset', type: 'address' },
    { name: 'acknowledgedIlliquidCollateralAsset', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    // #730 — the live risk-terms HASH this acknowledgement is bound to.
    { name: 'riskTermsHash', type: 'bytes32' },
  ],
} as const;

export interface AcceptTerms {
  acceptor: Address;
  offerCreator: Address;
  offerKey: Hex;
  offerType: number;
  lendingAsset: Address;
  collateralAsset: Address;
  amount: bigint;
  collateralAmount: bigint;
  interestRateBps: bigint;
  durationDays: bigint;
  tokenId: bigint;
  collateralTokenId: bigint;
  quantity: bigint;
  collateralQuantity: bigint;
  assetType: number;
  collateralAssetType: number;
  prepayAsset: Address;
  useFullTermInterest: boolean;
  allowsPartialRepay: boolean;
  allowsPrepayListing: boolean;
  allowsParallelSale: boolean;
  refinanceTargetLoanId: bigint;
  linkedLoanId: bigint;
  parallelSaleOrderHash: Hex;
  periodicInterestCadence: number;
  riskAndTermsConsent: boolean;
  acknowledgedIlliquidLendingAsset: Address;
  acknowledgedIlliquidCollateralAsset: Address;
  nonce: bigint;
  deadline: bigint;
  riskTermsHash: Hex;
}

export interface AcceptTermsPayload {
  terms: AcceptTerms;
  signature: Hex;
}

const ASSET_TYPE_ERC20 = 0; // LibVaipakam.AssetType.ERC20
const OFFER_TYPE_LENDER = 0; // LibVaipakam.OfferType.Lender
const ZERO_HASH =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex;

export function useAcceptTermsSigning() {
  const { address, walletChain } = useActiveChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });

  const sign = useCallback(
    async (input: {
      offerId: bigint;
      /** The single mandatory risk-and-terms consent checkbox. */
      consent: boolean;
      /** The terms the user REVIEWED (from the indexer row). Compared
       *  against the canonical terms BEFORE the wallet is asked to
       *  sign — the signature is the acknowledgement, so the user must
       *  never sign terms that differ from what they reviewed, even if
       *  the transaction would be aborted afterwards. Only provided
       *  fields are compared. */
      expected?: {
        lendingAsset?: string;
        collateralAsset?: string;
        amount?: bigint;
        interestRateBps?: bigint;
        collateralAmount?: bigint;
        durationDays?: number;
        tokenId?: bigint;
        prepayAsset?: string;
        quantity?: bigint;
        assetType?: number;
      };
    }): Promise<AcceptTermsPayload> => {
      if (!address || !walletChain) {
        throw new Error('Connect a wallet on a supported network first.');
      }
      if (!walletClient) throw new Error('Wallet client not available');
      if (!publicClient) throw new Error('No RPC client for the active chain.');

      const diamondAddr = walletChain.diamondAddress;

      // Read the canonical offer so the signed terms match the stored
      // offer field-for-field (avoids `OfferTermsMismatch`), plus the
      // CHAIN clock — expiry and the signature deadline are judged by
      // block.timestamp on-chain, so a skewed local clock must not
      // decide either.
      const [o, latestBlock] = await Promise.all([
        publicClient.readContract({
          address: diamondAddr,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getOffer',
          args: [input.offerId],
        }) as Promise<Record<string, unknown>>,
        publicClient.getBlock({ blockTag: 'latest' }),
      ]);
      const chainNow = latestBlock.timestamp;

      // Refuse STALE accepts before any signature or approval: an
      // already-accepted, expired, or cancelled (storage-deleted →
      // zero creator) offer can return the same economic terms, so the
      // caller's reviewed-vs-signed comparison alone wouldn't catch it
      // and the user would mine an approval tx for a doomed accept.
      const creator = (o.creator as string).toLowerCase();
      if (creator === '0x0000000000000000000000000000000000000000') {
        throw new Error(copy.match.offerGone);
      }
      if (Boolean(o.accepted)) {
        throw new Error(copy.match.offerGone);
      }
      const expiresAt = o.expiresAt as bigint;
      if (expiresAt !== 0n && expiresAt <= chainNow) {
        throw new Error(copy.match.offerGone);
      }
      // A partially matched offer can only be consumed by the matcher
      // path — direct acceptOffer reverts OfferPartiallyFilled.
      if ((o.amountFilled as bigint) > 0n) {
        throw new Error(copy.match.offerGone);
      }
      // A Scenario-A parallel sale (markOfferConsumedBySale) is stamped
      // in a side mapping getOffer doesn't expose — the storage row
      // still reads open. But that terminal (like cancelOffer) BURNS
      // the offer's position NFT, so a dead ownerOf is the reliable
      // signal that acceptOffer would revert on the terminal bit.
      try {
        await publicClient.readContract({
          address: diamondAddr,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'ownerOf',
          args: [o.positionTokenId as bigint],
        });
      } catch (e) {
        const isRevert =
          e instanceof BaseError &&
          (e.walk((x) => x instanceof ContractFunctionRevertedError) !== null ||
            e.walk((x) => x instanceof ContractFunctionZeroDataError) !== null);
        if (isRevert) throw new Error(copy.match.offerGone);
        throw e; // transport failure — surface, don't guess
      }

      // #725 — auto-linked sale/offset target loan id; 0 for a normal
      // offer. Read from chain so a sale-vehicle / preclose-offset offer
      // signs the right value.
      const linkedLoanId = (await publicClient.readContract({
        address: diamondAddr,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'getOfferLinkedLoanId',
        args: [input.offerId],
      })) as bigint;

      // #730 — stamp the live risk-terms HASH. FAIL CLOSED: only a
      // Diamond with RiskAccessFacet entirely absent may sign the zero
      // hash; a transient RPC failure or a partial-#730 deploy must
      // throw instead of silently signing a rejectable ack.
      let riskTermsHash = ZERO_HASH;
      try {
        riskTermsHash = (await publicClient.readContract({
          address: diamondAddr,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getCurrentRiskTermsHash',
        })) as Hex;
      } catch (e) {
        if (!isMissingSelectorError(e)) throw e;
        // Getter absent — distinguish "no RiskAccessFacet at all" (zero
        // hash OK) from a partial upgrade (fail) by probing a stable
        // pre-#730 selector.
        let riskFacetPresent = true;
        try {
          await publicClient.readContract({
            address: diamondAddr,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'getCurrentRiskTermsVersion',
          });
        } catch (probe) {
          if (isMissingSelectorError(probe)) riskFacetPresent = false;
          else throw probe;
        }
        if (riskFacetPresent) {
          throw new Error(
            'RiskAccessFacet is deployed without getCurrentRiskTermsHash (#730 deploy skew) — refusing to sign with a zero risk-terms anchor.',
          );
        }
      }

      const isERC20 = Number(o.assetType) === ASSET_TYPE_ERC20;
      const isLender = Number(o.offerType) === OFFER_TYPE_LENDER;
      // Role-correct endpoints — mirror `OfferAcceptFacet._bindTermsToOffer`:
      // ERC-20 lender ⇒ amountMax / interestRateBps; ERC-20 borrower ⇒
      // amount / interestRateBpsMax; NFT ⇒ amount / interestRateBps.
      const roleAmount = isERC20
        ? isLender
          ? (o.amountMax as bigint)
          : (o.amount as bigint)
        : (o.amount as bigint);
      const roleRate = isERC20
        ? isLender
          ? (o.interestRateBps as bigint)
          : (o.interestRateBpsMax as bigint)
        : (o.interestRateBps as bigint);

      const lendingAsset = o.lendingAsset as Address;
      const collateralAsset = o.collateralAsset as Address;

      const terms: AcceptTerms = {
        acceptor: address,
        offerCreator: o.creator as Address,
        // Direct-accept offerKey is keccak256(abi.encode(offerId)).
        offerKey: keccak256(
          encodeAbiParameters([{ type: 'uint256' }], [input.offerId]),
        ),
        offerType: Number(o.offerType),
        lendingAsset,
        collateralAsset,
        amount: roleAmount,
        collateralAmount: o.collateralAmount as bigint,
        interestRateBps: roleRate,
        durationDays: o.durationDays as bigint,
        tokenId: o.tokenId as bigint,
        collateralTokenId: o.collateralTokenId as bigint,
        quantity: o.quantity as bigint,
        collateralQuantity: o.collateralQuantity as bigint,
        assetType: Number(o.assetType),
        collateralAssetType: Number(o.collateralAssetType),
        prepayAsset: o.prepayAsset as Address,
        useFullTermInterest: Boolean(o.useFullTermInterest),
        allowsPartialRepay: Boolean(o.allowsPartialRepay),
        allowsPrepayListing: Boolean(o.allowsPrepayListing),
        allowsParallelSale: Boolean(o.allowsParallelSale),
        refinanceTargetLoanId: o.refinanceTargetLoanId as bigint,
        linkedLoanId,
        parallelSaleOrderHash: o.parallelSaleOrderHash as Hex,
        periodicInterestCadence: Number(o.periodicInterestCadence),
        riskAndTermsConsent: input.consent,
        // Always acknowledge BOTH legs' assets — the contract reads the
        // ack only for a leg it classifies illiquid; acknowledging both
        // is correct consent AND robust against a leg going illiquid
        // between signing and execution.
        acknowledgedIlliquidLendingAsset: lendingAsset,
        acknowledgedIlliquidCollateralAsset: collateralAsset,
        nonce: randomNonce(),
        deadline: chainNow + BigInt(ACCEPT_DEADLINE_SECONDS),
        riskTermsHash,
      };

      // Reviewed-vs-canonical comparison happens BEFORE the wallet is
      // asked to sign — the signature IS the acknowledgement, so terms
      // the user never reviewed must never receive one.
      if (input.expected) {
        const e = input.expected;
        const mismatch =
          (e.lendingAsset !== undefined &&
            e.lendingAsset.toLowerCase() !== terms.lendingAsset.toLowerCase()) ||
          (e.collateralAsset !== undefined &&
            e.collateralAsset.toLowerCase() !== terms.collateralAsset.toLowerCase()) ||
          (e.amount !== undefined && e.amount !== terms.amount) ||
          (e.interestRateBps !== undefined && e.interestRateBps !== terms.interestRateBps) ||
          (e.collateralAmount !== undefined && e.collateralAmount !== terms.collateralAmount) ||
          (e.durationDays !== undefined && BigInt(e.durationDays) !== terms.durationDays) ||
          (e.tokenId !== undefined && e.tokenId !== terms.tokenId) ||
          (e.prepayAsset !== undefined &&
            e.prepayAsset.toLowerCase() !== terms.prepayAsset.toLowerCase()) ||
          (e.quantity !== undefined && e.quantity !== terms.quantity) ||
          (e.assetType !== undefined && e.assetType !== terms.assetType);
        if (mismatch) {
          throw new Error(copy.match.termsChanged);
        }
      }

      const signature = (await walletClient.signTypedData({
        account: address,
        domain: {
          name: 'Vaipakam AcceptOffer',
          version: '1',
          chainId: walletChain.chainId,
          verifyingContract: diamondAddr,
        },
        types: ACCEPT_TERMS_TYPES,
        primaryType: 'AcceptTerms',
        message: terms as never,
      })) as Hex;

      return { terms, signature };
    },
    [address, walletChain, walletClient, publicClient],
  );

  return { sign };
}

// True when a contract read failed because the Diamond doesn't cut the
// selector — as opposed to a transient RPC/ABI error. `0xa9ad62f8` is
// the Diamond's FunctionNotFound selector.
function isMissingSelectorError(e: unknown): boolean {
  const msg = String(
    (e as { data?: string; message?: string })?.data ??
      (e as Error)?.message ??
      '',
  );
  return /function does not exist|functionnotfound|0xa9ad62f8/i.test(msg);
}

function randomNonce(): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}
