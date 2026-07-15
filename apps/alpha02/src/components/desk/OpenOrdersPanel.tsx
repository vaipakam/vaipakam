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
import { useEffect, useMemo, useRef, useState } from 'react';
import { Inbox, LoaderCircle, Pencil } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePublicClient, useWalletClient } from 'wagmi';
import { parseUnits } from 'viem';
import { copy } from '../../content/copy';
import { useActiveChain } from '../../chain/useActiveChain';
import { useDiamondWrite } from '../../contracts/diamond';
import { ensureAllowance, useTokenMeta } from '../../contracts/erc20';
import {
  assertAssetNotPausedLive,
  assertErc20BalanceLive,
  assertRowActionStillValid,
} from '../../contracts/preflights';
import { assertWalletNotSanctionedLive } from '../../data/sanctions';
import { CANCEL_COOLDOWN_SECONDS } from '../../contracts/loanLive';
import { useMyOffersFull } from '../../data/hooks';
import {
  readLinkedOfferIds,
  useAmendSource,
  useDeskSignedBook,
  type DeskPair,
} from '../../data/desk';
import {
  signedOfferRemaining,
  signedOfferTypedMessage,
  type SignedOrderWire,
} from '../../lib/signedOffer';
import type { IndexedSignedOffer } from '../../data/indexer';
import { readAllowance, useAllowanceForPlan } from '../../lib/submitProgress';
import { EmptyState, UnavailableState } from '../EmptyState';
import { AssetType } from '../../lib/types';
import { captureTxError, isPlainDecimal } from '../../lib/errors';
import { WindowedRowList } from '../../lib/visibleWindow';
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

/** UX-046 — an HONEST fill-percent label: integer division truncated
 *  (99.6% → "99%", 0.4% → "0%" beside a visible bar). Round to a whole
 *  percent, and guard both extremes so a partially-filled order never
 *  reads as 0% or 100%: a non-zero fill that rounds to 0 shows "<1%",
 *  and a not-yet-complete fill that rounds to 100 shows "99%+". */
function fillPctLabel(filled: bigint, max: bigint): string {
  if (max <= 0n) return '0%';
  if (filled >= max) return '100%';
  const pct = Number((filled * 10000n) / max) / 100; // 2-dp, floored
  const rounded = Math.round(pct);
  if (filled > 0n && rounded === 0) return '<1%';
  if (rounded >= 100) return '99%+';
  return `${rounded}%`;
}

/** Bar width as a real percentage (never rounded to 0/100), so the meter
 *  matches the label's honesty — a nearly-full order shows a nearly-full
 *  bar even when the label reads "99%+". */
