/**
 * Compact inline confirm for filling a GASLESS signed order (#1131
 * slice D) — the ladder's taker affordance for signed rows. Rendered
 * inside the order-book card (the desk's inline-panel pattern, like the
 * Open orders AmendForm) rather than deep-linking into the guided
 * accept: a signed order has no on-chain offer id to link to.
 *
 * Scope (deliberately the ESSENTIAL path — see the design's
 * don't-gold-plate note): ERC-20 both legs, the VAULT-BACKED
 * `acceptSignedOffer(order, sig, terms, acceptSig)` entry, classic
 * Diamond allowance for the acceptor's leg. There is NO Permit2 lane
 * for the acceptor here by design of the facet: the only permit
 * `acceptSignedOfferWithPermit` takes is the MAKER's wallet-backed
 * funding witness, not an acceptor-side transfer permit — so
 * Permit2-for-signed-accept would need a facet extension first and is
 * left as a follow-up.
 *
 * Which leg the acceptor escrows (mirrors `_acceptOffer` via the
 * injected-acceptor plumbing):
 *  - filling a signed LENDER offer  → the taker is the borrower and
 *    posts the collateral leg (`collateralAmount` of `collateralAsset`);
 *  - filling a signed BORROW request → the taker is the lender and
 *    funds the principal leg (role amount of `lendingAsset`).
 * The MAKER's leg moves from their vault's free balance at fill — the
 * submit preflights re-check that funding live so a taker never pays
 * gas into `SignedOfferInsufficientFreeBalance`.
 */
import { useState } from 'react';
import { CircleCheck } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { usePublicClient, useWalletClient } from 'wagmi';
import { copy } from '../../content/copy';
import { useActiveChain } from '../../chain/useActiveChain';
import { DIAMOND_ABI_VIEM, useDiamondWrite } from '../../contracts/diamond';
import { useSignedOfferAcceptTermsSigning } from '../../contracts/useAcceptTerms';
import { ensureAllowance, useTokenMeta } from '../../contracts/erc20';
import {
  assertAssetNotPausedLive,
  assertErc20BalanceLive,
  assertSignedFillKycEligibleLive,
  assertSignedFillRiskAccessLive,
} from '../../contracts/preflights';
import { assertWalletNotSanctionedLive } from '../../data/sanctions';
import { ConsentLabel } from '../ConsentLabel';
import {
  FullTariffOptIn,
  FULL_TARIFF_OFF,
  type FullTariffChoice,
} from '../FullTariffOptIn';
import { captureTxError } from '../../lib/errors';
import { flowDisabled } from '../../lib/killSwitch';
import {
  signedOfferCeiling,
  signedOfferTypedMessage,
  signedOrderTimeWindowsOpen,
  type SignedRowMeta,
} from '../../lib/signedOffer';
import {
  formatBpsAsPercent,
  formatDurationDays,
  formatTokenAmount,
  shortAddress,
} from '../../lib/format';

const text = copy.desk.signed;

