/**
 * Open orders panel (#1129 §3) — the wallet's open offers with
 * rate / size / filled-progress / expiry, cancel, and the FIRST amend
 * UI for OfferMutateFacet (#193): pencil → inline form → ONE
 * `modifyOffer` transaction, same offerId, same position NFT.
 *
 * Rows come from `useMyOffersFull` (union of offers the wallet
 * CREATED and offers whose position NFT it currently HOLDS — chain-
 * authoritative with the indexer as the redundancy leg). Both cancel
 * AND amend are gated on `offer.creator === wallet`: the contracts
 * authorize only the creator; held-not-created rows render read-only.
 *
 * Amend pre-fills from a LIVE `getOffer` read, never the indexer row
 * — `modifyOffer` treats "supplied == existing" as "leave this
 * cluster alone", and the indexer row doesn't even carry
 * `collateralAmountMax`. A GROW (larger lender principal / borrower
 * collateral escrow) pulls the delta from the wallet via the Diamond
 * allowance, and there is NO `modifyOfferWithPermit` — so grows get
 * an allowance precheck + a classic "Approve first" button.
 */
import { useMemo, useState } from 'react';
import { Inbox, LoaderCircle, Pencil } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePublicClient, useWalletClient } from 'wagmi';
import { parseUnits } from 'viem';
import { copy } from '../../content/copy';
import { useActiveChain } from '../../chain/useActiveChain';
import { useDiamondWrite } from '../../contracts/diamond';
import { ensureAllowance, useTokenMeta } from '../../contracts/erc20';
import { useMyOffersFull } from '../../data/hooks';
import { readSaleVehicleOfferIds, useAmendSource } from '../../data/desk';
import { useAllowanceForPlan } from '../../lib/submitProgress';
import { EmptyState, UnavailableState } from '../EmptyState';
import { AssetType } from '../../lib/types';
import { captureTxError, isPlainDecimal } from '../../lib/errors';
import { percentToBps, MAX_INTEREST_BPS } from '../../lib/offerSchema';
import {
  exactAmountString,
  formatBpsAsPercent,
  formatDate,
  formatDurationDays,
  formatTokenAmount,
  shortAddress,
} from '../../lib/format';
import type { IndexedOffer } from '../../data/indexer';

const text = copy.desk.orders;

/** Percent-string → bps for the amend inputs; `null` = unparseable.
 *  Gated on the same strict decimal shape the OrderTicket's inputs
 *  use — `percentToBps` is parseFloat-backed, so without the gate
 *  '11abc' / '5%' silently become 11% / 5%. */
function pctToBpsStrict(s: string): number | null {
  if (!isPlainDecimal(s)) return null;
  const bps = percentToBps(s);
  if (bps === null || bps < 0 || bps > MAX_INTEREST_BPS) return null;
  return bps;
}