function fillBarPct(filled: bigint, max: bigint): number {
  if (max <= 0n) return 0;
  return Math.min(Number((filled * 10000n) / max) / 100, 100);
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
  // no-collateral LENDER shape) stays valid; mixed zero/positive
  // never is. The carve-out is lender-side ONLY (Codex #1134
  // round-4 P2): a BORROWER row zeroing both collateral fields would
  // have the modify path refund the borrower's escrowed collateral
  // and leave an active borrow order with no lock — borrower rows
  // require strictly positive collateral + collateralMax.
  const nonPositive =
    parsed !== null &&
    (parsed.amount <= 0n ||
      parsed.amountMax <= 0n ||
      (!(
        isLenderRow &&
        parsed.collateralAmount === 0n &&
        parsed.collateralAmountMax === 0n
      ) &&
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

  /** Mirror of the OrderTicket submit preflights, scoped to the amend
   *  (Codex #1134 round-6 P2): `modifyOffer`'s `_assertMutableBy` gate
   *  screens the caller for sanctions and requires BOTH legs unpaused
   *  on every mutation, and a GROW additionally pulls the delta from
   *  the wallet — so all three facts must be re-checked LIVE before
   *  the "Approve first" transaction can spend allowance gas, and
   *  again before the save (they can go stale while the approval
   *  mines). Balance check is scoped to the grow delta asset+amount;
   *  same failure copy as the ticket (the helpers throw the friendly
   *  messages). */
  async function runAmendPreflights(): Promise<void> {
    if (!address || !walletChain || !publicClient || !src) return;
    await assertWalletNotSanctionedLive(
      publicClient,
      walletChain.diamondAddress,
      address,
    );
    const checks: Promise<void>[] = [
      assertAssetNotPausedLive({
        publicClient,
        diamondAddress: walletChain.diamondAddress,
        asset: src.lendingAsset as `0x${string}`,
      }),
      assertAssetNotPausedLive({
        publicClient,
        diamondAddress: walletChain.diamondAddress,
        asset: src.collateralAsset as `0x${string}`,
      }),
    ];
    if (growInfo) {
      checks.push(
        assertErc20BalanceLive({
          publicClient,
          token: growInfo.token,
          owner: address,
          amount: growInfo.delta,
          symbol: growInfo.symbol,
        }),
      );
    }
    await Promise.all(checks);
  }

  async function approve() {
    // Same validity gates as Save (Codex #1134 round-7 P2): a grow
    // with an otherwise-invalid shape (lender raising `amountMax`
    // while setting `amount > amountMax`, or zeroing a required
    // amount) still computes a positive delta, so `needsApproval`
    // can be true while Save is disabled — without this gate the
    // Approve button would spend an approval transaction on an
    // amend the UI already knows cannot be saved.
    if (invalid || nonPositive) return;
    if (!growInfo || !address || !walletChain || !walletClient || !publicClient) {
      return;
    }
    setBusy('approve');
    setError(null);
    try {
      // Preflights BEFORE the allowance transaction — approval gas
      // must never be spent on an amend modifyOffer will reject.
      await runAmendPreflights();
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
      // Last look — the same facts re-checked after any approval
      // mined and immediately before the state-changing write.
      await runAmendPreflights();
      // Grow allowance last look (Codex #1134 round-7 P2): the cached
      // `useAllowanceForPlan` read that armed Save can go stale — the
      // user can spend or revoke the Diamond allowance after the
      // Approve step, and `modifyOffer` would then revert inside its
      // delta pull AFTER gas is spent. Re-read live immediately before
      // the write; on a shortfall re-arm the explicit Approve-first
      // step (this form's two-step UX) instead of silently minting a
      // second wallet transaction inside Save. An unreadable allowance
      // fails closed the same way.
      if (growInfo) {
        if (!address || !walletChain || !publicClient) return;
        const live = await readAllowance({
          publicClient,
          token: growInfo.token,
          owner: address,
          spender: walletChain.diamondAddress,
        });
        if (live === undefined || live < growInfo.delta) {
          void allowance.refetch();
          throw new Error(text.amendAllowanceLost);
        }
      }
      // RPC read-diet PR A (§4.1.2) — same blocking row-action
      // preflight as cancel: an amend against a just-consumed offer
      // surfaces inline instead of as a doomed signature.
      if (publicClient && address && walletChain) {
        await assertRowActionStillValid({
          publicClient,
          diamond: walletChain.diamondAddress,
          account: address,
          functionName: 'modifyOffer',
          args: [BigInt(offer.offerId), parsed],
        });
      }
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
            // Mirrors Save's validity gates (Codex #1134 round-7 P2) —
            // approval gas must never be spent while the form is in a
            // shape Save itself refuses.
            disabled={busy !== null || !onSupportedChain || invalid || nonPositive}
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
  const remaining = max > filled ? max - filled : 0n;
  const fillLabel = fillPctLabel(filled, max);
  const barPct = fillBarPct(filled, max);

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
  // RPC read-diet PR A (§4.1.3): the old shape polled this anchor
  // every 5s. A clock mostly needs an offset: the countdown runs on
  // the offset-corrected local clock between reads, with a SLOW 15s
  // re-check while (and only while) a row is actually inside its
  // ≤5-minute window — chain time can JUMP relative to wall time
  // (anvil time travel in the fork harness; sequencer drift), and a
  // pure one-shot anchor would then hold Cancel disabled long after
  // the chain unlocked it (the fork-tier spec 17 run proved exactly
  // that). Bounded: at most ~20 reads per posted offer vs ~60 before,
  // and ZERO once no own row is inside a cooldown window.
  const chainNowKey = ['deskChainNow', readChain.chainId];
  const cachedAnchor = queryClient.getQueryData<ChainNowAnchor>(chainNowKey);
  const chainNowQ = useQuery({
    queryKey: chainNowKey,
    enabled: Boolean(publicClient) && blockedGiven(anchorEffNow(cachedAnchor)),
    refetchInterval: 15_000,
    queryFn: async (): Promise<ChainNowAnchor> => {
      const block = await publicClient!.getBlock({ blockTag: 'latest' });
      return { nowSec: Number(block.timestamp), atMs: Date.now() };
    },
  });
  const anchor = chainNowQ.data ?? cachedAnchor;
  const effNow = anchorEffNow(anchor);
  // FAIL-CLOSED enable (§4.1.3): the button unlocks only on a RAW
  // chain-read timestamp (`anchor.nowSec` is a lower bound of chain
  // time — time only moves forward), never on the extrapolated clock
  // alone. A device clock running ahead can therefore never enable
  // Cancel early and hand the user a doomed CancelCooldownActive
  // transaction; the extrapolated clock only drives the countdown
  // display and decides WHEN to spend the confirm read.
  const rawNow = anchor ? anchor.nowSec : null;
  const cancelBlocked = blockedGiven(rawNow);
  const cooldownRemaining =
    effNow === null
      ? Number(CANCEL_COOLDOWN_SECONDS)
      : Math.max(1, cooldownDeadline - effNow);

  // 1 s re-render tick while blocked, so the countdown title tracks
  // the anchored clock — and the confirm effect below sees the
  // extrapolated clock cross the unlock boundary.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!cancelBlocked) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1_000);
    return () => clearInterval(timer);
  }, [cancelBlocked]);

  // The boundary confirm: when the corrected countdown says the
  // window elapsed but the last RAW read hasn't proven it, spend one
  // refetch so the unlock lands within ~a second of the real boundary
  // instead of at the next 15s re-check. Throttled to one attempt per
  // 10s: a failed or still-early confirm must not turn each 1s tick
  // render into another refetch (Codex #1228 r2). Actual fill/cancel
  // state changes still arrive via the offer.changed push nudge.
  const confirmTriedAtRef = useRef(0);
  useEffect(() => {
    if (!cancelBlocked || chainNowQ.isFetching) return;
    if (effNow === null || blockedGiven(effNow)) return;
    const now = Date.now();
    if (now - confirmTriedAtRef.current < 10_000) return;
    confirmTriedAtRef.current = now;
    void chainNowQ.refetch();
  });

  async function cancel() {
    setCancelling(true);
    setError(null);
    try {
      // RPC read-diet PR A (§4.1.2) — this row refreshes at push
      // latency, not tip parity, so a counterparty may have consumed
      // the offer moments ago: simulate the exact call BEFORE the
      // wallet prompt (revert → inline reason, transport → fail open).
      if (publicClient && address) {
        await assertRowActionStillValid({
          publicClient,
          diamond: readChain.diamondAddress,
          account: address,
          functionName: 'cancelOffer',
          args: [BigInt(offer.offerId)],
        });
      }
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
              ? ` · filled ${formatTokenAmount(filled, meta.data.decimals)} (${fillLabel}) · ${formatTokenAmount(remaining, meta.data.decimals)} left`
              : ''}
          </span>
          {filled > 0n ? (
            <span
              className="desk-fill-bar"
              title={`${fillLabel} filled`}
              role="img"
              aria-label={`${fillLabel} filled`}
            >
              <span style={{ width: `${barPct}%` }} />
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

/**
 * The wallet's own GASLESS signed orders for the SELECTED market
 * (#1131 slice D). Deliberately market-scoped where the on-chain rows
 * above are market-agnostic (created ∪ holder): the signed book's only
 * query surface is the market-scoped `GET /signed-offers`, so a
 * cross-market "all my signed orders" list would need a by-signer
 * route the worker doesn't expose yet — the honest v1 lists the
 * selected market and SAYS so (`copy.desk.orders.signedNote`).
 *
 * Cancel is the on-chain `cancelSignedOffer(order)` — the ONLY way to
 * revoke a signature the book already holds (an off-chain delete would
 * merely hide it; anyone who saved the row could still fill it). The
 * copy explains that this costs gas, unlike posting.
 *
 * Rendering rule: the block appears only when the wallet HAS signed
 * rows in this market. Empty and unavailable both render nothing — the
 * block never claims "no signed orders", so the silence stays honest,
 * and an older worker without the /signed-offers route doesn't pin a
 * permanent error line into every desk visit.
 */
function SignedOrdersBlock({
  pair,
  days,
}: {
  pair: DeskPair | null;
  days: number;
}) {
  const { address, onSupportedChain, readChain: signedReadChain } = useActiveChain();
  // #1247 PAG-011 — signer-scoped: own orders must never be clipped
  // out of the capped shared book by other makers' depth.
  const signedBook = useDeskSignedBook(pair, days, address ?? undefined);
  const queryClient = useQueryClient();
  const { write } = useDiamondWrite();
  const [busyHash, setBusyHash] = useState<string | null>(null);
  const [error, setError] = useState<{ hash: string; msg: string } | null>(null);
  // Codex #1145 round-4 P3 — an APPEND-ONLY set of successfully
  // cancelled order hashes (never cleared when another row's cancel
  // starts): with two own rows still in the cached book, clearing a
  // single-hash state on the next cancel would re-show row A's button
  // and let the same idempotent cancelSignedOffer mine twice.
  const [cancelledHashes, setCancelledHashes] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const me = address?.toLowerCase();
  const own = useMemo(
    () =>
      (signedBook.data?.offers ?? []).filter(
        (r) => me !== undefined && r.signer.toLowerCase() === me,
      ),
    [signedBook.data, me],
  );
  // Codex #1269 r2 — the signer-scoped read is still per-side capped;
  // a maker with >100 own orders on one side gets a clipped page and
  // must not read it as "all your signed orders".
  const ownTruncated = signedBook.data?.truncated === true;

  const lendingMeta = useTokenMeta(pair?.lendingAsset);

  if (own.length === 0) return null;

  async function cancel(row: IndexedSignedOffer) {
    setBusyHash(row.orderHash);
    setError(null);
    try {
      await write('cancelSignedOffer', [signedOfferTypedMessage(row.order)]);
      setCancelledHashes((prev) => new Set(prev).add(row.orderHash));
      void queryClient.invalidateQueries({ queryKey: ['deskSignedBook'] });
      // Cancelling the market's last/best signed row changes
      // /offers/markets (it unions active signed rows) — refresh the
      // pair/tenor chips now, mirroring the gasless-post path (Codex
      // #1145 r8 P3).
      void queryClient.invalidateQueries({ queryKey: ['deskMarkets'] });
    } catch (err) {
      setError({ hash: row.orderHash, msg: captureTxError(err) });
    } finally {
      setBusyHash(null);
    }
  }

  const rateOf = (o: SignedOrderWire): number =>
    Number(o.offerType) === 0
      ? Number(o.interestRateBps)
      : Number(o.interestRateBpsMax);

  return (
    <div style={{ marginTop: 16 }}>
      <p style={{ margin: '0 0 4px', fontWeight: 600 }}>{text.signedTitle}</p>
      <p className="muted" style={{ margin: '0 0 8px', fontSize: '0.8rem' }}>
        {text.signedNote} {text.signedCancelNote}
      </p>
      {ownTruncated ? (
        // Codex #1269 r2 — the signer-scoped read is per-side capped at
        // 100; a clipped page must never read as "all your orders".
        <p className="muted" style={{ margin: '0 0 8px', fontSize: '0.8rem' }}>
          {text.signedTruncated}
        </p>
      ) : null}
      {/* #1247 PAG-005 — same window as the on-chain block (the
          server slice bounds this at 100/side, but the pattern stays
          uniform and the DOM stays a page at a time). */}
      <WindowedRowList
        rows={own}
        resetKey={`${signedReadChain.chainId}|${address?.toLowerCase() ?? ''}|${pair ? `${pair.lendingAsset}-${pair.collateralAsset}` : ''}|${days}`}
        render={(row) => {
          const remaining = signedOfferRemaining(row.order, row.filledAmount);
          return (
            <div className="item-row" key={row.orderHash}>
              <span className="row-main">
                <span className="row-title">
                  {Number(row.order.offerType) === 0
                    ? copy.offers.lenderOffer
                    : copy.offers.borrowerOffer}{' '}
                  ·{' '}
                  <span title={`${rateOf(row.order)} bps`}>
                    {formatBpsAsPercent(rateOf(row.order))}
                  </span>{' '}
                  ·{' '}
                  {lendingMeta.data
                    ? formatTokenAmount(remaining, lendingMeta.data.decimals)
                    : '…'}{' '}
                  {lendingMeta.data?.symbol ?? ''}
                  <span
                    className="desk-signed-chip"
                    style={{ marginLeft: 8 }}
                    title={copy.desk.signed.badgeTooltip}
                  >
                    {copy.desk.signed.badge}
                  </span>
                </span>
                <br />
                <span className="row-sub">
                  {shortAddress(row.orderHash)} ·{' '}
                  {formatDurationDays(Number(row.order.durationDays))} ·{' '}
                  {row.expiresAt
                    ? `expires ${formatDate(row.expiresAt)}`
                    : 'no expiry'}
                </span>
                {cancelledHashes.has(row.orderHash) ? (
                  <>
                    <br />
                    <span className="row-sub" style={{ color: 'var(--ok)' }}>
                      {text.signedCancelled}
                    </span>
                  </>
                ) : null}
                {error && error.hash === row.orderHash ? (
                  <>
                    <br />
                    <span className="row-sub" style={{ color: 'var(--danger)' }}>
                      {error.msg}
                    </span>
                  </>
                ) : null}
              </span>
              {/* Codex #1145 round-3 P3 — once THIS row's cancel
                  succeeded, hide the button until the cached
                  /signed-offers query drops the row:
                  `cancelSignedOffer` doesn't reject an already-
                  cancelled order, so a second click during the
                  cache/indexer catch-up window would mine a second,
                  pointless cancellation and burn gas. Membership in
                  the append-only set — see cancelledHashes above. */}
              {cancelledHashes.has(row.orderHash) ? null : (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={!onSupportedChain || busyHash !== null}
                  title={text.signedCancelNote}
                  onClick={() => void cancel(row)}
                >
                  {busyHash === row.orderHash
                    ? text.signedCancelling
                    : text.signedCancel}
                </button>
              )}
            </div>
          );
        }}
      />
    </div>
  );
}

export function OpenOrdersPanel({
  pair,
  days,
}: {
  /** The desk's selected market — scopes the signed-orders block ONLY
   *  (the on-chain list stays market-agnostic, as before). */
  pair: DeskPair | null;
  days: number;
}) {
  const offers = useMyOffersFull();
  const { isConnected, address, readChain } = useActiveChain();
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

  // Linked vehicles never belong here — a borrower-style lender-sale
  // vehicle (`saleOfferToLoanId`) or a lender-style Preclose Option-3
  // offset vehicle (`offsetOfferToLoanId`, Codex #1134 round-4 P3) is
  // managed from its own surface, and OfferMutateFacet._assertMutableBy
  // reverts SaleVehicleImmutable / OffsetVehicleImmutable, so an Amend
  // button on one only mints a doomed transaction. Both worker flags
  // (`isSaleVehicle` / `isOffsetVehicle`) drop the row IMMEDIATELY in
  // the filter below (Codex #1134 round-6 P2 — honoring the offset
  // flag only via the RPC linked-check left a worker-flagged offset
  // vehicle showing Amend/Cancel while that batch loads or after it
  // fails). The batched getOfferLinkedLoanId probe stays as the
  // authoritative backstop: lender rows are ALWAYS probed (an older
  // worker omits `isOffsetVehicle`), and borrower rows are probed when
  // `isSaleVehicle` is absent (chain-sourced, or an older worker).
  // The probe fails open (rows kept) while in flight or on error.
  const unflagged = useMemo(
    () =>
      (erc20Rows ?? []).filter(
        (o) => o.offerType === 0 || o.isSaleVehicle === undefined,
      ),
    [erc20Rows],
  );
  const linkedCheck = useQuery({
    queryKey: [
      'deskOrdersLinkedOffers',
      readChain.chainId,
      unflagged.map((o) => o.offerId),
    ],
    enabled: unflagged.length > 0 && Boolean(publicClient),
    queryFn: () =>
      readLinkedOfferIds(publicClient!, readChain.diamondAddress, unflagged),
  });
  const rows = useMemo(() => {
    if (erc20Rows === null) return null;
    return erc20Rows.filter(
      (o) =>
        o.isSaleVehicle !== true &&
        o.isOffsetVehicle !== true &&
        linkedCheck.data?.has(o.offerId) !== true,
    );
  }, [erc20Rows, linkedCheck.data]);

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
    return (
      <>
        <EmptyState icon={Inbox} title={text.empty} />
        <SignedOrdersBlock pair={pair} days={days} />
      </>
    );
  }
  return (
    <>
      {/* #1247 PAG-005 — a market-maker wallet can hold hundreds of
          open orders (data caps allow 500–2000); render a page at a
          time. */}
      <WindowedRowList
        rows={rows}
        resetKey={`${readChain.chainId}|${address?.toLowerCase() ?? ''}|${pair ? `${pair.lendingAsset}-${pair.collateralAsset}` : ''}|${days}`}
        render={(o) => <OrderRow key={o.offerId} offer={o} />}
      />
      <SignedOrdersBlock pair={pair} days={days} />
    </>
  );
}
