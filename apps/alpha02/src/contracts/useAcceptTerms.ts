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
import {
  signedOrderHash,
  signedOrderTimeWindowsOpen,
  type SignedOrderWire,
} from '../lib/signedOffer';
import { isAssetIlliquidLive, isMissingSelectorError } from './preflights';

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
    // #1347 — the acceptor's per-party Full VPFI fee-entitlement tariff opt-in.
    // MUST stay last, matching the append to `LibAcceptTerms.ACCEPT_TERMS_TYPEHASH`.
    // Defaulted off here (non-Full); the Full-tariff accept UI ships in PR-8 (#1355).
    { name: 'acceptorFull', type: 'bool' },
    { name: 'acceptorMaxCStar', type: 'uint256' },
    { name: 'acceptorAllowFullDowngrade', type: 'bool' },
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
  // #1347 — acceptor's Full VPFI tariff opt-in (defaulted off until PR-8).
  acceptorFull: boolean;
  acceptorMaxCStar: bigint;
  acceptorAllowFullDowngrade: boolean;
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
        /** The interest MODE the review's copy described (full-term
         *  floor vs pro-rata). It changes what an early repayment
         *  costs, so a stale indexer flag must abort BEFORE the
         *  wallet prompt like any other reviewed term. */
        useFullTermInterest?: boolean;
        /** True when the review DISCLOSED the in-kind (illiquid)
         *  default path. Anything else (false OR omitted) makes the
         *  signer re-read liquidity live and abort on an illiquid leg
         *  — omission is the safe side, never a silent skip. */
        illiquidWarned?: boolean;
      };
    }): Promise<AcceptTermsPayload> => {
      if (!address || !walletChain) {
        throw new Error(copy.errors.walletConnectFirst);
      }
      if (!walletClient) throw new Error(copy.errors.walletClientUnavailable);
      if (!publicClient) throw new Error(copy.errors.noRpcClient);

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

      // #729/#735 — the risk-access gate can reject the accept ON-CHAIN
      // after every client check passed: acceptor tier too low, an
      // illiquid pair needing a STANDING per-pair consent this app has
      // no surface to collect (the canonical case: an NFT rental whose
      // prepay token is illiquid — the gate keys the rental's lend leg
      // off `prepayAsset`, while the #662 ack signed here names the
      // rented NFT, so the ack can never cover it), or a strict-mode
      // mid-tier ack. Preview the gate non-reverting BEFORE any
      // signature or approval. 0 = clear, 4 = soft (THIS signature's
      // own ack clears it at accept time) — anything else is a hard
      // block the accept would revert on. A missing selector means an
      // older deploy without the preview — proceed, the contract still
      // enforces; a transport failure fails CLOSED (retrying is free,
      // a wasted approval is not).
      try {
        const gateBlock = (await publicClient.readContract({
          address: diamondAddr,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'previewOfferAcceptBlock',
          args: [input.offerId, address],
        })) as number | bigint;
        if (Number(gateBlock) !== 0 && Number(gateBlock) !== 4) {
          throw new Error(copy.match.riskGateBlocked);
        }
      } catch (e) {
        if (e instanceof Error && e.message === copy.match.riskGateBlocked) {
          throw e;
        }
        if (!isMissingSelectorError(e)) throw e;
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

      // #986 P3 — a SALE-VEHICLE offer binds against the LINKED LOAN's
      // LIVE fields, not the stored offer's. Mirrors
      // `OfferAcceptFacet._verifyAndBindAccept`: amount must equal
      // `saleLoan.principal`, durationDays must equal the loan's
      // original `durationDays`, and collateralAmount is a `<=`-floor
      // against `saleLoan.collateralAmount` (bind the live value so a
      // collateral reduction between review and accept aborts, while a
      // harmless top-up still passes). Building these from the offer
      // would OfferTermsMismatch the moment the loan moved (e.g. a
      // partial repay after listing). A sale link is discriminated
      // from a preclose-offset link by the creator: sale vehicles are
      // created by the loan's LENDER, offsets by its borrower — offset
      // offers keep the plain offer-field binding (the contract's
      // else-branch).
      let saleLoan: {
        principal: bigint;
        durationDays: bigint;
        collateralAmount: bigint;
      } | null = null;
      if (linkedLoanId !== 0n) {
        const loan = (await publicClient.readContract({
          address: diamondAddr,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getLoanDetails',
          args: [linkedLoanId],
        })) as Record<string, unknown>;
        if ((loan.lender as string).toLowerCase() === creator) {
          // The completion requires the loan Active — a settled/defaulted
          // loan's listing can never complete, so fail before any
          // signature like the other doomed-accept guards.
          if (Number(loan.status) !== 0) {
            throw new Error(copy.match.offerGone);
          }
          saleLoan = {
            principal: loan.principal as bigint,
            durationDays: loan.durationDays as bigint,
            collateralAmount: loan.collateralAmount as bigint,
          };
        }
      }

      // #730 — stamp the live risk-terms HASH (fail-closed helper below,
      // shared with the signed-offer accept signer).
      const riskTermsHash = await readRiskTermsHashFailClosed(
        publicClient,
        diamondAddr,
      );

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
        amount: saleLoan ? saleLoan.principal : roleAmount,
        collateralAmount: saleLoan
          ? saleLoan.collateralAmount
          : (o.collateralAmount as bigint),
        interestRateBps: roleRate,
        durationDays: saleLoan ? saleLoan.durationDays : (o.durationDays as bigint),
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
        // #1347 — non-Full accept (Full-tariff opt-in UI ships in PR-8 #1355).
        acceptorFull: false,
        acceptorMaxCStar: 0n,
        acceptorAllowFullDowngrade: false,
      };

      // The signed terms acknowledge BOTH assets as potentially
      // illiquid — but the acknowledgement is only meaningful consent
      // if the review disclosed the in-kind default path. Unless the
      // caller POSITIVELY says the review warned (illiquidWarned:
      // true), re-read liquidity live and abort before signing if a
      // leg is illiquid — the re-review then shows the warning. The
      // default is the SAFE side on purpose: a future caller that
      // forgets the flag gets a loud abort on illiquid pairs, never a
      // silently skipped disclosure. Reads fail CLOSED — an unknown
      // must not sign as "liquid".
      // Note: gated on the FLAG only, not on `expected` being present
      // — a caller that omits expected entirely still gets the loud
      // abort on an illiquid pair, never a silent skip.
      if (input.expected?.illiquidWarned !== true) {
        const [lendingIlliquid, collateralIlliquid] = await Promise.all([
          isAssetIlliquidLive({
            publicClient,
            diamondAddress: diamondAddr,
            asset: lendingAsset,
            failClosed: true,
          }),
          isAssetIlliquidLive({
            publicClient,
            diamondAddress: diamondAddr,
            asset: collateralAsset,
            failClosed: true,
          }),
        ]);
        if (lendingIlliquid || collateralIlliquid) {
          throw new Error(copy.match.termsChanged);
        }
      }

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
          (e.assetType !== undefined && e.assetType !== terms.assetType) ||
          (e.useFullTermInterest !== undefined &&
            e.useFullTermInterest !== terms.useFullTermInterest);
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

/** #730 — read the live risk-terms HASH. FAIL CLOSED: only a Diamond
 *  with RiskAccessFacet entirely absent may sign the zero hash; a
 *  transient RPC failure or a partial-#730 deploy must throw instead
 *  of silently signing a rejectable ack. Shared by the direct-accept
 *  and signed-offer accept signers. */
async function readRiskTermsHashFailClosed(
  publicClient: NonNullable<ReturnType<typeof usePublicClient>>,
  diamondAddr: Address,
): Promise<Hex> {
  try {
    return (await publicClient.readContract({
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
    return ZERO_HASH;
  }
}

/**
 * #1131 slice D — `AcceptTerms` builder + signer for filling a GASLESS
 * signed offer (`SignedOfferFacet.acceptSignedOffer`). Same anti-
 * phishing contract as {@link useAcceptTermsSigning}, adapted to the
 * one structural difference: the offer doesn't exist on-chain at sign
 * time, so the terms are built from the SIGNED ORDER itself and
 * `offerKey` binds the signed-offer ORDER HASH (the value
 * `verifyAndBindAccept` receives on the fill path) instead of
 * `keccak256(abi.encode(offerId))`.
 *
 * The order hash is RECOMPUTED LOCALLY from the order fields — the
 * indexer row's `orderHash` is never trusted for signing, so a stale or
 * hostile book cache can't bind the taker to terms that differ from
 * what is displayed (the displayed terms come from the same `order`
 * object being hashed).
 *
 * Field binding mirrors the materialize path exactly:
 * `LibSignedOffer.toCreateOfferParams` copies every order field
 * verbatim into the stored offer, so `_bindTermsToOffer`'s role-correct
 * endpoints resolve against the order's own values (ERC-20 lender ⇒
 * `amountMax` / `interestRateBps`; ERC-20 borrower ⇒ `amount` /
 * `interestRateBpsMax`). A freshly-materialized offer can never carry a
 * sale/offset link, so `linkedLoanId = 0` and `parallelSaleOrderHash`
 * is the storage-default zero hash.
 */
export function useSignedOfferAcceptTermsSigning() {
  const { address, walletChain } = useActiveChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });

  const sign = useCallback(
    async (input: {
      order: SignedOrderWire;
      /** The single mandatory risk-and-terms consent checkbox. */
      consent: boolean;
    }): Promise<{ payload: AcceptTermsPayload; orderHash: Hex }> => {
      if (!address || !walletChain) {
        throw new Error(copy.errors.walletConnectFirst);
      }
      if (!walletClient) throw new Error(copy.errors.walletClientUnavailable);
      if (!publicClient) throw new Error(copy.errors.noRpcClient);

      const diamondAddr = walletChain.diamondAddress;
      const o = input.order;
      const orderHash = signedOrderHash(o);

      // Refuse DOOMED fills before any signature or approval — the
      // signed-offer analogue of the direct path's staleness guards:
      // the on-chain fill ledger (non-zero ⇒ filled OR cancelled), the
      // signer's batch-invalidated nonce, and both time windows judged
      // on CHAIN time (what `_vetSignedOffer` judges on), never the
      // device clock.
      const [latestBlock, filled, nonceUsed] = await Promise.all([
        publicClient.getBlock({ blockTag: 'latest' }),
        publicClient.readContract({
          address: diamondAddr,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'signedOfferFilledAmount',
          args: [orderHash],
        }) as Promise<bigint>,
        publicClient.readContract({
          address: diamondAddr,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'isSignedOfferNonceUsed',
          args: [o.signer as Address, BigInt(o.nonce)],
        }) as Promise<boolean>,
      ]);
      const chainNow = latestBlock.timestamp;
      if (filled !== 0n || nonceUsed) {
        throw new Error(copy.desk.signed.gone);
      }
      // Codex #1145 round-3 P2 — both windows judged with the shared
      // 60 s submit margin (`signedOrderTimeWindowsOpen`), not a bare
      // `chainNow > t` compare: the fill MATERIALIZES through
      // `createOffer`, whose `expiresAt <= block.timestamp` boundary
      // treats equality as expired, and wallet prompts + a possible
      // approval transaction sit between this read and the write
      // landing — an at-or-near-expiry order must fail HERE, before
      // the taker signs or approves anything.
      if (!signedOrderTimeWindowsOpen(o, chainNow)) {
        throw new Error(copy.desk.signed.gone);
      }

      // The compact fill confirm has NO surface for the in-kind
      // (illiquid) default disclosure — re-read liquidity live and
      // abort on an illiquid leg, exactly the safe-side default the
      // direct signer applies when the review didn't warn. Reads fail
      // CLOSED — an unknown must not sign as "liquid".
      const [lendingIlliquid, collateralIlliquid] = await Promise.all([
        isAssetIlliquidLive({
          publicClient,
          diamondAddress: diamondAddr,
          asset: o.lendingAsset as Address,
          failClosed: true,
        }),
        isAssetIlliquidLive({
          publicClient,
          diamondAddress: diamondAddr,
          asset: o.collateralAsset as Address,
          failClosed: true,
        }),
      ]);
      if (lendingIlliquid || collateralIlliquid) {
        throw new Error(copy.desk.signed.illiquid);
      }

      const riskTermsHash = await readRiskTermsHashFailClosed(
        publicClient,
        diamondAddr,
      );

      // Role-correct endpoints against the offer AS MATERIALIZED
      // (toCreateOfferParams copies the order verbatim) — mirrors
      // `_bindTermsToOffer` / the direct signer's mapping.
      const isERC20 = Number(o.assetType) === ASSET_TYPE_ERC20;
      const isLender = Number(o.offerType) === OFFER_TYPE_LENDER;
      const roleAmount = isERC20
        ? isLender
          ? BigInt(o.amountMax)
          : BigInt(o.amount)
        : BigInt(o.amount);
      const roleRate = isERC20
        ? isLender
          ? BigInt(o.interestRateBps)
          : BigInt(o.interestRateBpsMax)
        : BigInt(o.interestRateBps);

      const lendingAsset = o.lendingAsset as Address;
      const collateralAsset = o.collateralAsset as Address;

      const terms: AcceptTerms = {
        acceptor: address,
        offerCreator: o.signer as Address,
        // Signed-offer fills bind the ORDER HASH (no offerId existed at
        // sign time) — SignedOfferFacet passes it to verifyAndBindAccept.
        offerKey: orderHash,
        offerType: Number(o.offerType),
        lendingAsset,
        collateralAsset,
        amount: roleAmount,
        collateralAmount: BigInt(o.collateralAmount),
        interestRateBps: roleRate,
        durationDays: BigInt(o.durationDays),
        tokenId: BigInt(o.tokenId),
        collateralTokenId: BigInt(o.collateralTokenId),
        quantity: BigInt(o.quantity),
        collateralQuantity: BigInt(o.collateralQuantity),
        assetType: Number(o.assetType),
        collateralAssetType: Number(o.collateralAssetType),
        prepayAsset: o.prepayAsset as Address,
        useFullTermInterest: o.useFullTermInterest,
        allowsPartialRepay: o.allowsPartialRepay,
        allowsPrepayListing: o.allowsPrepayListing,
        allowsParallelSale: o.allowsParallelSale,
        refinanceTargetLoanId: BigInt(o.refinanceTargetLoanId),
        // A just-materialized offer can carry no sale/offset link.
        linkedLoanId: 0n,
        parallelSaleOrderHash: ZERO_HASH,
        periodicInterestCadence: Number(o.periodicInterestCadence),
        riskAndTermsConsent: input.consent,
        // Acknowledge BOTH legs — same rationale as the direct signer
        // (the contract reads the ack only for a leg it classifies
        // illiquid; both-acked is robust against a mid-flight flip).
        acknowledgedIlliquidLendingAsset: lendingAsset,
        acknowledgedIlliquidCollateralAsset: collateralAsset,
        nonce: randomNonce(),
        deadline: chainNow + BigInt(ACCEPT_DEADLINE_SECONDS),
        riskTermsHash,
        // #1347 — non-Full accept (Full-tariff opt-in UI ships in PR-8 #1355).
        acceptorFull: false,
        acceptorMaxCStar: 0n,
        acceptorAllowFullDowngrade: false,
      };

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

      return { payload: { terms, signature }, orderHash };
    },
    [address, walletChain, walletClient, publicClient],
  );

  return { sign };
}

function randomNonce(): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}
