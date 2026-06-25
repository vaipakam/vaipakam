import { useCallback } from 'react';
import { useWallet } from '../context/WalletContext';
import { useWalletClient } from 'wagmi';
import { keccak256, encodeAbiParameters } from 'viem';
import type { Address, Hex } from 'viem';
import { useDiamondPublicClient, useReadChain } from '../contracts/useDiamond';
import { DIAMOND_ABI_VIEM as DIAMOND_ABI } from '@vaipakam/contracts/abis';
import { DEFAULT_CHAIN } from '../contracts/config';

/**
 * #662 — client-side `AcceptTerms` EIP-712 builder + signer (anti-phishing
 * accept-term binding). The on-chain accept entries now require the acceptor to
 * sign a typed `AcceptTerms` that binds EVERY loan-affecting offer field; the
 * contract refuses any accept whose signed terms don't match the stored offer
 * (`OfferTermsMismatch`) — so this hook is mandatory for `acceptOffer` /
 * `acceptOfferWithPermit` / `acceptSignedOffer*`.
 *
 * Mirrors `usePermit2Signing`: returns a `sign({ offerId, consent })` the accept
 * page calls; it reads the canonical offer from chain (so the terms match the
 * contract field-for-field, exactly like the Solidity `LibAcceptTestSigner.
 * buildTerms` reference), asks the wallet to sign the typed message against the
 * acceptance-specific `"Vaipakam AcceptOffer"` domain, and returns
 * `{ terms, signature }` ready to forward to the entry point.
 *
 * The single risk-and-terms consent checkbox is unchanged — `consent` is folded
 * INTO the signed terms, not surfaced as a second checkbox (design §8b).
 */

const ACCEPT_DEADLINE_SECONDS = 30 * 60; // 30 minutes, matching the Permit2 window.

// EIP-712 type for `AcceptTerms`. Field ORDER + types MUST match
// `LibAcceptTerms.ACCEPT_TERMS_TYPEHASH` exactly (enums encoded as `uint8`), or
// the recovered signature won't match on-chain.
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
    // #730 — the risk-terms version this acknowledgement is bound to. The gate's
    // #662⇄#671 illiquid ack-substitution requires it to be fresh, so a
    // governance terms bump re-locks any ack signed against an older version.
    { name: 'riskTermsVersion', type: 'uint256' },
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
  riskTermsVersion: bigint;
}

export interface AcceptTermsPayload {
  terms: AcceptTerms;
  signature: Hex;
}

export interface AcceptTermsSignInput {
  offerId: bigint;
  /** The single mandatory risk-and-terms consent (the §233 checkbox). */
  consent: boolean;
}

const ASSET_TYPE_ERC20 = 0; // LibVaipakam.AssetType.ERC20
const OFFER_TYPE_LENDER = 0; // LibVaipakam.OfferType.Lender

export function useAcceptTermsSigning() {
  const { address, chainId } = useWallet();
  const { data: walletClient } = useWalletClient();
  const publicClient = useDiamondPublicClient();
  const activeReadChain = useReadChain();

  const sign = useCallback(
    async (input: AcceptTermsSignInput): Promise<AcceptTermsPayload> => {
      if (!address || !chainId) throw new Error('Wallet not connected');
      if (!walletClient) throw new Error('Wallet client not available');
      if (!publicClient) throw new Error('Public client not available');

      const diamondAddr = (activeReadChain.diamondAddress ??
        DEFAULT_CHAIN.diamondAddress) as Address;

      // Read the canonical offer so the signed terms match the stored offer
      // field-for-field (avoids `OfferTermsMismatch`); same source the contract
      // binds against.
      const o = (await publicClient.readContract({
        address: diamondAddr,
        abi: DIAMOND_ABI,
        functionName: 'getOffer',
        args: [input.offerId],
      })) as Record<string, unknown>;

      // #725 — the auto-linked sale/offset target loan id. The contract binds
      // `linkedLoanId == saleOfferToLoanId[offerId]` (else offsetOfferToLoanId);
      // 0 for a normal offer. Read it from chain so a lender-sale-vehicle /
      // preclose-offset offer signs the right value (else `OfferTermsMismatch`).
      const linkedLoanId = (await publicClient.readContract({
        address: diamondAddr,
        abi: DIAMOND_ABI,
        functionName: 'getOfferLinkedLoanId',
        args: [input.offerId],
      })) as bigint;

      // #730 — stamp the live risk-terms version so the gate's #662⇄#671 illiquid
      // ack-substitution sees a FRESH acknowledgement. A Diamond predating
      // RiskAccessFacet has no such view (and no gate) — default to 0, which is a
      // fresh anchor there (`0 >= 0`).
      let riskTermsVersion = 0n;
      try {
        riskTermsVersion = (await publicClient.readContract({
          address: diamondAddr,
          abi: DIAMOND_ABI,
          functionName: 'getCurrentRiskTermsVersion',
        })) as bigint;
      } catch {
        riskTermsVersion = 0n;
      }

      const isERC20 = Number(o.assetType) === ASSET_TYPE_ERC20;
      const isLender = Number(o.offerType) === OFFER_TYPE_LENDER;
      // Role-correct endpoints — mirror `LoanFacet._bookLoanTerms` /
      // `OfferAcceptFacet._bindTermsToOffer`: ERC-20 lender ⇒ amountMax /
      // interestRateBps; ERC-20 borrower ⇒ amount / interestRateBpsMax; NFT ⇒
      // amount / interestRateBps for both.
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
        acceptor: address as Address,
        offerCreator: o.creator as Address,
        // Direct-accept offerKey is keccak256(abi.encode(offerId)) — computed
        // client-side (no on-chain view); matches `_directOfferKey`.
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
        // Always acknowledge BOTH legs' assets. The contract enforces the ack
        // only for a leg the LTV/HF bypass classifies illiquid (`ack == asset`);
        // a liquid leg's ack is never read. Acknowledging both is correct (the
        // user is consenting to possibly receiving either asset in-kind) AND
        // robust against a leg going illiquid between signing and execution —
        // there's no `ack == 0` requirement for liquid legs to violate.
        acknowledgedIlliquidLendingAsset: lendingAsset,
        acknowledgedIlliquidCollateralAsset: collateralAsset,
        nonce: randomNonce(),
        deadline:
          BigInt(Math.floor(Date.now() / 1000)) +
          BigInt(ACCEPT_DEADLINE_SECONDS),
        riskTermsVersion,
      };

      const signature = (await walletClient.signTypedData({
        account: address as Address,
        domain: {
          name: 'Vaipakam AcceptOffer',
          version: '1',
          chainId,
          verifyingContract: diamondAddr,
        },
        types: ACCEPT_TERMS_TYPES,
        primaryType: 'AcceptTerms',
        message: terms as never,
      })) as Hex;

      return { terms, signature };
    },
    [address, chainId, walletClient, publicClient, activeReadChain.diamondAddress],
  );

  const canSign = Boolean(walletClient) && Boolean(address);

  return { sign, canSign };
}

function randomNonce(): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}
