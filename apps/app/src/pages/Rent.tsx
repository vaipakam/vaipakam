/**
 * NFT rental — journeys N1 (owner lists an NFT) and N2 (user rents
 * one), kept deliberately separate from debt lending: nothing here is
 * called a loan, there is no "repay", and the custody model (NFT
 * stays vaulted; renter gets temporary use rights only) is stated
 * before anything is signed.
 *
 * Money model (mirrors OfferFacet): the renter prepays
 * `dailyFee × days` plus a refundable buffer (live
 * `rentalBufferBps`); rentals settle prepaid fees, not APR interest,
 * so listings are created with a 0% rate.
 *
 * NOTE on units: the on-chain daily fee is RAW wei of the prepay
 * asset (`toCreateOfferPayload` does `BigInt(amount)` for NFT legs).
 * This page converts the human "10 USDC per day" input with the
 * payment asset's live decimals BEFORE building the payload —
 * apps/defi's form writes the typed number through unscaled, which
 * this page intentionally does NOT copy (candidate
 * _CodeVsDocsAudit entry).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CircleCheck, Images, KeyRound, LoaderCircle } from 'lucide-react';
import { usePublicClient, useWalletClient } from 'wagmi';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { encodeFunctionData, type Address } from 'viem';
import { copy } from '../content/copy';
import {
  disablePermit2ForSession,
  usePermit2Signing,
} from '../contracts/usePermit2Signing';
import { AmountPrecisionHint } from '../components/AmountPrecisionHint';
import { ConsentLabel } from '../components/ConsentLabel';
import { SelectMenu } from '../components/SelectMenu';
import { useActiveChain } from '../chain/useActiveChain';
import { getSupportedChain } from '../chain/chains';
import { DIAMOND_ABI_VIEM, useDiamondWrite } from '../contracts/diamond';
import { SimulationPreview } from '../components/SimulationPreview';
import type { TxSimInput } from '../contracts/useTxSimulation';
import { useAcceptTermsSigning } from '../contracts/useAcceptTerms';
import {
  lifecycleFromOffer,
  rentalNamesCollateral,
  type CollateralFields,
  type LifecycleTerms,
  type ReviewedAcceptTerms,
} from '../contracts/acceptReview';
import { LifecycleTermsList } from '../components/LifecycleTermsList';
import { ensureAllowance, isAddressLike, useTokenBalance, useTokenMeta } from '../contracts/erc20';
import {
  makeStepper,
  plannedApprovePrompts,
  readAllowance,
  useAllowanceForPlan,
  type SubmitProgress,
} from '../lib/submitProgress';
import { screenTargets, useTokenScreen } from '../contracts/acceptTokenScreen';
import { TokenScreenBanner } from '../components/TokenScreenBanner';
import { flowDisabled } from '../lib/killSwitch';
import { idleAware } from '../lib/idle';
import {
  ensureNftApproval,
  readNftOwnershipLive,
  useNftOwnership,
  useNftRentalSupport,
  readNftOperatorApproval,
  useNftOperatorApproval,
} from '../contracts/nft';
import { useActiveOffers, useOffer } from '../data/hooks';
import {
  readRentalBufferBps,
  totalRentalPrepay,
  useRentalBufferBps,
} from '../data/protocol';
import { useProtocolFees, readLiveProtocolFees } from '../data/fees';
import { readVpfiTokenLive, useVpfi } from '../data/vpfi';
import { assertWalletNotSanctionedLive } from '../data/sanctions';
import {
  assertAssetNotPausedLive,
  assertErc20BalanceLive,
} from '../contracts/preflights';
import type { IndexedOffer } from '../data/indexer';
import {
  OFFER_DURATION_BUCKETS_DAYS,
  initialOfferForm,
  toCreateOfferPayload,
  validateOfferForm,
  type OfferFormState,
} from '../lib/offerSchema';
import { AssetType } from '../lib/types';
import {
  exactUnitsOrNull,
  formatBpsAsPercent,
  formatDurationDays,
  formatTokenAmount,
  formatTokenAmountExact,
  shortAddress,
} from '../lib/format';
import { captureTxError } from '../lib/errors';
import { WindowedRowList } from '../lib/visibleWindow';
import { AssetPicker } from '../components/AssetPicker';
import { MarketFreshnessNote } from '../components/MarketFreshnessNote';
import { Checklist, allChecksPass, type CheckItem } from '../components/Checklist';
import { ReviewReceipt, type ReceiptData } from '../components/ReviewReceipt';
import { StepNav } from '../components/StepNav';
import { useEligibility } from '../components/useEligibility';
import { useReviewConsent } from '../hooks/useReviewConsent';
import { ConsentWithdrawnNote } from '../components/ConsentWithdrawnNote';

type Path = 'own' | 'want' | null;

// ---------------------------------------------------------------- N1
function ListNftFlow() {
  const { address, walletChain } = useActiveChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const { write } = useDiamondWrite();
  const queryClient = useQueryClient();
  const { bps: bufferBps } = useRentalBufferBps();
  const fees = useProtocolFees();

  const [step, setStep] = useState<'details' | 'review' | 'done'>('details');
  const [standard, setStandard] = useState<'erc721' | 'erc1155'>('erc721');
  const [contract, setContract] = useState('');
  const [tokenId, setTokenId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [prepayAsset, setPrepayAsset] = useState('');
  const [dailyFee, setDailyFee] = useState('');
  const [durationDays, setDurationDays] = useState('30');
  // #1037 — staged submit progress (busy derives from it).
  const [progress, setProgress] = useState<SubmitProgress | null>(null);
  const busy = progress !== null;
  const submitLockRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const prepayMeta = useTokenMeta(prepayAsset || undefined);
  // #1037 roadmap input: does the collection-wide operator approval
  // already stand? true → the listing is a single confirmation.
  const nftApproval = useNftOperatorApproval({
    chainId: walletChain?.chainId,
    contract: isAddressLike(contract) ? (contract as `0x${string}`) : undefined,
    owner: address as `0x${string}` | undefined,
    operator: walletChain?.diamondAddress,
  });
  const standardEnum =
    standard === 'erc721' ? AssetType.ERC721 : AssetType.ERC1155;
  const ownership = useNftOwnership(contract, standardEnum, tokenId, quantity);
  // ERC-4907 is a heads-up, not a gate: the vault rents non-4907 NFTs
  // via its own renter registry (VaipakamVaultImplementation.setUser
  // only forwards when the collection supports it) — same first-party
  // semantic every ERC-1155 rental uses. We warn the owner that
  // external apps won't see the renter, and let them list.
  const rentalSupport = useNftRentalSupport(contract, standardEnum);

  const dailyFeeWei = useMemo(() => {
    if (!prepayMeta.data) return null;
    // #2390 — exact: excess precision is refused, never rounded.
    const wei = exactUnitsOrNull(dailyFee, prepayMeta.data.decimals);
    return wei !== null && wei > 0n ? wei : null;
  }, [dailyFee, prepayMeta.data]);

  // Live createOffer duration cap (OfferDurationExceedsCap) — filter
  // the picker and refuse review when the selected length exceeds it.
  const durationOptions = OFFER_DURATION_BUCKETS_DAYS.filter(
    (d) => d <= fees.maxOfferDurationDays,
  );
  const durationValid = Number(durationDays) <= fees.maxOfferDurationDays;

  // Consent covers exactly what the review shows (#1696): every listed
  // term, the fee it is charged, the token it is paid in, the rental
  // support disclosure and the account signing. Keyed on the values and
  // cleared in the same render they change, so an edit or a background
  // refresh never leaves a tick from the earlier terms.
  const consent = useReviewConsent([
    standard,
    contract.toLowerCase(),
    tokenId,
    standard === 'erc1155' ? quantity : '1',
    prepayAsset.toLowerCase(),
    dailyFeeWei,
    durationDays,
    fees.treasuryFeeBps,
    prepayMeta.data?.symbol,
    prepayMeta.data?.decimals,
    rentalSupport.data,
    address,
    walletChain?.chainId,
  ]);

  const form = useMemo((): OfferFormState | null => {
    if (!dailyFeeWei || !isAddressLike(contract) || !/^\d+$/.test(tokenId)) return null;
    // '0' is truthy as a string — a zero-edition ERC-1155 listing must
    // not pass the client gates only to revert after the approval tx.
    if (standard === 'erc1155' && !(/^\d+$/.test(quantity) && Number(quantity) > 0)) {
      return null;
    }
    return {
      ...initialOfferForm,
      offerType: 'lender',
      assetType: standard,
      lendingAsset: contract,
      // RAW prepay-asset wei — see the units note in the file header.
      amount: dailyFeeWei.toString(),
      interestRate: '0', // rentals settle prepaid fees, not APR
      durationDays,
      tokenId,
      quantity: standard === 'erc1155' ? quantity || '1' : '1',
      prepayAsset,
      riskAndTermsConsent: consent.given,
    };
  }, [dailyFeeWei, contract, tokenId, standard, durationDays, quantity, prepayAsset, consent.given]);

  const detailsComplete = form !== null && durationValid;

  const baseChecks = useEligibility({ consent: consent.given });
  // The contract rejects VPFI as a rental prepay asset
  // (VpfiNotAllowedAsRentalPrepay) — catch it BEFORE the user pays for
  // setApprovalForAll on the NFT.
  const vpfi = useVpfi();
  // Until the VPFI-token read SUCCEEDS we can't rule the prepay asset
  // in or out — a transport error is NOT knowledge (treating it as
  // known would let a pasted VPFI token pass, spend setApprovalForAll,
  // then revert VpfiNotAllowedAsRentalPrepay). react-query keeps the
  // last good snapshot across refetch errors, so `data` present is
  // enough even when `isError` flickers.
  const vpfiKnown = vpfi.data !== undefined;
  const vpfiCheckFailed = vpfi.data === undefined && vpfi.isError;
  const prepayIsVpfi =
    Boolean(vpfi.data?.token) &&
    prepayAsset.toLowerCase() === vpfi.data!.token!.toLowerCase();
  const checks = useMemo((): CheckItem[] => {
    const extra: CheckItem[] = [
      {
        id: 'nft-ownership',
        label:
          ownership.data === false || ownership.data === null
            ? copy.rent.checkNotOwner
            : copy.rent.checkOwnNft,
        state:
          ownership.data === true
            ? 'pass'
            : ownership.data === undefined
              ? 'pending'
              : 'fail',
      },
      {
        id: 'prepay-token',
        label: prepayIsVpfi
          ? copy.rent.vpfiPrepayNotAllowed
          : vpfiCheckFailed
            ? copy.rent.paymentAssetCheckFailed
            : prepayMeta.isError
              ? copy.errors.notAToken
              : `${copy.rent.paymentAssetRecognised} (${prepayMeta.data?.symbol ?? '…'})`,
        state: prepayIsVpfi
          ? 'fail'
          : vpfiCheckFailed
            ? 'fail'
            : !vpfiKnown
              ? 'pending'
              : prepayMeta.isError
                ? 'fail'
                : prepayMeta.data
                  ? 'pass'
                  : 'pending',
      },
      {
        id: 'live-fees',
        label: fees.ready ? copy.rent.liveFeesLoaded : copy.rent.liveFeesLoading,
        state: fees.ready ? 'pass' : 'pending',
      },
    ];
    // wallet + network first, then the rental-specific facts, then consent.
    return [...baseChecks.slice(0, 2), ...extra, ...baseChecks.slice(2)];
  }, [baseChecks, ownership.data, prepayMeta.isError, prepayMeta.data, prepayIsVpfi, vpfiKnown, vpfiCheckFailed, fees.ready]);

  // #1028 item 2 — advisory pre-sign dry run of the exact listing
  // calldata. The submit approves the NFT operator first, so the
  // missing-approval revert at preview time is the benign case.
  const simTx = useMemo((): TxSimInput | null => {
    // Consent gate (round 1): same RiskAndTermsConsentRequired
    // cry-wolf guard as the other createOffer previews.
    if (!form || !walletChain || !form.riskAndTermsConsent) return null;
    try {
      return {
        to: walletChain.diamondAddress,
        data: encodeFunctionData({
          abi: DIAMOND_ABI_VIEM,
          functionName: 'createOffer',
          args: [toCreateOfferPayload(form, {})],
        }),
        value: 0n,
        allowNftApprovalRevert: true,
      };
    } catch {
      return null;
    }
  }, [form, walletChain]);

  const receipt = useMemo((): ReceiptData | null => {
    if (!form || !dailyFeeWei || !prepayMeta.data) return null;
    const days = Number(durationDays);
    const totalFees = dailyFeeWei * BigInt(days);
    const pay = prepayMeta.data.symbol;
    const feesStr = `${formatTokenAmountExact(totalFees, prepayMeta.data.decimals)} ${pay}`;
    const nftStr = `${shortAddress(contract)} #${tokenId}${
      standard === 'erc1155' ? ` ×${quantity || '1'}` : ''
    }`;
    return {
      youReceive: copy.rent.receiptListYouReceive(feesStr, formatDurationDays(days)),
      youLock: copy.rent.receiptListYouLock(nftStr),
      youMayOwe: copy.rent.nothing,
      youCanLose: `${copy.rent.listYouCanLose} ${copy.rent.notDebt}`,
      fees: copy.fees.lenderRentalFee(formatBpsAsPercent(fees.treasuryFeeBps)),
      whenThisEnds: copy.rent.listWhenEnds,
    };
  }, [
    form,
    dailyFeeWei,
    prepayMeta.data,
    durationDays,
    contract,
    tokenId,
    standard,
    quantity,
    fees.treasuryFeeBps,
  ]);

  const formError = form ? validateOfferForm(form) : null;
  // #1028 — operator kill switch (position-opening flows only).
  const killed = flowDisabled('nft-list');
  const canSign =
    allChecksPass(checks) &&
    receipt !== null &&
    formError === null &&
    durationValid &&
    // wallet client hydrates async after isConnected — without these a
    // click in the gap would silently no-op.
    Boolean(walletClient) &&
    Boolean(publicClient) &&
    !killed &&
    !busy;

  async function submit() {
    if (killed) {
      setError(copy.killSwitch.disabled);
      return;
    }
    if (!form || !address || !walletChain || !walletClient || !publicClient) {
      setError(copy.wallet.connectFirst);
      return;
    }
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    setProgress({ kind: 'approve', current: 0, total: 0 });
    setError(null);
    // Runtime plan: the collection-approval prompt drops out when the
    // operator approval already stands (an unknown read plans it IN —
    // over-promising is the honest direction).
    const alreadyApproved = await readNftOperatorApproval({
      publicClient,
      contract: contract as `0x${string}`,
      owner: address,
      operator: walletChain.diamondAddress,
    });
    const stepper = makeStepper(alreadyApproved === true ? 1 : 2, setProgress);
    try {
      // The checklist's sanctions item is a CACHED read — re-screen
      // the wallet live before setApprovalForAll can mine.
      await assertWalletNotSanctionedLive(
        publicClient,
        walletChain.diamondAddress,
        address,
      );
      // The receipt quoted the CACHED fee config and the duration was
      // validated against the cached cap — re-read live and force a
      // re-review on any move, BEFORE the NFT approval can mine.
      const liveFees = await readLiveProtocolFees(
        publicClient,
        walletChain.diamondAddress,
      );
      if (
        liveFees.treasuryFeeBps !== fees.treasuryFeeBps ||
        liveFees.maxOfferDurationDays !== fees.maxOfferDurationDays
      ) {
        void queryClient.invalidateQueries({ queryKey: ['protocolFees'] });
        throw new Error(copy.match.termsChanged);
      }
      // The checklist ruled VPFI out from a CACHED read — re-read the
      // live token (fail closed) so a registration/rotation since
      // review can't let a VPFI prepay through to a wasted
      // setApprovalForAll (createOffer: VpfiNotAllowedAsRentalPrepay).
      const liveVpfiToken = await readVpfiTokenLive(
        publicClient,
        walletChain.diamondAddress,
        copy.rent.vpfiCheckRetry,
      );
      if (liveVpfiToken.toLowerCase() === prepayAsset.toLowerCase()) {
        throw new Error(copy.rent.vpfiPrepayNotAllowed);
      }
      // Ownership was checked from a CACHED read — re-read live so an
      // NFT transferred/sold since review fails BEFORE the
      // collection-wide setApprovalForAll can mine.
      const [stillOwns] = await Promise.all([
        readNftOwnershipLive({
          publicClient,
          contract: contract as `0x${string}`,
          standard: standardEnum,
          tokenId,
          quantity,
          owner: address,
        }),
        // createOffer rejects paused collections (requireAssetNotPaused)
        // — checked in the same round-trip, before setApprovalForAll.
        assertAssetNotPausedLive({
          publicClient,
          diamondAddress: walletChain.diamondAddress,
          asset: contract as `0x${string}`,
        }),
      ]);
      if (!stillOwns) {
        throw new Error(copy.rent.checkNotOwner);
      }
      await ensureNftApproval({
        publicClient,
        walletClient,
        contract: contract as `0x${string}`,
        owner: address,
        operator: walletChain.diamondAddress,
        onPrompt: () => stepper.next('approve'),
      });
      stepper.next('send');
      const payload = toCreateOfferPayload(form, {});
      const { hash } = await write('createOffer', [payload]);
      setTxHash(hash);
      setStep('done');
      void queryClient.invalidateQueries({ queryKey: ['myOffers'] });
      void queryClient.invalidateQueries({ queryKey: ['activeOffers'] });
    } catch (err) {
      setError(captureTxError(err));
      // setApprovalForAll may have MINED before createOffer was
      // rejected — re-read so the roadmap stops promising a prompt
      // the next submit will skip.
      void nftApproval.refetch();
    } finally {
      submitLockRef.current = false;
      setProgress(null);
    }
  }

  return (
    <div>
      <StepNav
        steps={[copy.rent.stepYourNft, copy.rent.stepReview, copy.rent.stepDone]}
        current={step === 'details' ? 0 : step === 'review' ? 1 : 2}
      />

      {step === 'details' ? (
        <div className="card">
          <div className="field">
            <label htmlFor="nft-standard">{copy.rent.nftTypeLabel}</label>
            <SelectMenu
              id="nft-standard"
              value={standard}
              onChange={(next) => {
                setStandard(next as 'erc721' | 'erc1155');
              }}
              options={[
                { value: 'erc721', label: copy.rent.nftTypeErc721 },
                { value: 'erc1155', label: copy.rent.nftTypeErc1155 },
              ]}
            />
          </div>
          <div className="field">
            <label htmlFor="nft-contract">{copy.rent.contractLabel}</label>
            <input
              id="nft-contract"
              className={`input ${contract !== '' && !isAddressLike(contract) ? 'input-invalid' : ''}`}
              placeholder="0x…"
              value={contract}
              onChange={(e) => {
                setContract(e.target.value.trim());
              }}
              spellCheck={false}
              autoComplete="off"
            />
            <span className="field-hint">
              {copy.rent.contractHint}
            </span>
          </div>
          <div className="field">
            <label htmlFor="nft-token-id">{copy.rent.tokenIdLabel}</label>
            <input
              id="nft-token-id"
              className="input"
              inputMode="numeric"
              placeholder="1"
              value={tokenId}
              onChange={(e) => {
                setTokenId(e.target.value.trim());
              }}
            />
          </div>
          {standard === 'erc1155' ? (
            <div className="field">
              <label htmlFor="nft-quantity">{copy.rent.quantityLabel}</label>
              <input
                id="nft-quantity"
                className="input"
                inputMode="numeric"
                placeholder="1"
                value={quantity}
                onChange={(e) => {
                  setQuantity(e.target.value.trim());
                }}
              />
            </div>
          ) : null}
          <AssetPicker
            id="prepay-asset"
            label={copy.rent.prepayAssetLabel}
            hint={copy.rent.prepayAssetHint}
            value={prepayAsset}
            onChange={(v) => {
              setPrepayAsset(v);
            }}
          />
          <div className="field">
            <label htmlFor="daily-fee">
              {copy.rent.dailyFeeLabel}{prepayMeta.data ? copy.rent.perDaySuffix(prepayMeta.data.symbol) : ''}
            </label>
            <input
              id="daily-fee"
              className="input"
              inputMode="decimal"
              placeholder="10"
              value={dailyFee}
              onChange={(e) => {
                setDailyFee(e.target.value.trim());
              }}
            />
            <span className="field-hint">
              {copy.rent.bufferNote(formatBpsAsPercent(bufferBps))}
            </span>
            {prepayMeta.data ? (
              <AmountPrecisionHint
                value={dailyFee}
                decimals={prepayMeta.data.decimals}
                symbol={prepayMeta.data.symbol}
              />
            ) : null}
          </div>
          <div className="field">
            <label htmlFor="rent-duration">{copy.rent.durationLabel}</label>
            <SelectMenu
              id="rent-duration"
              value={durationDays}
              onChange={(next) => {
                setDurationDays(next);
              }}
              options={durationOptions.map((d) => ({
                value: String(d),
                label: formatDurationDays(d),
              }))}
            />
            {!durationValid ? (
              <span className="field-hint">
                {copy.rent.durationCap(formatDurationDays(fees.maxOfferDurationDays))}
              </span>
            ) : null}
          </div>
          <button
            type="button"
            className="btn btn-primary btn-block"
            disabled={!detailsComplete}
            onClick={() => setStep('review')}
          >
            {copy.rent.continueToReview}
          </button>
        </div>
      ) : null}

      {step === 'review' ? (
        <div className="stack">
          <div className="banner banner-info">
            <span className="banner-body">{copy.rent.custodyNote}</span>
          </div>
          {standard === 'erc721' && rentalSupport.data !== true && !rentalSupport.isLoading ? (
            <div className="banner banner-warn" role="status">
              <span className="banner-body">
                {rentalSupport.data === false
                  ? copy.rent.no4907Warning
                  : copy.rent.no4907Unknown}
              </span>
            </div>
          ) : null}
          <div className="card">
            <h3>{copy.rent.beforeYouSign}</h3>
            <Checklist items={checks} />
          </div>
          <div className="card">
            {receipt ? <ReviewReceipt data={receipt} /> : <p className="muted">{copy.rent.preparingReview}</p>}
            {receipt ? <SimulationPreview tx={simTx} /> : null}
            {killed ? (
              <div className="banner banner-warn" role="alert" style={{ marginTop: 16 }}>
                <span className="banner-body">{copy.killSwitch.disabled}</span>
              </div>
            ) : null}
            {/* #1037 — every wallet prompt named before the first fires. */}
            <div className="banner banner-info" role="note" style={{ marginTop: 16 }}>
              <span className="banner-body">
                {nftApproval.data === true
                  ? copy.signing.intro(1)
                  : nftApproval.data === false
                    ? copy.signing.intro(2)
                    : copy.signing.introUpTo(2)}
                <ol style={{ margin: '6px 0 0 18px', padding: 0 }}>
                  {nftApproval.data !== true ? <li>{copy.signing.approveNft}</li> : null}
                  <li>{copy.signing.postListing}</li>
                </ol>
              </span>
            </div>
            <label
              className="cluster"
              style={{ marginTop: 16, fontSize: '0.9rem', alignItems: 'flex-start' }}
            >
              <input
                type="checkbox"
                checked={consent.given}
                onChange={(e) => consent.set(e.target.checked)}
                style={{ marginTop: 3 }}
              />
              <ConsentLabel />
            </label>
            <ConsentWithdrawnNote consent={consent} />
            {error ? (
              <div className="banner banner-danger" role="alert" style={{ marginTop: 16 }}>
                <span className="banner-body">{error}</span>
              </div>
            ) : null}
            <div className="cluster" style={{ marginTop: 16 }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setStep('details')}
                disabled={busy}
              >
                {copy.rent.back}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                style={{ flex: 1 }}
                disabled={!canSign}
                onClick={() => void submit()}
              >
                {busy ? <LoaderCircle className="spin" aria-hidden size={18} /> : null}
                {progress !== null
                  ? progress.current === 0
                    ? copy.rent.waitingForWallet
                    : progress.kind === 'approve'
                      ? copy.signing.phaseApprove(progress.current, progress.total)
                      : copy.signing.phaseSend(progress.current, progress.total)
                  : copy.rent.postListing}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {step === 'done' ? (
        <div className="card" style={{ textAlign: 'center' }}>
          <CircleCheck aria-hidden size={40} style={{ color: 'var(--ok)', marginBottom: 8 }} />
          <h2>{copy.rent.listingPosted}</h2>
          <p className="muted">{copy.rent.listingPostedNext}</p>
          {txHash && walletChain ? (
            <p className="muted">
              <a
                href={`${walletChain.blockExplorer}/tx/${txHash}`}
                target="_blank"
                rel="noreferrer"
              >
                {copy.rent.viewTransaction}
              </a>
            </p>
          ) : null}
          <Link to="/positions" className="btn btn-primary">
            {copy.rent.viewPositions}
          </Link>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- N2
function RentalListingRow({
  offer,
  bufferBps,
  onChoose,
}: {
  offer: IndexedOffer;
  bufferBps: number;
  onChoose: () => void;
}) {
  const prepayMeta = useTokenMeta(offer.prepayAsset);
  const dailyFee = BigInt(offer.amount);
  const total = totalRentalPrepay(dailyFee, offer.durationDays, bufferBps);
  const pay = prepayMeta.data?.symbol ?? '…';

  return (
    <div className="item-row">
      <span className="row-main">
        <span className="row-title">
          {shortAddress(offer.lendingAsset)} #{offer.tokenId}
          {offer.assetType === AssetType.ERC1155 ? ` ×${offer.quantity}` : ''}
        </span>
        <br />
        <span className="row-sub">
          {prepayMeta.data
            ? copy.rent.browseRowPriced(
                formatTokenAmount(dailyFee, prepayMeta.data.decimals),
                pay,
                formatDurationDays(offer.durationDays),
                formatTokenAmount(total, prepayMeta.data.decimals),
              )
            : copy.rent.browseRowUnpriced(
                formatDurationDays(offer.durationDays),
                offer.offerId,
              )}
        </span>
      </span>
      <button type="button" className="btn btn-primary btn-sm" onClick={onChoose}>
        {copy.match.choose}
      </button>
    </div>
  );
}

function RentNftFlow() {
  const { address, walletChain, readChain } = useActiveChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const readClient = usePublicClient({ chainId: readChain.chainId });
  const { write } = useDiamondWrite();
  const permit2 = usePermit2Signing();
  const { sign: signAcceptTerms } = useAcceptTermsSigning();
  const queryClient = useQueryClient();
  const { bps: bufferBps, ready: bufferReady } = useRentalBufferBps();
  const activeOffers = useActiveOffers();

  const [step, setStep] = useState<'browse' | 'review' | 'done'>('browse');
  const [selected, setSelected] = useState<IndexedOffer | null>(null);
  // #1037 — staged submit progress (busy derives from it).
  const [progress, setProgress] = useState<SubmitProgress | null>(null);
  const busy = progress !== null;
  const submitLockRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  // Deep link (?offer=<id>) from the Offer Book's "Rent this NFT".
  // Same rules and notices as OfferFlow's deep link — dead links get a
  // plain-language explanation, never a silent return to browse.
  const [searchParams, setSearchParams] = useSearchParams();
  const offerParam = searchParams.get('offer');
  const offerParamValid =
    offerParam !== null && /^\d+$/.test(offerParam.trim()) && offerParam.trim() !== '';
  const deepLinkId = offerParamValid ? Number(offerParam) : undefined;
  const deepLinkQuery = useOffer(deepLinkId);
  useEffect(() => {
    if (offerParam === null || selected || step !== 'browse') return;
    const clear = (message: string | null) => {
      if (message) setNotice(message);
      setSearchParams({}, { replace: true });
    };
    if (!offerParamValid) {
      clear(copy.match.offerNotFound);
      return;
    }
    // Offer ids repeat across chains — refuse a link minted for a
    // different network instead of resolving a same-id stranger.
    const chainParam = searchParams.get('chain');
    if (chainParam !== null && Number(chainParam) !== readChain.chainId) {
      const target = getSupportedChain(Number(chainParam));
      clear(
        copy.match.wrongChainLink(
          target ? target.name : copy.common.networkFallback(chainParam),
        ),
      );
      return;
    }
    if (deepLinkQuery.isLoading) return;
    const row = deepLinkQuery.data;
    if (row === null || row === undefined) {
      clear(copy.match.offerNotFound);
      return;
    }
    if (row.offerType !== 0 || row.assetType === AssetType.ERC20) {
      clear(copy.match.wrongSide);
      return;
    }
    if (address && row.creator.toLowerCase() === address.toLowerCase()) {
      clear(copy.match.ownOffer);
      return;
    }
    if (row.status !== 'active') {
      clear(copy.match.offerGone);
      return;
    }
    clear(null);
    // Resolving a deep link: the inputs are the URL (read and then
    // rewritten via `setSearchParams` — an external system both ways) and
    // an async query result. Neither exists at render time on the pass
    // that must act on them.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelected(row);
    setStep('review');
  }, [
    offerParam,
    offerParamValid,
    deepLinkQuery.isLoading,
    deepLinkQuery.data,
    selected,
    step,
    address,
    searchParams,
    readChain.chainId,
    setSearchParams,
  ]);

  const listings = useMemo(() => {
    const rows = activeOffers.data;
    if (!Array.isArray(rows)) return rows === null ? null : [];
    return rows.filter(
      (o) =>
        o.offerType === 0 &&
        (o.assetType === AssetType.ERC721 || o.assetType === AssetType.ERC1155) &&
        (!address || o.creator.toLowerCase() !== address.toLowerCase()),
    );
  }, [activeOffers.data, address]);

  const prepayMeta = useTokenMeta(selected?.prepayAsset);
  const prepayBalance = useTokenBalance(selected?.prepayAsset);
  const totalPrepay = selected
    ? totalRentalPrepay(BigInt(selected.amount), selected.durationDays, bufferBps)
    : undefined;
  // #1037 roadmap inputs (see OfferFlow): live prepay allowance
  // decides whether the approve leg is 0, 1, or 2 prompts.
  const planAllowance = useAllowanceForPlan({
    chainId: walletChain?.chainId,
    token: selected?.prepayAsset as `0x${string}` | undefined,
    owner: address as `0x${string}` | undefined,
    spender: walletChain?.diamondAddress,
  });
  const rentPlanApprove =
    totalPrepay !== undefined
      ? plannedApprovePrompts(planAllowance.data, totalPrepay)
      : 2;
  const rentPlanKnown =
    totalPrepay !== undefined && planAllowance.data !== undefined;
  const rentPlanTotal = 2 + rentPlanApprove;
  // #1036 / #2726 — screen every ERC-20 leg the rental moves: the
  // prepayment token the renter pays (the listed NFT itself has no ERC-20
  // security surface) and a collateral leg if the listing carries one. The
  // shared screen the accept signer enforces; fail closed: a block, a
  // pending verdict or a failed check holds the accept button.
  const tokenScreen = useTokenScreen(
    readChain.chainId,
    selected ? screenTargets(selected) : [],
  );
  const prepaySecBlocked = !tokenScreen.ok;


  const receipt = useMemo((): ReceiptData | null => {
    if (!selected || !prepayMeta.data || totalPrepay === undefined) return null;
    const pay = prepayMeta.data.symbol;
    const totalStr = `${formatTokenAmountExact(totalPrepay, prepayMeta.data.decimals)} ${pay}`;
    const nftStr = `${shortAddress(selected.lendingAsset)} #${selected.tokenId}`;
    const durationStr = formatDurationDays(selected.durationDays);
    return {
      youReceive: `${copy.rent.receiptRentYouReceive(nftStr, durationStr)} ${copy.rent.custodyNote}`,
      youLock: copy.rent.receiptRentYouLock(totalStr, formatBpsAsPercent(bufferBps)),
      youMayOwe: `${copy.rent.rentYouMayOwe} ${copy.rent.notDebt}`,
      youCanLose: copy.rent.receiptRentYouCanLose(formatBpsAsPercent(bufferBps)),
      fees: copy.rent.rentFeesNote,
      whenThisEnds: copy.rent.receiptRentWhenEnds(durationStr),
    };
  }, [selected, prepayMeta.data, totalPrepay, bufferBps]);

  // #2725 — the lifecycle terms the accept signature binds, read LIVE from
  // the listing (the indexer row carries only some of them) together with
  // its linked loan. The review lists every one and the signer compares each
  // against what it signs. A failed refresh counts as unread.
  const rentLifecycleQuery = useQuery({
    queryKey: ['offerLifecycle', readChain.chainId, selected?.offerId, 'rent'],
    enabled: step === 'review' && Boolean(readClient) && Boolean(selected),
    staleTime: 30_000,
    refetchInterval: idleAware(60_000),
    queryFn: async () => {
      const offerId = BigInt(selected!.offerId);
      const [o, linked] = await Promise.all([
        readClient!.readContract({
          address: readChain.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getOffer',
          args: [offerId],
        }) as Promise<Record<string, unknown>>,
        readClient!.readContract({
          address: readChain.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getOfferLinkedLoanId',
          args: [offerId],
        }) as Promise<bigint>,
      ]);
      return {
        lifecycle: lifecycleFromOffer(o, linked),
        // #2938 — from the canonical struct, not the indexer row, so a row
        // that lags the chain cannot hide a named collateral.
        namesCollateral: rentalNamesCollateral(o as unknown as CollateralFields),
      };
    },
  });
  const rentLifecycle: LifecycleTerms | undefined = rentLifecycleQuery.isError
    ? undefined
    : rentLifecycleQuery.data?.lifecycle;
  // #2938 — a rental takes no collateral (the accept pulls only the
  // prepayment, and a rental default never reads the collateral fields). A
  // listing that names one would have the renter acknowledge an asset the
  // rental does not use, so the review refuses it by name. Either source
  // naming one is enough: the indexer row decides before the live read lands.
  const listingNamesCollateral =
    (selected !== null && rentalNamesCollateral(selected)) ||
    rentLifecycleQuery.data?.namesCollateral === true;
  // Consent covers exactly what the review shows (#1696): the listing and
  // its lifecycle terms (first arrival included), the prepayment and the
  // live buffer it is sized by, the token screen's verdicts with their
  // REASON text (a changed warning is a new disclosure even when the kind
  // stayed 'warn'), and the account signing. Keyed on the values and
  // cleared in the same render they change, so no frame can sign against a
  // tick that predates a late disclosure.
  const rentLifecycleFp = rentLifecycle
    ? [
        rentLifecycle.useFullTermInterest,
        rentLifecycle.allowsPartialRepay,
        rentLifecycle.allowsPrepayListing,
        rentLifecycle.allowsParallelSale,
        rentLifecycle.periodicInterestCadence,
        rentLifecycle.refinanceTargetLoanId,
        rentLifecycle.linkedLoanId,
        rentLifecycle.parallelSaleOrderHash,
      ].join(':')
    : 'pending';
  const consent = useReviewConsent([
    selected?.offerId,
    totalPrepay,
    bufferBps,
    bufferReady,
    prepayMeta.data?.symbol,
    prepayMeta.data?.decimals,
    tokenScreen.fingerprint,
    rentLifecycleFp,
    listingNamesCollateral,
    address,
    walletChain?.chainId,
  ]);

  const baseChecks = useEligibility({
    asset: selected
      ? {
          meta: prepayMeta.data,
          metaError: prepayMeta.isError,
          balance: prepayBalance.data,
          required: totalPrepay,
        }
      : undefined,
    consent: consent.given,
  });
  // The prepay pull depends on the LIVE buffer — signing before the
  // config read lands would compute the approval from a default.
  const checks = useMemo(
    (): CheckItem[] => [
      ...baseChecks,
      {
        id: 'rental-config',
        label: bufferReady
          ? copy.rent.liveRentalLoaded
          : copy.rent.liveRentalLoading,
        state: bufferReady ? 'pass' : 'pending',
      },
    ],
    [baseChecks, bufferReady],
  );

  // #1028 — operator kill switch (position-opening flows only).
  const killed = flowDisabled('nft-rent');
  const canSign =
    allChecksPass(checks) &&
    receipt !== null &&
    // #2725 — every lifecycle term the signature binds has been read and shown.
    rentLifecycle !== undefined &&
    !listingNamesCollateral &&
    Boolean(walletClient) &&
    Boolean(publicClient) &&
    // A disclosed warning needs no clause of its own: the consent check in
    // `checks` requires a tick, and a tick is always one given against the
    // CURRENT verdicts, since a changed verdict clears it in the same render
    // (#1696).
    !prepaySecBlocked &&
    !killed &&
    !busy;

  async function submit() {
    if (killed) {
      setError(copy.killSwitch.disabled);
      return;
    }
    if (!selected || !address || !walletChain || !walletClient || !publicClient) {
      setError(copy.wallet.connectFirst);
      return;
    }
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    setProgress({ kind: 'sign', current: 0, total: 0 });
    setError(null);
    // Runtime plan: signature + prepay approval (0/1/2 by the live
    // allowance and zero-first rule; unknown plans the ceiling) +
    // the accept transaction.
    let planPromptTotal = 2;
    if (totalPrepay !== undefined && selected) {
      const cur = await readAllowance({
        publicClient,
        token: selected.prepayAsset as `0x${string}`,
        owner: address,
        spender: walletChain.diamondAddress,
      });
      planPromptTotal += plannedApprovePrompts(cur, totalPrepay);
    } else {
      planPromptTotal += 2; // amount unknowable here — plan the ceiling
    }
    const stepper = makeStepper(planPromptTotal, setProgress);
    try {
      // Reviewed row and executing chain must agree — same offerId on
      // another chain is a different rental.
      if (selected.chainId !== walletChain.chainId) {
        throw new Error(copy.match.termsChanged);
      }
      // Re-check at submit time: the wallet may have changed since the
      // listing was selected (deep link → connect the owner wallet).
      if (selected.creator.toLowerCase() === address.toLowerCase()) {
        throw new Error(copy.match.ownOffer);
      }
      // Re-screen the CONNECTED wallet live — the checklist's
      // sanctions item is a cached read.
      await assertWalletNotSanctionedLive(
        publicClient,
        walletChain.diamondAddress,
        address,
      );
      // acceptOffer screens BOTH parties — if the owner was flagged
      // after listing, abort before any signature or prepay approval.
      const ownerFlagged = await publicClient
        .readContract({
          address: walletChain.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'isSanctionedAddress',
          args: [selected.creator as `0x${string}`],
        })
        .catch(() => false); // fail-open, mirroring useSanctionsCheck
      if (ownerFlagged) {
        throw new Error(copy.match.counterpartyBlocked);
      }
      // Reviewed terms go INTO the signer — the canonical-vs-reviewed
      // comparison (incl. ERC-1155 quantity and asset type) runs
      // before the wallet is asked to sign, so the renter never signs
      // terms that differ from the reviewed listing.
      // #1036 / #2726 — the token screen is re-run at SIGN time by the
      // accept signer itself, on every ERC-20 leg of the canonical terms
      // (the prepayment token, and a collateral leg if the listing has one),
      // against what this review showed (`screen` below).
      // #2725 — EVERY term the signature binds, as this review showed it; the
      // signer compares each against the canonical terms before the wallet
      // prompt.
      if (!rentLifecycle) {
        throw new Error(copy.match.termsChanged);
      }
      if (listingNamesCollateral) {
        throw new Error(copy.rent.listingNamesCollateral);
      }
      const reviewedRentTerms: ReviewedAcceptTerms = {
        offerCreator: selected.creator as Address,
        offerType: selected.offerType,
        lendingAsset: selected.lendingAsset as Address,
        collateralAsset: selected.collateralAsset as Address,
        amount: BigInt(selected.amount),
        collateralAmount: BigInt(selected.collateralAmount),
        interestRateBps: BigInt(selected.interestRateBps),
        durationDays: BigInt(selected.durationDays),
        tokenId: BigInt(selected.tokenId),
        collateralTokenId: BigInt(selected.collateralTokenId),
        quantity: BigInt(selected.quantity || '1'),
        collateralQuantity: BigInt(selected.collateralQuantity),
        assetType: selected.assetType,
        collateralAssetType: selected.collateralAssetType,
        prepayAsset: selected.prepayAsset as Address,
        ...rentLifecycle,
        // #2728 — the rental review discloses the NFT leg's own model up
        // front (it stays in custody, fees are prepaid, nothing is
        // liquidated on price), so that leg is acknowledged. A rental takes
        // no collateral, and a listing that names one was refused above
        // (#2938), so no collateral leg is acknowledged.
        illiquidLegs: { lending: true, collateral: false },
      };
      let signed: Awaited<ReturnType<typeof signAcceptTerms>>;
      try {
        stepper.next('sign');
        signed = await signAcceptTerms({
          offerId: BigInt(selected.offerId),
          consent: consent.given,
          expected: reviewedRentTerms,
          // #2726 — the token-security verdicts this review showed.
          screen: tokenScreen.reviewed,
        });
      } catch (err) {
        if (err instanceof Error && err.message === copy.match.termsChanged) {
          void queryClient.invalidateQueries({ queryKey: ['activeOffers'] });
          void queryClient.invalidateQueries({ queryKey: ['offer'] });
          void queryClient.invalidateQueries({ queryKey: ['offerLifecycle'] });
        }
        throw err;
      }
      const { terms, signature } = signed;
      // Renter's pull is dailyFee × days × (1 + buffer) in prepayAsset.
      // Fee terms come from the SIGNED canonical terms; the buffer is
      // read LIVE right now — never a default that may lag governance.
      const liveBufferBps = await readRentalBufferBps(
        publicClient,
        walletChain.diamondAddress,
      );
      // The receipt and balance check used the cached buffer — if
      // governance changed it since review, the user would be asked to
      // approve MORE than the receipt showed. Force a re-review.
      if (liveBufferBps !== bufferBps) {
        void queryClient.invalidateQueries({ queryKey: ['rentalBufferBps'] });
        throw new Error(copy.match.termsChanged);
      }
      // A legacy listing can carry the (now-disallowed) VPFI token as
      // its prepay asset — acceptOffer reverts VpfiNotAllowedAsRental-
      // Prepay AFTER the approval would have been mined. Check the
      // SIGNED terms against the live VPFI token first, and fail
      // CLOSED when the read itself fails: proceeding unchecked is
      // exactly the wasted-approval path this guard exists to prevent
      // (nothing has been sent yet — retrying is free).
      const vpfiToken = await readVpfiTokenLive(
        publicClient,
        walletChain.diamondAddress,
        copy.rent.vpfiCheckRetry,
      );
      if (vpfiToken.toLowerCase() === terms.prepayAsset.toLowerCase()) {
        throw new Error(copy.rent.vpfiPrepayListing);
      }
      const canonicalTotal = totalRentalPrepay(
        terms.amount,
        Number(terms.durationDays),
        liveBufferBps,
      );
      // acceptOffer enforces requireAssetNotPaused on the listed NFT
      // (and the prepay leg), and approve() succeeds regardless of
      // balance — re-check all three live, in ONE round-trip, before
      // the approval can mine.
      await Promise.all([
        assertAssetNotPausedLive({
          publicClient,
          diamondAddress: walletChain.diamondAddress,
          asset: terms.lendingAsset,
        }),
        assertAssetNotPausedLive({
          publicClient,
          diamondAddress: walletChain.diamondAddress,
          asset: terms.prepayAsset,
        }),
        assertErc20BalanceLive({
          publicClient,
          token: terms.prepayAsset,
          owner: address,
          amount: canonicalTotal,
          symbol: prepayMeta.data?.symbol,
        }),
      ]);
      // Permit2 first (#1038) — same rules as the offer flows: the
      // classic path must actually need an approval AND the wallet
      // must hold a standing prepay-token→Permit2 approval covering
      // the total (SignatureTransfer pulls AS the Permit2 contract —
      // without that approval the WithPermit call categorically
      // reverts, so engaging it would burn a doomed transaction).
      // The renter's prepay is the only ERC-20 pull here; the NFT
      // side is the owner's and untouched. (A rental listing is a
      // Lender-type offer with an ERC-20 prepay leg — a valid
      // acceptOfferWithPermit shape by the facet's own gate.)
      let hash: `0x${string}` | null = null;
      if (permit2.canSign) {
        const [cur, permit2Cur] = await Promise.all([
          readAllowance({
            publicClient,
            token: terms.prepayAsset,
            owner: address,
            spender: walletChain.diamondAddress,
          }),
          readAllowance({
            publicClient,
            token: terms.prepayAsset,
            owner: address,
            spender: permit2.permit2Address,
          }),
        ]);
        // Zero-only (not merely short): a non-zero-but-short allowance
        // routes classic so its zero-first reset clears the stale
        // approval instead of leaving it standing.
        const freshApprovalNeeded = cur === undefined || cur === 0n;
        const permit2Funded =
          permit2Cur !== undefined && permit2Cur >= canonicalTotal;
        if (freshApprovalNeeded && permit2Funded) {
          // Phase 1 — the permit signature: any failure is
          // pre-transaction, fall to classic unconditionally; the
          // consumed step is added back to the plan (#1037 honesty).
          stepper.next('permit');
          let permitSigned: Awaited<ReturnType<typeof permit2.sign>> | null =
            null;
          try {
            permitSigned = await permit2.sign({
              token: terms.prepayAsset,
              amount: canonicalTotal,
              spender: walletChain.diamondAddress,
            });
          } catch {
            permitSigned = null;
            stepper.grow(1);
          }
          if (permitSigned) {
            // Phase 2 — the transaction: NO classic fallback from
            // here — ambiguous errors may ride a tx that still mines
            // (double execution), and definitive reverts would doom
            // the classic retry too, after minting a fresh approval
            // for nothing. Errors surface after tripping the session
            // breaker, so a manual retry routes classic.
            stepper.next('send');
            try {
              ({ hash } = await write('acceptOfferWithPermit', [
                BigInt(selected.offerId),
                terms,
                signature,
                permitSigned.permit,
                permitSigned.signature,
              ]));
            } catch (permitErr) {
              disablePermit2ForSession();
              throw permitErr;
            }
          }
        }
      }
      if (hash === null) {
        await ensureAllowance({
          publicClient,
          walletClient,
          token: terms.prepayAsset,
          owner: address,
          spender: walletChain.diamondAddress,
          amount: canonicalTotal,
          onPrompt: () => stepper.next('approve'),
        });
        stepper.next('send');
        ({ hash } = await write('acceptOffer', [
          BigInt(selected.offerId),
          terms,
          signature,
        ]));
      }
      setTxHash(hash);
      setStep('done');
      void queryClient.invalidateQueries({ queryKey: ['activeOffers'] });
      void queryClient.invalidateQueries({ queryKey: ['myLoans'] });
    } catch (err) {
      setError(captureTxError(err));
      // The prepay approval may have MINED before acceptOffer was
      // rejected — re-read so the roadmap matches the next attempt.
      void planAllowance.refetch();
    } finally {
      submitLockRef.current = false;
      setProgress(null);
    }
  }

  return (
    <div>
      <StepNav
        steps={[copy.rent.stepChooseNft, copy.rent.stepReview, copy.rent.stepDone]}
        current={step === 'browse' ? 0 : step === 'review' ? 1 : 2}
      />

      {step === 'browse' && notice ? (
        <div className="banner banner-warn" role="alert">
          <span className="banner-body">{notice}</span>
        </div>
      ) : null}

      {step === 'browse' ? (
        <div className="card">
          <div className="card-title">
            <KeyRound aria-hidden />
            <h2 style={{ margin: 0 }}>{copy.rent.browseTitle}</h2>
          </div>
          {activeOffers.isLoading ? (
            <p className="muted">{copy.rent.listingsLoading}</p>
          ) : listings === null ? (
            <>
              <p className="muted">{copy.rent.browseUnavailable}</p>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void activeOffers.refetch()}
              >
                {copy.rent.tryAgain}
              </button>
            </>
          ) : (
            <>
              {/* Rendered for EMPTY and NON-EMPTY lists alike (it
                  self-gates on cursor staleness): a stale snapshot with
                  a few old listings is just as misleading as a stale
                  empty one — newer listings may be missing. */}
              <MarketFreshnessNote />
              {listings.length === 0 ? (
                // UX-023 — the empty browse list points at the other
                // side of the market instead of dead-ending.
                <p className="muted">
                  {copy.rent.browseEmpty} {copy.rent.browseEmptyCta}
                </p>
              ) : (
                // #1247 PAG-004 — windowed: the source cap allows up
                // to 500 listings.
                <WindowedRowList
                  rows={listings}
                  // Wallet identity too (Codex #1265 r2): the list
                  // filters out the CONNECTED wallet's own listings,
                  // so a wallet switch changes the rows.
                  resetKey={`${readChain.chainId}|${address?.toLowerCase() ?? ''}`}
                  render={(o) => (
                    <RentalListingRow
                      key={o.offerId}
                      offer={o}
                      bufferBps={bufferBps}
                      onChoose={() => {
                        // A chosen listing is a new review, so it starts
                        // unticked even when it is the one last reviewed.
                        consent.clear();
                        setSelected(o);
                        setStep('review');
                      }}
                    />
                  )}
                />
              )}
            </>
          )}
        </div>
      ) : null}

      {step === 'review' && selected ? (
        <div className="stack">
          <div className="banner banner-info">
            <span className="banner-body">{copy.rent.custodyNote}</span>
          </div>
          <div className="card">
            <h3>{copy.rent.beforeYouSign}</h3>
            <Checklist items={checks} />
          </div>
          <div className="card">
            {receipt ? <ReviewReceipt data={receipt} /> : <p className="muted">{copy.rent.preparingReview}</p>}
            {rentLifecycle ? (
              <LifecycleTermsList terms={rentLifecycle} />
            ) : rentLifecycleQuery.isError ? (
              <div className="banner banner-warn" role="alert">
                <span className="banner-body">{copy.acceptTerms.checkFailed}</span>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => void rentLifecycleQuery.refetch()}
                >
                  {copy.offerFlow.retry}
                </button>
              </div>
            ) : (
              <p className="muted" style={{ margin: 0 }}>
                {copy.acceptTerms.checking}
              </p>
            )}
            {listingNamesCollateral ? (
              <div className="banner banner-danger" role="alert" style={{ marginTop: 16 }}>
                <span className="banner-body">{copy.rent.listingNamesCollateral}</span>
              </div>
            ) : null}
            <TokenScreenBanner screen={tokenScreen} style={{ marginTop: 16 }} />
            {killed ? (
              <div className="banner banner-warn" role="alert" style={{ marginTop: 16 }}>
                <span className="banner-body">{copy.killSwitch.disabled}</span>
              </div>
            ) : null}
            {/* #1037 — every wallet prompt named before the first fires. */}
            <div className="banner banner-info" role="note" style={{ marginTop: 16 }}>
              <span className="banner-body">
                {rentPlanKnown
                  ? copy.signing.intro(rentPlanTotal)
                  : copy.signing.introUpTo(rentPlanTotal)}
                <ol style={{ margin: '6px 0 0 18px', padding: 0 }}>
                  <li>{copy.signing.sign}</li>
                  {!rentPlanKnown ? (
                    <li>{copy.signing.approveUnknown}</li>
                  ) : rentPlanApprove === 2 ? (
                    <li>{copy.signing.approveReset}</li>
                  ) : rentPlanApprove === 1 ? (
                    <li>{copy.signing.approve}</li>
                  ) : null}
                  <li>{copy.signing.acceptRental}</li>
                </ol>
              </span>
            </div>
            <label
              className="cluster"
              style={{ marginTop: 16, fontSize: '0.9rem', alignItems: 'flex-start' }}
            >
              <input
                type="checkbox"
                checked={consent.given}
                onChange={(e) => consent.set(e.target.checked)}
                style={{ marginTop: 3 }}
              />
              <ConsentLabel />
            </label>
            <ConsentWithdrawnNote consent={consent} />
            {error ? (
              <div className="banner banner-danger" role="alert" style={{ marginTop: 16 }}>
                <span className="banner-body">{error}</span>
              </div>
            ) : null}
            <div className="cluster" style={{ marginTop: 16 }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setSelected(null);
                  setStep('browse');
                }}
                disabled={busy}
              >
                {copy.rent.back}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                style={{ flex: 1 }}
                disabled={!canSign}
                onClick={() => void submit()}
              >
                {busy ? <LoaderCircle className="spin" aria-hidden size={18} /> : null}
                {progress !== null
                  ? progress.current === 0
                    ? copy.rent.waitingForWallet
                    : progress.kind === 'sign'
                      ? copy.signing.phaseSign(progress.current, progress.total)
                      : progress.kind === 'permit'
                        ? copy.signing.phasePermit(progress.current, progress.total)
                        : progress.kind === 'approve'
                          ? copy.signing.phaseApprove(progress.current, progress.total)
                          : copy.signing.phaseSend(progress.current, progress.total)
                  : copy.rent.acceptRental}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {step === 'done' ? (
        <div className="card" style={{ textAlign: 'center' }}>
          <CircleCheck aria-hidden size={40} style={{ color: 'var(--ok)', marginBottom: 8 }} />
          <h2>{copy.rent.rentalOpened}</h2>
          <p className="muted">{copy.rent.rentalOpenedNext}</p>
          {txHash && walletChain ? (
            <p className="muted">
              <a
                href={`${walletChain.blockExplorer}/tx/${txHash}`}
                target="_blank"
                rel="noreferrer"
              >
                {copy.rent.viewTransaction}
              </a>
            </p>
          ) : null}
          <Link to="/positions" className="btn btn-primary">
            {copy.rent.viewPositions}
          </Link>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- page
export function Rent() {
  // A ?offer=<id> deep link goes straight to the renter path.
  const [initialSearch] = useSearchParams();
  const [path, setPath] = useState<Path>(
    initialSearch.get('offer') !== null ? 'want' : null,
  );

  return (
    <div>
      <h1 className="page-title">{copy.rent.title}</h1>
      <p className="page-lede">{copy.rent.lede}</p>

      {path === null ? (
        <div className="intent-grid">
          <button type="button" className="intent-card" onClick={() => setPath('own')}>
            <span className="intent-icon">
              <Images aria-hidden />
            </span>
            <span style={{ textAlign: 'left' }}>
              <h3>{copy.rent.ownPath}</h3>
              <p>{copy.rent.ownPathBlurb}</p>
            </span>
          </button>
          <button type="button" className="intent-card" onClick={() => setPath('want')}>
            <span className="intent-icon">
              <KeyRound aria-hidden />
            </span>
            <span style={{ textAlign: 'left' }}>
              <h3>{copy.rent.wantPath}</h3>
              <p>{copy.rent.wantPathBlurb}</p>
            </span>
          </button>
          {/* UX-047 — the landing was two cards in a sea of whitespace;
              a direct "browse what's listed" action gives a visitor who
              isn't sure which card fits an obvious way into the actual
              rental marketplace (the renter path, which shows the live
              listings or its own honest empty state). */}
          <p style={{ gridColumn: '1 / -1', textAlign: 'center', margin: 0 }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setPath('want')}
            >
              {copy.rent.browseCta}
            </button>
          </p>
        </div>
      ) : (
        <>
          <p className="muted" style={{ marginBottom: 16 }}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setPath(null)}
            >
              ← {copy.rent.switchPrompt(path === 'own' ? copy.rent.wantPath : copy.rent.ownPath)}
            </button>
          </p>
          {path === 'own' ? <ListNftFlow /> : <RentNftFlow />}
        </>
      )}
    </div>
  );
}
