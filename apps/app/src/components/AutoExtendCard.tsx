/**
 * #2814 — the loan page's automatic-extension card.
 *
 * For a party to an active ERC-20 loan it states the protocol switch, the
 * extension window, both sides' limits and the terms they leave open, and
 * lets the viewer set or clear their own side's limits. The borrower-position
 * holder also sees the extension reserve: what is set aside, what the next
 * extension would charge now and at the end of the window, whether that is
 * covered, and the deposit and withdrawal. Anyone else holding an unused
 * reserve on the loan (a closed loan, or a position since passed on) is shown
 * just that reserve and its withdrawal.
 *
 * Every figure is read from the chain; the card adds no rule of its own.
 */
import { useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { usePublicClient, useWalletClient } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import type { Address, Log, PublicClient } from 'viem';
import { copy } from '../content/copy';
import { ConfirmReceipt } from './ConfirmReceipt';
import { useActiveChain } from '../chain/useActiveChain';
import { useDiamondWrite, useTermsBlockNonExitWrites } from '../contracts/diamond';
import { ensureAllowance, trackApproval, useTokenMeta } from '../contracts/erc20';
import { assertErc20BalanceLive, assertAssetNotPausedLive, assertPositionNftHeldLive } from '../contracts/preflights';
import { readLoanLive } from '../contracts/loanLive';
import { assertWalletNotSanctionedLive } from '../data/sanctions';
import { useKeeperConfig, useLoanKeeperEnables } from '../data/keepers';
import { ownFundingVerdict, ownWithdrawalVerdict, payoutOutcome, useOwnPayoutRoute, useProtectedAccount } from '../data/protectedAccount';
import { payoutOutcomesText, payoutRouteText } from '../lib/payoutRouteText';
import { captureTxError } from '../lib/errors';
import { formatBpsAsPercent, formatDateTime, formatTokenAmount, formatTokenAmountExact, parseExactUnits, shortAddress } from '../lib/format';
import { MAX_INTEREST_BPS, percentToBps } from '../lib/offerSchema';
import { freshData } from '../lib/freshData';
import {
  capsArgs,
  consentBand,
  fundingCover,
  keeperVerdict,
  readAutoExtendState,
  setByEarlierHolder,
  useAutoExtendState,
  useExtendFunding,
  useRecordReserveOutcome,
  useReserveOutcomes,
  windowPhase,
  withdrawWholeReserve,
  type AutoExtendState,
  type ExtendCaps,
  type ExtendFunding,
} from '../data/autoExtend';

type Meta = { decimals: number; symbol: string } | undefined;

function amountText(amount: bigint, meta: Meta): string {
  return meta
    ? `${formatTokenAmount(amount, meta.decimals)} ${meta.symbol}`
    : copy.claims.row.amountLoadingInline;
}

/** An amount to the token's last unit, for a review receipt: the receipt
 *  states exactly what the transaction carries. */
export function exactAmountText(amount: bigint, meta: Meta): string {
  return meta
    ? `${formatTokenAmountExact(amount, meta.decimals)} ${meta.symbol}`
    : copy.claims.row.amountLoadingInline;
}

/** A date input's value ("2026-11-20") as the end of that local day. */
function endOfLocalDay(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59);
  return Number.isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
}

