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
import { useEffect, useMemo, useState } from 'react';
import { Inbox, LoaderCircle, Pencil } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePublicClient, useWalletClient } from 'wagmi';
import { parseUnits } from 'viem';
import { copy } from '../../content/copy';
import { useActiveChain } from '../../chain/useActiveChain';
import { useDiamondWrite } from '../../contracts/diamond';
import { ensureAllowance, useTokenMeta } from '../../contracts/erc20';
import { CANCEL_COOLDOWN_SECONDS } from '../../contracts/loanLive';
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

/** Chain-time anchor for the cancel-cooldown gate: block.timestamp at
 *  fetch + the device stamp it was read at, so renders between polls
 *  can tick `nowSec + wall-elapsed` WITHOUT ever trusting the device
 *  clock as the base (same doctrine as refinancePending /
 *  loanSalePending — the facet judges the window on chain time). */
interface ChainNowAnchor {
  nowSec: number;
  atMs: number;
}

function anchorEffNow(anchor: ChainNowAnchor | undefined): number | null {
  if (!anchor) return null;
  return anchor.nowSec + Math.max(0, Math.floor((Date.now() - anchor.atMs) / 1000));
}

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
  // Contract-locked single-value shapes (Codex #1134 round-3): a
  // lender ERC-20 offer must keep `collateralAmountMax ==
  // collateralAmount` (LenderCollateralRangeNotAllowed), and an AON
  // offer must keep `amount == amountMax` — create enforces it
  // (AonRequiresSingleValueAmount) and the facet does NOT re-check on
  // modify, so a diverging amend would silently break the all-or-none
  // size semantics. Each pair renders as ONE field driving both.
  const isLenderRow = src?.offerType === 0;
  const isAon = src?.fillMode === 1;
  const changed =
    parsed !== null &&
    src !== undefined &&
    (parsed.amount !== src.amount ||
      parsed.amountMax !== src.amountMax ||
      Number(parsed.interestRateBps) !== src.interestRateBps ||
      Number(parsed.interestRateBpsMax) !== src.interestRateBpsMax ||
      parsed.collateralAmount !== src.collateralAmount ||
      parsed.collateralAmountMax !== src.collateralAmountMax);

  // Strictly-positive amounts — the facet's AmountMustBePositive /
  // AmountMaxMustBePositive fire on ANY amount mutation, and the
  // collateral pair mirrors _assertCollateralInvariants' strict rule
  // for ERC-20/ERC-20 rows (the only shape the desk lists) WITH its
  // one carve-out: an explicit both-zero collateral pair (the
  // no-collateral lender shape) stays valid; mixed zero/positive
  // never is.
  const nonPositive =
    parsed !== null &&
    (parsed.amount <= 0n ||
      parsed.amountMax <= 0n ||
      (!(parsed.collateralAmount === 0n && parsed.collateralAmountMax === 0n) &&
        (parsed.collateralAmount <= 0n || parsed.collateralAmountMax <= 0n)));

  // Client-side mirror of the contract invariants that would waste a
  // transaction: min ≤ max per cluster, neither ceiling below its
  // already-filled floor (ModifyBelowFilledFloor covers the borrower
  // collateral leg too), and the locked single-value pairs staying
  // equal (belt-and-suspenders — the UI drives both from one field).
  const invalid =
    parsed !== null &&
    src !== undefined &&
    (parsed.amount > parsed.amountMax ||
      parsed.interestRateBps > parsed.interestRateBpsMax ||
      parsed.collateralAmount > parsed.collateralAmountMax ||
      parsed.amountMax < src.amountFilled ||
      parsed.collateralAmountMax < src.collateralAmountFilled ||
      (isAon && parsed.amount !== parsed.amountMax) ||
      (isLenderRow && parsed.collateralAmountMax !== parsed.collateralAmount));

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
    if (!parsed || !changed || invalid || nonPositive) return;
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
    setFields((f) => {
      if (!f) return f;
      const v = value.trim();
      const next = { ...f, [key]: v };
      // Locked single-value pairs — one field drives both (see the
      // isLenderRow / isAon derivation above for the contract rules).
      if (key === 'amount' && isAon) next.amountMax = v;
      if (key === 'collateral' && isLenderRow) next.collateralMax = v;
      return next;
    });

  type AmendInput = [keyof NonNullable<typeof fields>, string, string];
  const inputs: readonly AmendInput[] = [
    [
      'amount',
      isAon ? text.amendAmountAon : text.amendMinAmount,
      lendingMeta.data?.symbol ?? '',
    ],
    // AON size is single-value — the min field above drives both.
    ...(isAon
      ? []
      : ([['amountMax', text.amendMaxAmount, lendingMeta.data?.symbol ?? '']] as AmendInput[])),
    ['rate', text.amendRate, 'bps stored on-chain'],
    ['rateMax', text.amendRateMax, 'bps stored on-chain'],
    ['collateral', text.amendCollateral, collateralMeta.data?.symbol ?? ''],
    // Lender collateral is single-value — the field above drives both.
    ...(isLenderRow
      ? []
      : ([
          ['collateralMax', text.amendCollateralMax, collateralMeta.data?.symbol ?? ''],
        ] as AmendInput[])),
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
      {nonPositive ? (
        <p style={{ color: 'var(--danger)', fontSize: '0.85rem', marginTop: 8 }}>
          {text.amendPositive}
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
            nonPositive ||
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
  const { address, onSupportedChain, readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
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

  // Cancel-cooldown gate (Codex #1134 round-3) — mirrors
  // OfferCancelFacet's exact CancelCooldownActive condition:
  // `partialFillEnabled && amountFilled == 0 && createdAt != 0 &&
  // block.timestamp < createdAt + MIN_OFFER_CANCEL_DELAY &&
  // !isOfferExpired(offer)` — so expired and partially-filled rows
  // keep the immediate cancel, exactly like the contract. The
  // `partialFillEnabled` protocol flag isn't surfaced client-side;
  // assuming it ON (it is, on every live deploy) costs at most a
  // five-minute wait on a deploy where the contract wouldn't enforce
  // one — strictly better than arming a doomed transaction. A row
  // without `createdAt` (older indexer worker) fails open: the chain-
  // sourced rows that normally feed this panel always carry it.
  const createdAt = offer.createdAt ?? 0;
  const cooldownDeadline = createdAt + Number(CANCEL_COOLDOWN_SECONDS);
  const rowExpiresAt =
    offer.expiresAt !== undefined && offer.expiresAt !== 0 ? offer.expiresAt : null;
  const cooldownBase = isCreator && filled === 0n && createdAt > 0;
  const blockedGiven = (nowSec: number | null): boolean =>
    cooldownBase &&
    (nowSec === null || // chain time unknown yet — hold (fail closed)
      (nowSec < cooldownDeadline &&
        !(rowExpiresAt !== null && nowSec >= rowExpiresAt)));

  // ONE shared anchor per chain (queryKey-deduped across rows), polled
  // only while this row might still be inside its window and stopped
  // the moment the anchor proves it elapsed — a parked desk tab must
  // not stream block reads (RPC-diet doctrine).
  const chainNowKey = ['deskChainNow', readChain.chainId];
  const cachedAnchor = queryClient.getQueryData<ChainNowAnchor>(chainNowKey);
  const chainNowQ = useQuery({
    queryKey: chainNowKey,
    enabled: Boolean(publicClient) && blockedGiven(anchorEffNow(cachedAnchor)),
    refetchInterval: 5_000,
    queryFn: async (): Promise<ChainNowAnchor> => {
      const block = await publicClient!.getBlock({ blockTag: 'latest' });
      return { nowSec: Number(block.timestamp), atMs: Date.now() };
    },
  });
  const effNow = anchorEffNow(chainNowQ.data ?? cachedAnchor);
  const cancelBlocked = blockedGiven(effNow);
  const cooldownRemaining =
    effNow === null
      ? Number(CANCEL_COOLDOWN_SECONDS)
      : Math.max(1, cooldownDeadline - effNow);

  // 1 s re-render tick while blocked, so the countdown title and the
  // enable flip track the anchored clock between polls.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!cancelBlocked) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1_000);
    return () => clearInterval(timer);
  }, [cancelBlocked]);

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
              disabled={!onSupportedChain || cancelling || cancelBlocked}
              title={
                cancelBlocked ? text.cancelCooldown(cooldownRemaining) : undefined
              }
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