export function SignedFillConfirm({
  signed,
  onDone,
}: {
  signed: SignedRowMeta;
  onDone: () => void;
}) {
  const { address, walletChain, onSupportedChain } = useActiveChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const { write } = useDiamondWrite();
  const queryClient = useQueryClient();
  const signTerms = useSignedOfferAcceptTermsSigning();

  const o = signed.order;
  const isLenderOrder = Number(o.offerType) === 0;
  // The taker's escrowed leg (see the header note). Role amount for a
  // borrower order is its `amount` (the direct-accept headline the
  // terms bind); a lender order's taker posts the collateral.
  const payToken = (isLenderOrder ? o.collateralAsset : o.lendingAsset) as
    `0x${string}`;
  const payAmount = isLenderOrder
    ? BigInt(o.collateralAmount)
    : BigInt(o.amount);
  const headlineAmount = isLenderOrder ? BigInt(o.amountMax) : BigInt(o.amount);
  const rateBps = isLenderOrder
    ? Number(o.interestRateBps)
    : Number(o.interestRateBpsMax);

  const lendingMeta = useTokenMeta(o.lendingAsset);
  const collateralMeta = useTokenMeta(o.collateralAsset);
  const payMeta = isLenderOrder ? collateralMeta : lendingMeta;

  const [consent, setConsent] = useState(false);
  // #1355 — the TAKER's own Full VPFI tariff opt-in for this fill (the
  // maker of a signed order cannot opt in — #1369).
  const [fullTariff, setFullTariff] = useState<FullTariffChoice>(FULL_TARIFF_OFF);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filledHash, setFilledHash] = useState<string | null>(null);

  const killed = flowDisabled('accept-offer');
  const own =
    Boolean(address) && signed.signer.toLowerCase() === address!.toLowerCase();

  async function submit() {
    if (killed) {
      setError(copy.killSwitch.disabled);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (!address || !walletChain || !walletClient || !publicClient) {
        throw new Error(copy.wallet.connectFirst);
      }
      if (own) throw new Error(copy.match.ownOffer);
      // Re-screen the CONNECTED wallet live before any approval mines;
      // the maker is screened too (the fill Tier-1-gates both parties
      // on-chain — fail before the taker spends anything; fail-open on
      // read errors like the direct accept's creator check).
      await assertWalletNotSanctionedLive(
        publicClient,
        walletChain.diamondAddress,
        address,
      );
      const makerFlagged = await publicClient
        .readContract({
          address: walletChain.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'isSanctionedAddress',
          args: [signed.signer as `0x${string}`],
        })
        .catch(() => false);
      if (makerFlagged) {
        throw new Error(copy.match.counterpartyBlocked);
      }
      // MAKER-FUNDING preflight: the vault-backed fill moves the
      // maker's leg from their vault FREE balance
      // (`SignedOfferInsufficientFreeBalance` otherwise), and nothing
      // was escrowed at signing — so re-check it live before the
      // taker's approval can mine. Fail CLOSED on read failure
      // (retrying is free, a wasted approval is not). Stake asset per
      // side mirrors `_resolveSignedOfferStakeAsset` /
      // `_creatorPullAmount`: lender ⇒ lendingAsset × amountMax;
      // borrower ⇒ collateralAsset × collateralAmountMax.
      const stakeToken = (isLenderOrder ? o.lendingAsset : o.collateralAsset) as
        `0x${string}`;
      const stakeAmount = isLenderOrder
        ? BigInt(o.amountMax)
        : BigInt(o.collateralAmountMax);
      const [tracked, encumbered] = await Promise.all([
        publicClient.readContract({
          address: walletChain.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getProtocolTrackedVaultBalance',
          args: [signed.signer as `0x${string}`, stakeToken],
        }) as Promise<bigint>,
        publicClient.readContract({
          address: walletChain.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getEncumbered',
          args: [signed.signer as `0x${string}`, stakeToken, 0n],
        }) as Promise<bigint>,
      ]);
      const makerFree = tracked > encumbered ? tracked - encumbered : 0n;
      if (makerFree < stakeAmount) {
        throw new Error(text.makerNotFunded);
      }
      // Paused legs + the taker's own balance, one live round-trip —
      // same trio the direct accept re-checks before its approval.
      await Promise.all([
        assertAssetNotPausedLive({
          publicClient,
          diamondAddress: walletChain.diamondAddress,
          asset: o.lendingAsset as `0x${string}`,
        }),
        assertAssetNotPausedLive({
          publicClient,
          diamondAddress: walletChain.diamondAddress,
          asset: o.collateralAsset as `0x${string}`,
        }),
        assertErc20BalanceLive({
          publicClient,
          token: payToken,
          owner: address,
          amount: payAmount,
          symbol: payMeta.data?.symbol,
        }),
      ]);
      // KYC gate (Codex #1145 round-3 P2): the materialized fill runs
      // `_acceptOffer`'s `meetsKYCRequirement` for BOTH parties at the
      // deal's numeraire value and reverts `KYCRequired` — preview it
      // here, like the direct-accept signer previews its gates, so an
      // ineligible party costs the taker no signature or approval. A
      // no-op passthrough on the retail deploy (enforcement off); real
      // on the KYC-enabled industrial forks. The lending amount is the
      // role-aware effective principal `_acceptOffer` gates on (lender
      // order ⇒ amountMax, borrower order ⇒ amount = headlineAmount).
      await assertSignedFillKycEligibleLive({
        publicClient,
        diamondAddress: walletChain.diamondAddress,
        maker: signed.signer as `0x${string}`,
        taker: address,
        lendingAsset: o.lendingAsset as `0x${string}`,
        lendingAmount: headlineAmount,
        collateralAsset: o.collateralAsset as `0x${string}`,
        collateralAmount: BigInt(o.collateralAmount),
      });
      // Risk-access gate (Codex #1145 round-6 P2): the fill runs the
      // normal accept-time risk gates — the materialization gates the
      // MAKER (their create-time gate deferred to fill, since signing
      // touched no chain) and loan-init re-gates the maker + gates the
      // TAKER. A maker who down-tiered / revoked consent after posting,
      // or a taker below the pair's required tier, reverts only at the
      // write — preview it here so it costs the taker no signature or
      // approval. One cheap read + passthrough on the retail deploy
      // (gate off — the deploy default); see the preflight for the
      // exact on-chain mirrors and postures.
      await assertSignedFillRiskAccessLive({
        publicClient,
        diamondAddress: walletChain.diamondAddress,
        maker: signed.signer as `0x${string}`,
        taker: address,
        lendingAsset: o.lendingAsset as `0x${string}`,
        lendingAssetType: Number(o.assetType),
        lendingTokenId: BigInt(o.tokenId),
        collateralAsset: o.collateralAsset as `0x${string}`,
        collateralAssetType: Number(o.collateralAssetType),
        collateralTokenId: BigInt(o.collateralTokenId),
        prepayAsset: o.prepayAsset as `0x${string}`,
      });
      // Sign the AcceptTerms — the hook re-vets the order live (fill
      // ledger, burned nonce, both time windows on chain time, illiquid
      // legs, risk-terms hash) BEFORE the wallet is asked to sign.
      const { payload, orderHash } = await signTerms.sign({
        order: o,
        consent,
        // #1355 — undefined (⇒ non-Full) unless the taker engaged it.
        fullTariff: fullTariff.full ? fullTariff : undefined,
      });
      // Classic Diamond allowance for the taker's leg (no Permit2 lane
      // on this path — see the header note).
      await ensureAllowance({
        publicClient,
        walletClient,
        token: payToken,
        owner: address,
        spender: walletChain.diamondAddress,
        amount: payAmount,
      });
      // Final consumption + time-window + maker-funding recheck (Codex
      // #1145 round-3 P2 + round-4 P2 + round-5 P2): the signer's vet
      // and the funding preflight above ran before the wallet prompts,
      // and a classic approval may have just spent minutes mining —
      // during that window another taker can fill the order, the maker
      // can cancel / batch-burn its nonce OR spend their vault's free
      // balance (nothing was escrowed at signing), and the time windows
      // can lapse. Re-read all five (one Promise.all round-trip, same
      // call shapes as the pre-signature vet in
      // useSignedOfferAcceptTermsSigning and the funding preflight
      // above) so a consumed, lapsed, or defunded order fails BEFORE
      // the fill transaction is sent, not as a SignedOfferConsumed /
      // nonce / expiry / SignedOfferInsufficientFreeBalance revert the
      // taker pays for.
      const [
        { timestamp: chainNowPreWrite },
        filledPreWrite,
        nonceUsedPreWrite,
        trackedPreWrite,
        encumberedPreWrite,
      ] = await Promise.all([
        publicClient.getBlock({ blockTag: 'latest' }),
        publicClient.readContract({
          address: walletChain.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'signedOfferFilledAmount',
          args: [orderHash],
        }) as Promise<bigint>,
        publicClient.readContract({
          address: walletChain.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'isSignedOfferNonceUsed',
          args: [o.signer as `0x${string}`, BigInt(o.nonce)],
        }) as Promise<boolean>,
        publicClient.readContract({
          address: walletChain.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getProtocolTrackedVaultBalance',
          args: [signed.signer as `0x${string}`, stakeToken],
        }) as Promise<bigint>,
        publicClient.readContract({
          address: walletChain.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getEncumbered',
          args: [signed.signer as `0x${string}`, stakeToken, 0n],
        }) as Promise<bigint>,
      ]);
      if (filledPreWrite !== 0n || nonceUsedPreWrite) {
        throw new Error(text.gone);
      }
      if (!signedOrderTimeWindowsOpen(o, chainNowPreWrite)) {
        throw new Error(text.gone);
      }
      const makerFreePreWrite =
        trackedPreWrite > encumberedPreWrite
          ? trackedPreWrite - encumberedPreWrite
          : 0n;
      if (makerFreePreWrite < stakeAmount) {
        throw new Error(text.makerNotFunded);
      }
      const { hash } = await write('acceptSignedOffer', [
        signedOfferTypedMessage(o),
        signed.signature,
        payload.terms,
        payload.signature,
      ]);
      setFilledHash(hash);
      void queryClient.invalidateQueries({ queryKey: ['deskSignedBook'] });
      void queryClient.invalidateQueries({ queryKey: ['deskBook'] });
      void queryClient.invalidateQueries({ queryKey: ['deskMarkets'] });
      void queryClient.invalidateQueries({ queryKey: ['deskTape'] });
      // The fill's print belongs in the chart too — deskCandles rides a
      // 60s interval (same reasoning as MatchBand; Codex #1145 r8 P3).
      void queryClient.invalidateQueries({ queryKey: ['deskCandles'] });
      void queryClient.invalidateQueries({ queryKey: ['activeOffers'] });
      void queryClient.invalidateQueries({ queryKey: ['myOffers'] });
      void queryClient.invalidateQueries({ queryKey: ['myLoans'] });
      // Desk History tab (Codex #1145 round-6 P2): the fill just made
      // the taker a participant in a brand-new loan — refetch the
      // by-participant walk so the History panel shows it without a
      // reload (same root useDeskHistory keys on; the chainId/wallet
      // segments are covered by root-prefix matching).
      void queryClient.invalidateQueries({ queryKey: ['deskHistory'] });
    } catch (err) {
      setError(captureTxError(err));
    } finally {
      setBusy(false);
    }
  }

  const payDecimals = payMeta.data?.decimals;
  const headlineDecimals = lendingMeta.data?.decimals;

  return (
    <div className="card desk-signed-confirm" style={{ marginTop: 8 }}>
      <p style={{ margin: 0, fontWeight: 600 }}>{text.confirmTitle}</p>
      <p className="muted" style={{ margin: '4px 0 8px', fontSize: '0.85rem' }}>
        {text.confirmLede}
      </p>
      <p style={{ margin: '4px 0', fontSize: '0.9rem' }}>
        {isLenderOrder ? copy.offers.lenderOffer : copy.offers.borrowerOffer} ·{' '}
        <span title={`${rateBps} bps`}>
          {text.rateLine(
            formatBpsAsPercent(rateBps),
            formatDurationDays(Number(o.durationDays)),
          )}
        </span>{' '}
        ·{' '}
        {headlineDecimals !== undefined
          ? `${formatTokenAmount(headlineAmount, headlineDecimals)} ${lendingMeta.data?.symbol ?? ''}`
          : '…'}{' '}
        · {shortAddress(signed.signer)}
      </p>
      <p className="muted" style={{ margin: '4px 0 8px', fontSize: '0.85rem' }}>
        {payDecimals !== undefined
          ? (isLenderOrder ? text.payCollateral : text.payPrincipal)(
              formatTokenAmount(payAmount, payDecimals),
              payMeta.data?.symbol ?? shortAddress(payToken),
            )
          : '…'}
      </p>

      {Number(o.assetType) === 0 ? (
        // #1355 — ERC-20 fills only (a rental order bears no tariff).
        <FullTariffOptIn
          lendingAsset={o.lendingAsset as `0x${string}`}
          // Codex #1412 r2 — the order's PRINCIPAL ceiling, via the
          // same helper the fill affordance uses: a single-value
          // lender order's `amountMax == 0` sentinel would otherwise
          // zero the quote and dead-end the card.
          principal={signedOfferCeiling(o)}
          durationDays={Number(o.durationDays)}
          value={fullTariff}
          onChange={(v) => {
            setFullTariff(v);
            // Codex #1412 r1 — a tariff edit changes the signed
            // terms, so a prior consent no longer covers them.
            setConsent(false);
          }}
        />
      ) : null}

      <label
        className="cluster"
        style={{ alignItems: 'flex-start', gap: 8, margin: '8px 0' }}
      >
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          style={{ marginTop: 3 }}
        />
        <ConsentLabel />
      </label>

      {killed ? (
        <div className="banner banner-warn" role="alert" style={{ margin: '8px 0' }}>
          <span className="banner-body">{copy.killSwitch.disabled}</span>
        </div>
      ) : null}
      {error ? (
        <p style={{ color: 'var(--danger)', fontSize: '0.85rem' }}>{error}</p>
      ) : null}
      {filledHash ? (
        <p className="cluster" style={{ alignItems: 'center', gap: 6, color: 'var(--ok)' }}>
          <CircleCheck size={16} aria-hidden />
          <span>{text.accepted}</span>
        </p>
      ) : null}

      <div className="cluster" style={{ marginTop: 8 }}>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={onDone}
          disabled={busy}
        >
          {text.close}
        </button>
        {filledHash === null ? (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            style={{ flex: 1 }}
            disabled={
              busy ||
              !consent ||
              !onSupportedChain ||
              killed ||
              own ||
              !walletClient ||
              payDecimals === undefined
            }
            onClick={() => void submit()}
          >
            {busy ? text.accepting : text.accept}
          </button>
        ) : null}
      </div>
    </div>
  );
}