function dateInputOf(unix: number): string {
  const d = new Date(unix * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** One side's limits, worded. */
function capsLine(side: 'borrower' | 'lender', caps: ExtendCaps): string {
  if (!caps.enabled) return copy.autoExtend.off;
  const end = formatDateTime(caps.maxNewExpiry);
  return side === 'borrower'
    ? copy.autoExtend.borrowerOn(formatBpsAsPercent(caps.maxRateBps), end)
    : copy.autoExtend.lenderOn(formatBpsAsPercent(caps.minRateBps), end);
}

function Banner({ kind, children }: { kind: 'info' | 'warn' | 'danger'; children: React.ReactNode }) {
  return (
    <div className={`banner banner-${kind}`} role={kind === 'danger' ? 'alert' : 'status'} style={{ marginTop: 12 }}>
      <span className="banner-body">{children}</span>
    </div>
  );
}

/** Withdraw the whole unused reserve, and say where the payment went. */
export function ReserveWithdraw({
  loanId,
  reserved,
  meta,
  metaFailed,
  busy,
  setBusy,
}: {
  loanId: number;
  /** The reserve as last read, for the review receipt. The withdrawal itself
   *  re-reads it just before signing. */
  reserved: bigint;
  /** The asset's metadata. Without it the receipt cannot state the amount,
   *  so nothing is offered. */
  meta: Meta;
  metaFailed: boolean;
  busy: boolean;
  setBusy: (b: boolean) => void;
}) {
  const { address, walletChain, onSupportedChain } = useActiveChain();
  const client = usePublicClient({ chainId: walletChain?.chainId });
  const { write } = useDiamondWrite();
  const queryClient = useQueryClient();
  const route = payoutRouteText(useOwnPayoutRoute());
  const protection = useProtectedAccount();
  // The contract refuses a withdrawal from a wallet whose account a
  // replacement retired; a locked account or a full queue only holds the
  // payment in the vault, which the outcome then says.
  const verdict = ownWithdrawalVerdict(protection.data, protection.isError);
  const record = useRecordReserveOutcome();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const r = copy.autoExtend.reserve;
  const rw = r.receiptWithdraw;
  const amount = meta ? exactAmountText(reserved, meta) : null;

  async function run() {
    if (!address || !walletChain || !client) return;
    setConfirming(false);
    setBusy(true);
    setError(null);
    try {
      const diamond = walletChain.diamondAddress as Address;
      const logs = await withdrawWholeReserve({
        client: client as PublicClient,
        diamond,
        account: address as Address,
        loanId,
        write: (fn, args) => write(fn, args),
        screen: () => assertWalletNotSanctionedLive(client as PublicClient, diamond, address as Address),
      });
      if (logs === null) {
        setError(copy.autoExtend.reserve.nothingLeft);
        return;
      }
      const note = payoutOutcomesText([payoutOutcome(logs as Log[], address)], address);
      // Recorded outside this component: the refreshed reserve reads zero and
      // unmounts it, and the outcome must stay in view.
      record(loanId, note ? `${r.withdrawn} ${note}` : r.withdrawn);
    } catch (err) {
      setError(captureTxError(err));
    } finally {
      setBusy(false);
      void queryClient.invalidateQueries({ queryKey: ['extendReserve'] });
    }
  }

  return (
    <>
      {route ? <p className="muted">{route}</p> : null}
      {verdict.kind === 'retired' ? (
        <p className="muted">{r.retired(shortAddress(verdict.controller))}</p>
      ) : verdict.kind === 'unread' ? (
        <p className="muted">{protection.isLoading ? copy.autoExtend.loading : r.protectionUnknown}</p>
      ) : amount === null ? (
        <p className="muted">{metaFailed ? r.amountUnread : copy.autoExtend.loading}</p>
      ) : confirming ? (
        <ConfirmReceipt
          busy={busy}
          confirmLabel={copy.autoExtend.reserve.withdraw}
          onBack={() => setConfirming(false)}
          onConfirm={() => void run()}
          disabled={!onSupportedChain}
          data={{
            youReceive: rw.youReceive(amount),
            youLock: rw.youLock,
            youMayOwe: rw.youMayOwe,
            youCanLose: rw.youCanLose,
            fees: rw.fees,
            whenThisEnds: rw.whenThisEnds,
          }}
        />
      ) : (
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={busy || !onSupportedChain}
          onClick={() => setConfirming(true)}
        >
          {busy ? r.withdrawing : r.reviewWithdraw}
        </button>
      )}
      {error ? <Banner kind="danger">{error}</Banner> : null}
    </>
  );
}

/** The reserve as the borrower-position holder of an active loan sees it. */
function ReservePanel({
  loanId,
  funding,
  meta,
  canFund,
  metaFailed,
  busy,
  setBusy,
}: {
  loanId: number;
  funding: ExtendFunding;
  meta: Meta;
  metaFailed: boolean;
  /** `open` when the switch is on and the protocol not paused (the loan's
   *  own state is re-read live before the deposit); `unknown` when that
   *  could not be read. The withdrawal never depends on it. */
  canFund: 'open' | 'closed' | 'unknown';
  busy: boolean;
  setBusy: (b: boolean) => void;
}) {
  const r = copy.autoExtend.reserve;
  const { address, walletChain, onSupportedChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const { data: walletClient } = useWalletClient();
  const { write } = useDiamondWrite();
  const termsVerdict = useTermsBlockNonExitWrites();
  const protection = useProtectedAccount();
  // The contract refuses a deposit from a wallet whose account a replacement
  // retired: refuse it here, and before any approval.
  const fundingVerdict = ownFundingVerdict(protection.data, protection.isError);
  const queryClient = useQueryClient();
  const [input, setInput] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const cover = fundingCover(funding);
  const parsed = meta ? parseExactUnits(input, meta.decimals) : 'invalid';
  const amount = typeof parsed === 'bigint' && parsed > 0n ? parsed : null;

  async function fund() {
    if (!address || !walletChain || !publicClient || !walletClient || amount === null) return;
    const owner = address as Address;
    const diamond = walletChain.diamondAddress as Address;
    const approval = trackApproval();
    setConfirming(false);
    setBusy(true);
    setError(null);
    setDone(null);
    // Set before `ensureAllowance` runs, not after it returns: it can throw
    // with an approval already sent (a failed receipt wait, or a zero-first
    // token's second approve refused after its reset). `unwind` restores
    // only what the hooks saw change, so calling it is always safe.
    let approving = false;
    try {
      // The deposit is not a Terms-gate exit: refuse it here, before any
      // approval, rather than after one has been paid for.
      const terms = termsVerdict();
      if (terms !== 'ok') {
        throw new Error(terms === 'unknown' ? copy.errors.termsCheckUnavailable : copy.errors.termsNotAccepted);
      }
      if (fundingVerdict.kind !== 'open') {
        throw new Error(
          fundingVerdict.kind === 'retired' ? r.retired(shortAddress(fundingVerdict.controller)) : r.protectionUnknown,
        );
      }
      await assertWalletNotSanctionedLive(publicClient, diamond, owner);
      // The deposit is refused unless the loan could be extended now:
      // check before any approval, so none is left standing for a refusal.
      const [live, loan] = await Promise.all([
        readAutoExtendState({ client: publicClient, diamond }, loanId),
        readLoanLive(publicClient, diamond, loanId),
      ]);
      if (live.paused || !live.switchOn || live.window === null || Number(loan.periodicInterestCadence) !== 0) {
        setError(r.fundClosed);
        return;
      }
      // Only the current borrower-position holder may fund.
      await assertPositionNftHeldLive({
        publicClient,
        diamondAddress: diamond,
        tokenId: String(loan.borrowerTokenId),
        expectedOwner: owner,
      });
      await assertAssetNotPausedLive({ publicClient, diamondAddress: diamond, asset: funding.asset });
      await assertErc20BalanceLive({ publicClient, token: funding.asset, owner, amount, symbol: meta?.symbol });
      approving = true;
      await ensureAllowance({
        publicClient,
        walletClient,
        token: funding.asset,
        owner,
        spender: diamond,
        amount,
        ...approval.hooks(funding.asset),
      });
      await write('fundExtendReserve', [BigInt(loanId), amount]);
      approving = false;
      setInput('');
      setDone(r.added);
    } catch (err) {
      let message = captureTxError(err);
      // An approval this attempt granted for a deposit that did not happen
      // is put back rather than left standing.
      if (approving) {
        const ok = await approval.unwind({ publicClient, walletClient, owner, spender: diamond });
        if (!ok) message = `${message} ${copy.errors.approvalCleanupFailed}`;
      }
      setError(message);
    } finally {
      setBusy(false);
      void queryClient.invalidateQueries({ queryKey: ['extendReserve'] });
    }
  }

  return (
    <div style={{ marginTop: 16 }} data-testid="extend-reserve">
      <h4 style={{ margin: '0 0 4px' }}>{r.title}</h4>
      <p className="muted">{r.lede(meta?.symbol ?? '')}</p>
      <ul style={{ margin: '8px 0', paddingLeft: 18 }}>
        <li>{r.reserved(amountText(funding.reserved, meta))}</li>
        <li>{r.otherFree(amountText(funding.otherFree, meta))}</li>
        <li>{r.chargeNow(amountText(funding.chargeNow, meta))}</li>
        <li>{r.chargeAtEnd(amountText(funding.chargeAtGraceEnd, meta))}</li>
      </ul>
      <p>
        {cover.coversWindow
          ? r.coversBoth
          : cover.coversNow
            ? r.coversNowOnly(amountText(cover.shortWindow, meta))
            : r.short(amountText(cover.shortWindow, meta))}
      </p>
      <p className="muted">{r.eachTime}</p>
      <p className="muted">{r.ownership}</p>
      {fundingVerdict.kind === 'retired' ? (
        <p className="muted">{r.retired(shortAddress(fundingVerdict.controller))}</p>
      ) : fundingVerdict.kind === 'unread' ? (
        <p className="muted">{protection.isLoading ? copy.autoExtend.loading : r.protectionUnknown}</p>
      ) : canFund === 'open' && confirming && amount !== null ? (
        <ConfirmReceipt
          busy={busy}
          confirmLabel={r.add}
          onBack={() => setConfirming(false)}
          onConfirm={() => void fund()}
          disabled={!onSupportedChain}
          data={{
            youReceive: r.receiptAdd.youReceive(exactAmountText(amount, meta)),
            youLock: r.receiptAdd.youLock(exactAmountText(amount, meta)),
            youMayOwe: r.receiptAdd.youMayOwe(meta?.symbol ?? ''),
            youCanLose: r.receiptAdd.youCanLose,
            fees: r.receiptAdd.fees(exactAmountText(amount, meta)),
            whenThisEnds: r.receiptAdd.whenThisEnds,
          }}
        />
      ) : canFund === 'open' ? (
        <div className="cluster" style={{ alignItems: 'flex-end', gap: 8 }}>
          <label className="stack" style={{ gap: 4 }}>
            <span>{r.amount(meta?.symbol ?? '')}</span>
            <input
              className="input"
              inputMode="decimal"
              value={input}
              disabled={busy}
              onChange={(e) => setInput(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy || !onSupportedChain || amount === null || !meta}
            onClick={() => setConfirming(true)}
          >
            {busy ? r.adding : r.review}
          </button>
        </div>
      ) : (
        <p className="muted">{canFund === 'unknown' ? r.fundUnknown : r.fundClosed}</p>
      )}
      {done ? <Banner kind="info">{done}</Banner> : null}
      {error ? <Banner kind="danger">{error}</Banner> : null}
      {funding.reserved > 0n ? (
        <div style={{ marginTop: 12 }}>
          <ReserveWithdraw
            loanId={loanId}
            reserved={funding.reserved}
            meta={meta}
            metaFailed={metaFailed}
            busy={busy}
            setBusy={setBusy}
          />
        </div>
      ) : null}
    </div>
  );
}

/** The review receipt for saving one side's limits. */
function limitsReceipt(side: 'borrower' | 'lender', rate: string, end: string) {
  const a = copy.autoExtend;
  if (side === 'borrower') {
    const r = a.receiptBorrower;
    return {
      youReceive: r.youReceive(rate, end),
      youLock: r.youLock,
      youMayOwe: r.youMayOwe,
      youCanLose: r.youCanLose(rate),
      fees: r.fees,
      whenThisEnds: r.whenThisEnds,
    };
  }
  const r = a.receiptLender;
  return {
    youReceive: r.youReceive(rate, end),
    youLock: r.youLock(end),
    youMayOwe: r.youMayOwe,
    youCanLose: r.youCanLose,
    fees: r.fees,
    whenThisEnds: r.whenThisEnds,
  };
}

/** The viewer's own side's limits, with set and clear. */
function LimitsEditor({
  loanId,
  side,
  state,
  busy,
  setBusy,
}: {
  loanId: number;
  side: 'borrower' | 'lender';
  state: AutoExtendState;
  busy: boolean;
  setBusy: (b: boolean) => void;
}) {
  const a = copy.autoExtend;
  const { address, walletChain, onSupportedChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const { write } = useDiamondWrite();
  const queryClient = useQueryClient();
  const own = side === 'borrower' ? state.borrower : state.lender;
  const ownRate = side === 'borrower' ? own.maxRateBps : own.minRateBps;
  const [rate, setRate] = useState(own.enabled ? String(ownRate / 100) : '');
  const [end, setEnd] = useState(own.enabled ? dateInputOf(own.maxNewExpiry) : '');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const rateBps = rate === '' ? null : percentToBps(rate);
  const rateOk = rateBps !== null && rateBps >= 0 && rateBps <= MAX_INTEREST_BPS;
  const endAt = endOfLocalDay(end);
  const endOk = endAt !== null && endAt > state.now;

  async function save(enabled: boolean) {
    if (!address || !walletChain || !publicClient) return;
    setConfirming(false);
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await assertWalletNotSanctionedLive(publicClient, walletChain.diamondAddress, address);
      const args = capsArgs(
        side,
        loanId,
        { enabled, rateBps: rateBps ?? 0, latestEnd: endAt ?? 0 },
        MAX_INTEREST_BPS,
      );
      await write(side === 'borrower' ? 'setAutoExtendBorrowerCaps' : 'setAutoExtendLenderCaps', args);
      setDone(enabled ? a.saved : a.turnedOff);
    } catch (err) {
      setError(captureTxError(err));
    } finally {
      setBusy(false);
      void queryClient.invalidateQueries({ queryKey: ['autoExtend'] });
    }
  }

  return (
    <div className="stack" style={{ gap: 8, marginTop: 12 }}>
      <h4 style={{ margin: 0 }}>{side === 'borrower' ? a.editBorrower : a.editLender}</h4>
      <div className="cluster" style={{ alignItems: 'flex-end', gap: 8 }}>
        <label className="stack" style={{ gap: 4 }}>
          <span>{side === 'borrower' ? a.rateBorrower : a.rateLender}</span>
          <input
            className="input"
            inputMode="decimal"
            value={rate}
            disabled={busy || state.paused}
            onChange={(e) => setRate(e.target.value)}
          />
        </label>
        <label className="stack" style={{ gap: 4 }}>
          <span>{a.latestEnd}</span>
          <input
            className="input"
            type="date"
            value={end}
            disabled={busy || state.paused}
            onChange={(e) => setEnd(e.target.value)}
          />
        </label>
      </div>
      {rate !== '' && !rateOk ? (
        <p className="muted">{a.invalidRate(formatBpsAsPercent(MAX_INTEREST_BPS))}</p>
      ) : null}
      {endAt !== null ? (
        <p className="muted">{endOk ? a.latestEndHint(formatDateTime(endAt)) : a.invalidEnd}</p>
      ) : null}
      {confirming && rateOk && endOk && rateBps !== null && endAt !== null ? (
        <ConfirmReceipt
          busy={busy}
          confirmLabel={a.save}
          onBack={() => setConfirming(false)}
          onConfirm={() => void save(true)}
          disabled={state.paused || !onSupportedChain}
          data={limitsReceipt(side, formatBpsAsPercent(rateBps), formatDateTime(endAt))}
        />
      ) : null}
      <div className="cluster" style={{ gap: 8 }}>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={busy || confirming || state.paused || !onSupportedChain || !rateOk || !endOk}
          onClick={() => setConfirming(true)}
        >
          {busy ? a.saving : a.review}
        </button>
        {own.enabled ? (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy || state.paused || !onSupportedChain}
            onClick={() => void save(false)}
          >
            {a.turnOff}
          </button>
        ) : null}
      </div>
      {done ? <Banner kind="info">{done}</Banner> : null}
      {error ? <Banner kind="danger">{error}</Banner> : null}
    </div>
  );
}

/** Whether a keeper the borrower allows can send the extension. */
function KeeperLine({ loanId, keepersPaused }: { loanId: number; keepersPaused: boolean }) {
  const config = useKeeperConfig();
  const cfg = freshData(config);
  const keepers = (cfg?.keepers ?? []).map((k) => k.keeper);
  const enables = useLoanKeeperEnables(loanId, keepers, keepers.length > 0);
  const loanEnables = freshData(enables);
  const a = copy.autoExtend;
  if (keepersPaused) return <p className="muted">{a.keeperPaused}</p>;
  if (config.isError || enables.isError) return <p className="muted">{a.keeperUnknown}</p>;
  if (!cfg || (keepers.length > 0 && !loanEnables)) return null;
  const verdict = keeperVerdict(cfg, loanEnables ?? {});
  return (
    <p className="muted">
      {verdict === 'ready' ? a.keeperReady : verdict === 'unknown' ? a.keeperUnknown : a.keeperNone}
    </p>
  );
}

export function AutoExtendCard({
  loanId,
  holdsBorrower,
  holdsLender,
  active,
  isRental,
  cadence,
  principalAsset,
  busy,
  setBusy,
}: {
  loanId: number;
  /** The connected wallet holds the borrower position, by a fresh read. */
  holdsBorrower: boolean;
  /** The connected wallet holds the lender position, by a fresh read. A
   *  wallet may hold both, and then sets both sides' limits. */
  holdsLender: boolean;
  /** The loan is active, by the page's reconciled status. */
  active: boolean;
  isRental: boolean;
  /** The loan's interest schedule; `undefined` while unknown. */
  cadence: number | undefined;
  principalAsset: Address;
  /** The page's shared write lock. */
  busy: boolean;
  setBusy: (b: boolean) => void;
}) {
  const a = copy.autoExtend;
  const { address, readChain } = useActiveChain();
  const extendable = active && !isRental;
  const party = extendable && (holdsBorrower || holdsLender);
  const funding = useExtendFunding(loanId);
  const state = useAutoExtendState(loanId, party);
  const metaQuery = useTokenMeta(principalAsset);
  const meta = metaQuery.data;
  const reserved = funding.data?.reserved ?? 0n;
  // What a withdrawal this session did, kept outside every reserve surface
  // (each one unmounts once the reserve reads zero).
  const outcome = useReserveOutcomes()[loanId];
  const outcomeBanner = outcome ? <Banner kind="info">{outcome}</Banner> : null;

  // A reserve this wallet left on the loan that the loan can no longer draw:
  // the loan ended, or the borrower position is held by someone else.
  // A failed read is said, not shown as "no reserve" (the hook drops data
  // behind a failed refresh, so `reserved` would read 0 here).
  const leftover = extendable && holdsBorrower ? null : funding.isError ? (
    <p className="muted" style={{ marginTop: party ? 16 : 0 }}>
      {a.reserve.unreadLeftover}
    </p>
  ) : reserved > 0n ? (
    <div data-testid="extend-reserve-leftover" style={{ marginTop: party ? 16 : 0 }}>
      {party ? <h4 style={{ margin: '0 0 4px' }}>{a.reserve.leftoverTitle}</h4> : null}
      <p>{a.reserve.leftover(amountText(reserved, meta))}</p>
      <p className="muted">{extendable ? a.reserve.notHolder : a.reserve.ended}</p>
      <ReserveWithdraw loanId={loanId} reserved={reserved} meta={meta} metaFailed={metaQuery.isError} busy={busy} setBusy={setBusy} />
    </div>
  ) : null;

  // Not a party to an extendable loan: show only a reserve left behind.
  if (!party) {
    if (!leftover && !outcome) return null;
    return (
      <section className="card">
        <div className="card-title">
          <CalendarClock aria-hidden />
          <h3 style={{ margin: 0 }}>{a.reserve.leftoverTitle}</h3>
        </div>
        {leftover}
        {outcomeBanner}
      </section>
    );
  }

  const header = (
    <div className="card-title">
      <CalendarClock aria-hidden />
      <h3 style={{ margin: 0 }}>{a.title}</h3>
    </div>
  );

  if (cadence === undefined || cadence !== 0) {
    return (
      <section className="card" data-testid="auto-extend">
        {header}
        <p className="muted">{cadence === undefined ? a.scheduleUnknown : a.scheduled}</p>
        {reserved > 0n ? (
          <>
            <p>{a.reserve.leftover(amountText(reserved, meta))}</p>
            <ReserveWithdraw loanId={loanId} reserved={reserved} meta={meta} metaFailed={metaQuery.isError} busy={busy} setBusy={setBusy} />
          </>
        ) : null}
        {outcomeBanner}
      </section>
    );
  }

  // The borrower-position holder's reserve, read on its own: its figures
  // and withdrawal never wait on, or fall with, the extension-state read.
  const reservePanel = (canFund: 'open' | 'closed' | 'unknown') =>
    funding.data ? (
      <ReservePanel
        loanId={loanId}
        funding={funding.data}
        meta={meta}
        metaFailed={metaQuery.isError}
        canFund={canFund}
        busy={busy}
        setBusy={setBusy}
      />
    ) : (
      <p className="muted">{funding.isError ? a.reserve.unavailable : a.loading}</p>
    );

  if (!state.data) {
    return (
      <section className="card" data-testid="auto-extend">
        {header}
        <p className="muted">{state.isError ? a.unavailable : a.loading}</p>
        {holdsBorrower ? reservePanel('unknown') : leftover}
        {outcomeBanner}
      </section>
    );
  }

  const s = state.data;
  const band = consentBand(s.borrower, s.lender, s);
  const phase = s.window ? windowPhase(s.now, s.window) : null;
  const held = { borrower: holdsBorrower, lender: holdsLender };
  const sides = (['borrower', 'lender'] as const).filter((side) => held[side]);

  /** One side's limits as this viewer reads them. */
  function limitsText(side: 'borrower' | 'lender'): string {
    const caps = side === 'borrower' ? s.borrower : s.lender;
    if (caps.enabled) return capsLine(side, caps);
    if (!held[side]) return a.otherOff;
    return setByEarlierHolder(caps, address) ? a.earlierHolder : a.off;
  }

  return (
    <section className="card" data-testid="auto-extend">
      {header}
      <p className="muted">{a.lede}</p>
      {s.paused ? <Banner kind="warn">{a.paused}</Banner> : null}
      {!s.switchOn ? <Banner kind="warn">{a.switchOff}</Banner> : null}
      {s.window && phase ? (
        <p>
          {phase === 'before'
            ? a.windowBefore(formatDateTime(s.window.opensAt), formatDateTime(s.window.closesAt))
            : phase === 'open'
              ? a.windowOpen(formatDateTime(s.window.closesAt))
              : a.windowClosed(formatDateTime(s.window.closesAt))}
        </p>
      ) : null}
      <p className="muted">{a.blockers}</p>
      <dl className="kv">
        {(['borrower', 'lender'] as const).map((side) => {
          const label = side === 'borrower' ? a.borrowerLimits : a.lenderLimits;
          return (
            <div key={side}>
              <dt>{held[side] ? a.yours(label) : label}</dt>
              <dd>{limitsText(side)}</dd>
            </div>
          );
        })}
      </dl>
      <p>
        {band.kind === 'overlap'
          ? a.bandOverlap(formatBpsAsPercent(band.minRateBps), formatBpsAsPercent(band.maxRateBps), formatDateTime(band.latestEnd))
          : band.kind === 'noOverlap'
            ? a.bandNoOverlap
            : band.kind === 'endTooEarly'
              ? a.bandEndTooEarly(formatDateTime(band.currentEnd))
              : a.bandMissing}
      </p>
      {sides.map((side) => (
        // Keyed by who is editing which side: a draft typed for one wallet
        // or one side must never be submitted as another's consent.
        <LimitsEditor
          key={`${readChain.chainId}:${address?.toLowerCase() ?? ''}:${side}`}
          loanId={loanId}
          side={side}
          state={s}
          busy={busy}
          setBusy={setBusy}
        />
      ))}
      {holdsBorrower ? (
        <>
          <KeeperLine loanId={loanId} keepersPaused={s.keepersPaused} />
          {reservePanel(s.switchOn && !s.paused ? 'open' : 'closed')}
        </>
      ) : (
        <>
          <p className="muted">{a.lenderFunding}</p>
          {leftover}
        </>
      )}
      {outcomeBanner}
    </section>
  );
}