function AmendForm({
  offer,
  onDone,
}: {
  offer: IndexedOffer;
  onDone: () => void;
}) {
  const { address, walletChain, onSupportedChain } = useActiveChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const { write } = useDiamondWrite();
  const queryClient = useQueryClient();
  const source = useAmendSource(offer.offerId);
  const lendingMeta = useTokenMeta(offer.lendingAsset);
  const collateralMeta = useTokenMeta(offer.collateralAsset);

  // String form state, seeded once the live source lands.
  const [fields, setFields] = useState<{
    seededFor: number;
    amount: string;
    amountMax: string;
    rate: string;
    rateMax: string;
    collateral: string;
    collateralMax: string;
  } | null>(null);
  const [busy, setBusy] = useState<'approve' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const lendDec = lendingMeta.data?.decimals;
  const collDec = collateralMeta.data?.decimals;

  if (
    fields === null &&
    source.data !== undefined &&
    lendDec !== undefined &&
    collDec !== undefined
  ) {
    const s = source.data;
    setFields({
      seededFor: offer.offerId,
      amount: exactAmountString(s.amount, lendDec),
      amountMax: exactAmountString(s.amountMax, lendDec),
      rate: String(s.interestRateBps / 100),
      rateMax: String(s.interestRateBpsMax / 100),
      collateral: exactAmountString(s.collateralAmount, collDec),
      collateralMax: exactAmountString(s.collateralAmountMax, collDec),
    });
  }

  // Strict decimal gate — the same `isPlainDecimal` rule the
  // OrderTicket's inputs enforce. viem's parseUnits throws on letters
  // (fail closed already) but ACCEPTS a leading minus, and the rate
  // fields are parseFloat-backed — so '-5' / '11abc' / '5%' must be
  // rejected here, not silently coerced. Amount-style fields may be
  // empty (the parser below treats empty as '0').
  const malformed =
    fields !== null &&
    ![
      fields.amount || '0',
      fields.amountMax || '0',
      fields.collateral || '0',
      fields.collateralMax || '0',
      fields.rate,
      fields.rateMax,
    ].every(isPlainDecimal);

  /** Parse the form back into `OfferModifyParams`; null while invalid. */
  const parsed = useMemo(() => {
    if (!fields || malformed || lendDec === undefined || collDec === undefined) {
      return null;
    }
    try {
      const amount = parseUnits(fields.amount || '0', lendDec);
      const amountMax = parseUnits(fields.amountMax || '0', lendDec);
      const rate = pctToBpsStrict(fields.rate);
      const rateMax = pctToBpsStrict(fields.rateMax);
      const collateral = parseUnits(fields.collateral || '0', collDec);
      const collateralMax = parseUnits(fields.collateralMax || '0', collDec);
      if (rate === null || rateMax === null) return null;
      return {
        amount,
        amountMax,
        interestRateBps: BigInt(rate),
        interestRateBpsMax: BigInt(rateMax),
        collateralAmount: collateral,
        collateralAmountMax: collateralMax,
      };
    } catch {
      return null;
    }
  }, [fields, malformed, lendDec, collDec]);

  const src = source.data;
  const changed =
    parsed !== null &&
    src !== undefined &&
    (parsed.amount !== src.amount ||
      parsed.amountMax !== src.amountMax ||
      Number(parsed.interestRateBps) !== src.interestRateBps ||
      Number(parsed.interestRateBpsMax) !== src.interestRateBpsMax ||
      parsed.collateralAmount !== src.collateralAmount ||
      parsed.collateralAmountMax !== src.collateralAmountMax);

  // Client-side mirror of the contract invariants that would waste a
  // transaction: min ≤ max per cluster, and the max amount can't drop
  // below what's already filled.
  const invalid =
    parsed !== null &&
    src !== undefined &&
    (parsed.amount > parsed.amountMax ||
      parsed.interestRateBps > parsed.interestRateBpsMax ||
      parsed.collateralAmount > parsed.collateralAmountMax ||
      parsed.amountMax < src.amountFilled);

  // GROW detection — the escrowed leg per side (#193 settle helpers):
  // lender ERC-20 pre-vaults `amountMax` in the lending asset;
  // borrower ERC-20 pre-vaults `collateralAmountMax` in the
  // collateral asset. The contract pulls exactly the positive delta.
  const growInfo = useMemo((): {
    token: `0x${string}`;
    delta: bigint;
    symbol: string | undefined;
    decimals: number | undefined;
  } | null => {
    if (!parsed || !src) return null;
    if (src.offerType === 0) {
      const delta = parsed.amountMax - src.amountMax;
      return delta > 0n
        ? {
            token: src.lendingAsset as `0x${string}`,
            delta,
            symbol: lendingMeta.data?.symbol,
            decimals: lendDec,
          }
        : null;
    }
    const delta = parsed.collateralAmountMax - src.collateralAmountMax;
    return delta > 0n
      ? {
          token: src.collateralAsset as `0x${string}`,
          delta,
          symbol: collateralMeta.data?.symbol,
          decimals: collDec,
        }
      : null;
  }, [parsed, src, lendingMeta.data, collateralMeta.data, lendDec, collDec]);

  const allowance = useAllowanceForPlan({
    chainId: walletChain?.chainId,
    token: growInfo?.token,
    owner: address as `0x${string}` | undefined,
    spender: walletChain?.diamondAddress,
  });
  const needsApproval =
    growInfo !== null &&
    allowance.data !== undefined &&
    allowance.data < growInfo.delta;
  // Allowance unknown on a grow → hold Save (fail closed) until read.
  const allowanceKnown = growInfo === null || allowance.data !== undefined;

  async function approve() {
    if (!growInfo || !address || !walletChain || !walletClient || !publicClient) {
      return;
    }
    setBusy('approve');
    setError(null);
    try {
      await ensureAllowance({
        publicClient,
        walletClient,
        token: growInfo.token,
        owner: address,
        spender: walletChain.diamondAddress,
        amount: growInfo.delta,
      });
      await allowance.refetch();
    } catch (err) {
      setError(captureTxError(err));
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (!parsed || !changed || invalid) return;
    setBusy('save');
    setError(null);
    try {
      await write('modifyOffer', [BigInt(offer.offerId), parsed]);
      void queryClient.invalidateQueries({ queryKey: ['myOffers'] });
      void queryClient.invalidateQueries({ queryKey: ['activeOffers'] });
      void queryClient.invalidateQueries({ queryKey: ['deskBook'] });
      void queryClient.invalidateQueries({ queryKey: ['deskMarkets'] });
      void queryClient.invalidateQueries({
        queryKey: ['deskAmendSource', walletChain?.chainId, offer.offerId],
      });
      onDone();
    } catch (err) {
      setError(captureTxError(err));
    } finally {
      setBusy(null);
    }
  }

  if (source.isError) {
    return (
      <div className="card" style={{ marginTop: 8 }}>
        <p className="muted">{text.amendLoadFailed}</p>
      </div>
    );
  }
  if (!fields || !src) {
    return (
      <div className="card" style={{ marginTop: 8 }}>
        <p className="muted cluster" style={{ alignItems: 'center', gap: 6 }}>
          <LoaderCircle size={14} className="spin" aria-hidden /> Reading the
          offer’s live values…
        </p>
      </div>
    );
  }

  const setField = (key: keyof NonNullable<typeof fields>, value: string) =>
    setFields((f) => (f ? { ...f, [key]: value.trim() } : f));

  const inputs: readonly [keyof NonNullable<typeof fields>, string, string][] = [
    ['amount', text.amendMinAmount, lendingMeta.data?.symbol ?? ''],
    ['amountMax', text.amendMaxAmount, lendingMeta.data?.symbol ?? ''],
    ['rate', text.amendRate, 'bps stored on-chain'],
    ['rateMax', text.amendRateMax, 'bps stored on-chain'],
    ['collateral', text.amendCollateral, collateralMeta.data?.symbol ?? ''],
    ['collateralMax', text.amendCollateralMax, collateralMeta.data?.symbol ?? ''],
  ];

  return (
    <div className="card" style={{ marginTop: 8 }}>
      <p className="muted" style={{ marginBottom: 8, fontSize: '0.85rem' }}>
        {text.amendTitle}
      </p>
      <div className="desk-amend-grid">
        {inputs.map(([key, label, unit]) => (
          <div className="field" style={{ margin: 0 }} key={key}>
            <label htmlFor={`amend-${offer.offerId}-${key}`}>{label}</label>
            <input
              id={`amend-${offer.offerId}-${key}`}
              className="input"
              inputMode="decimal"
              title={unit}
              value={fields[key] as string}
              onChange={(e) => setField(key, e.target.value)}
            />
          </div>
        ))}
      </div>

      {malformed ? (
        <p style={{ color: 'var(--danger)', fontSize: '0.85rem', marginTop: 8 }}>
          {text.amendMalformed}
        </p>
      ) : null}
      {invalid ? (
        <p style={{ color: 'var(--danger)', fontSize: '0.85rem', marginTop: 8 }}>
          {text.amendInvalid}
        </p>
      ) : null}
      {growInfo && growInfo.decimals !== undefined ? (
        <p className="muted" style={{ fontSize: '0.85rem', marginTop: 8 }}>
          {text.amendGrowNote(
            formatTokenAmount(growInfo.delta, growInfo.decimals),
            growInfo.symbol ?? shortAddress(growInfo.token),
          )}
        </p>
      ) : null}
      {error ? (
        <p style={{ color: 'var(--danger)', fontSize: '0.85rem', marginTop: 8 }}>
          {error}
        </p>
      ) : null}

      <div className="cluster" style={{ marginTop: 12 }}>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={onDone}
          disabled={busy !== null}
        >
          Close
        </button>
        {needsApproval ? (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy !== null || !onSupportedChain}
            onClick={() => void approve()}
          >
            {busy === 'approve' ? text.approving : text.approveFirst}
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-primary btn-sm"
          style={{ flex: 1 }}
          disabled={
            busy !== null ||
            !onSupportedChain ||
            !changed ||
            invalid ||
            !allowanceKnown ||
            needsApproval
          }
          title={!changed ? text.amendNoChange : undefined}
          onClick={() => void save()}
        >
          {busy === 'save' ? text.saving : text.save}
        </button>
      </div>
    </div>
  );
}

function OrderRow({ offer }: { offer: IndexedOffer }) {
  const { address, onSupportedChain } = useActiveChain();
  const { write } = useDiamondWrite();
  const queryClient = useQueryClient();
  const meta = useTokenMeta(offer.lendingAsset);
  const [amending, setAmending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isCreator =
    Boolean(address) && offer.creator.toLowerCase() === address!.toLowerCase();
  const isLending = offer.offerType === 0;
  const rateBps = isLending ? offer.interestRateBps : offer.interestRateBpsMax;
  const filled = BigInt(offer.amountFilled || '0');
  const max = BigInt(offer.amountMax || '0');
  const filledPct = max > 0n ? Number((filled * 100n) / max) : 0;

  async function cancel() {
    setCancelling(true);
    setError(null);
    try {
      await write('cancelOffer', [BigInt(offer.offerId)]);
      void queryClient.invalidateQueries({ queryKey: ['myOffers'] });
      void queryClient.invalidateQueries({ queryKey: ['activeOffers'] });
      void queryClient.invalidateQueries({ queryKey: ['deskBook'] });
      void queryClient.invalidateQueries({ queryKey: ['deskMarkets'] });
    } catch (err) {
      setError(captureTxError(err));
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div>
      <div className="item-row">
        <span className="row-main">
          <span className="row-title">
            {isLending ? copy.offers.lenderOffer : copy.offers.borrowerOffer} ·{' '}
            <span title={`${rateBps} bps`}>{formatBpsAsPercent(rateBps)}</span> ·{' '}
            {meta.data ? formatTokenAmount(offer.amountMax, meta.data.decimals) : '…'}{' '}
            {meta.data?.symbol ?? ''}
          </span>
          <br />
          <span className="row-sub">
            #{offer.offerId} · {formatDurationDays(offer.durationDays)} ·{' '}
            {offer.expiresAt
              ? `expires ${formatDate(offer.expiresAt)}`
              : 'no expiry'}
            {filled > 0n && meta.data
              ? ` · filled ${formatTokenAmount(filled, meta.data.decimals)} (${filledPct}%)`
              : ''}
          </span>
          {filled > 0n ? (
            <span
              className="desk-fill-bar"
              title={`${filledPct}% filled`}
              role="img"
              aria-label={`${filledPct}% filled`}
            >
              <span style={{ width: `${Math.min(filledPct, 100)}%` }} />
            </span>
          ) : null}
          {error ? (
            <>
              <br />
              <span className="row-sub" style={{ color: 'var(--danger)' }}>
                {error}
              </span>
            </>
          ) : null}
        </span>
        {isCreator ? (
          <span className="cluster" style={{ gap: 8 }}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              title={text.amendTitle}
              onClick={() => setAmending((a) => !a)}
            >
              <Pencil size={14} aria-hidden /> {text.amend}
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={!onSupportedChain || cancelling}
              onClick={() => void cancel()}
            >
              {cancelling ? text.cancelling : text.cancel}
            </button>
          </span>
        ) : (
          <span className="badge badge-neutral">{text.heldNotCreated}</span>
        )}
      </div>
      {amending && isCreator ? (
        <AmendForm offer={offer} onDone={() => setAmending(false)} />
      ) : null}
    </div>
  );
}

export function OpenOrdersPanel() {
  const offers = useMyOffersFull();
  const { isConnected, readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });

  // Desk scope: ERC-20/ERC-20 rate offers only — NFT/rental listings
  // stay on their own pages.
  const erc20Rows = useMemo(
    () =>
      offers.data?.rows.filter(
        (o) =>
          o.assetType === AssetType.ERC20 &&
          o.collateralAssetType === AssetType.ERC20,
      ) ?? null,
    [offers.data],
  );

  // Lender-sale vehicles never belong here — the sale is managed from
  // its own surface, and OfferMutateFacet._assertMutableBy reverts
  // SaleVehicleImmutable, so an Amend button on one only mints a
  // doomed transaction. Indexer-sourced rows carry `isSaleVehicle`;
  // rows without the field (chain-sourced, or an older worker) get
  // the same batched getOfferLinkedLoanId read the desk book uses.
  // Only borrower-style rows can be sale vehicles. Fails open (rows
  // kept) while the read is in flight or when it errors.
  const unflagged = useMemo(
    () =>
      (erc20Rows ?? []).filter(
        (o) => o.offerType === 1 && o.isSaleVehicle === undefined,
      ),
    [erc20Rows],
  );
  const saleCheck = useQuery({
    queryKey: [
      'deskOrdersSaleVehicles',
      readChain.chainId,
      unflagged.map((o) => o.offerId),
    ],
    enabled: unflagged.length > 0 && Boolean(publicClient),
    queryFn: () =>
      readSaleVehicleOfferIds(publicClient!, readChain.diamondAddress, unflagged),
  });
  const rows = useMemo(() => {
    if (erc20Rows === null) return null;
    return erc20Rows.filter(
      (o) =>
        o.isSaleVehicle !== true && saleCheck.data?.has(o.offerId) !== true,
    );
  }, [erc20Rows, saleCheck.data]);

  if (!isConnected) {
    return <EmptyState icon={Inbox} title={copy.wallet.connectFirst} />;
  }
  if (offers.isLoading) {
    return <EmptyState icon={LoaderCircle} title="Loading your open orders…" />;
  }
  if (offers.data == null || rows === null) {
    return <UnavailableState body={text.unavailable} />;
  }
  if (rows.length === 0) {
    return <EmptyState icon={Inbox} title={text.empty} />;
  }
  return (
    <div className="row-list">
      {rows.map((o) => (
        <OrderRow key={o.offerId} offer={o} />
      ))}
    </div>
  );
}
