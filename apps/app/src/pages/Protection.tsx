/**
 * Vault protection — protected account mode (/vault/protection).
 *
 * The owner turns protection on, watches and acts on the payout queue,
 * manages payout addresses and recovery signers, and can lock the vault at
 * once. A recovery signer opens the same view for the account they guard
 * (the "act as a signer" card) and gets the signer's actions only.
 *
 * Trust rules (see `data/protectedAccount.ts`):
 *   - no controls over a failed read of the account record;
 *   - an unread queue is said to be unread, never drawn as empty;
 *   - every row shows the contract's request code, so an alert can be
 *     matched to it, and the page says what to do with a code you do not
 *     recognise;
 *   - after a write, the controls stay busy until a fresh read lands, so a
 *     second click cannot resubmit against the old state.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ShieldCheck, LoaderCircle, Lock } from 'lucide-react';
import { isAddress } from 'viem';
import { copy } from '../content/copy';
import { useActiveChain } from '../chain/useActiveChain';
import { useDiamondWrite } from '../contracts/diamond';
import { DepositoryCard } from '../components/DepositoryCard';
import { useTokenMeta } from '../contracts/erc20';
import { captureTxError } from '../lib/errors';
import { formatDateTime, formatExactSpan, formatTokenAmount, shortAddress } from '../lib/format';
import { SECOND_READ_DELAY_MS } from '../chain/receiptSync';
import { useNowSec } from '../hooks/useNowSec';
import { EmptyState, UnavailableState } from '../components/EmptyState';
import {
  ASSET_KIND,
  additionStatus,
  chainNowOf,
  hasReplacement,
  isDue,
  isManager,
  payoutStatus,
  useProtectedAccount,
  useRetiredAccountOf,
  type PendingAddition,
  type PendingPayoutRow,
  type ProtectedAccountSnapshot,
} from '../data/protectedAccount';

const DAY = 86_400;

const when = (at: bigint): string => (at > 0n ? formatDateTime(Number(at)) : copy.protection.unknownWhen);
// The configured delay exactly (the contract accepts any second count in
// its bounds), never rounded to whole days.
const days = (seconds: number): string => formatExactSpan(seconds);

/** Shared write runner: busy through the second read, error on failure. */
function useRunner() {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    setDone(false);
    let wrote = false;
    try {
      await fn();
      wrote = true;
      setDone(true);
      await queryClient.invalidateQueries({ queryKey: ['protectedAccount'] });
      await new Promise((r) => setTimeout(r, SECOND_READ_DELAY_MS));
      await queryClient.invalidateQueries({ queryKey: ['protectedAccount'] });
    } catch (err) {
      if (!wrote) setError(captureTxError(err));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, done, run };
}

function Feedback({ error, done }: { error: string | null; done: boolean }) {
  if (error) {
    return (
      <div className="banner banner-danger" role="alert">
        <span className="banner-body">{error}</span>
      </div>
    );
  }
  if (done) {
    return (
      <p className="muted" role="status">
        {copy.protection.done}
      </p>
    );
  }
  return null;
}

/** One queued payout's amount, in the asset's own units. */
function PayoutAmount({ row }: { row: PendingPayoutRow }) {
  const meta = useTokenMeta(row.kind === ASSET_KIND.ERC20 ? row.asset : undefined);
  if (row.kind === ASSET_KIND.ERC20) {
    return meta.data ? (
      <>
        {formatTokenAmount(row.amount, meta.data.decimals)} {meta.data.symbol}
      </>
    ) : (
      // The token's symbol or decimals could not be read (or are still
      // loading): the figure is in raw base units, and the label says so.
      <>{copy.protection.payoutRawUnits(row.amount.toString(), shortAddress(row.asset))}</>
    );
  }
  return (
    <>
      {row.kind === ASSET_KIND.ERC1155 ? `${row.amount.toString()} × ` : ''}
      {shortAddress(row.asset)} #{row.tokenId.toString()}
    </>
  );
}

/** A single-address input with its own validation. */
function AddressAction({
  placeholder,
  label,
  disabled,
  onSubmit,
}: {
  placeholder: string;
  label: string;
  disabled: boolean;
  onSubmit: (a: `0x${string}`) => void;
}) {
  const [value, setValue] = useState('');
  const valid = isAddress(value.trim());
  return (
    <form
      className="cluster"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSubmit(value.trim() as `0x${string}`);
      }}
    >
      <input
        className="input"
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => setValue(e.target.value)}
        aria-invalid={value !== '' && !valid}
      />
      <button type="submit" className="btn btn-secondary" disabled={disabled || !valid}>
        {label}
      </button>
      {value !== '' && !valid ? <span className="muted">{copy.protection.invalidAddress}</span> : null}
    </form>
  );
}

/**
 * Queue a position-NFT transfer out of a protected account. The contract
 * accepts it only from the account's manager, and for a replaced account
 * only to that manager (the controller), so the destination is fixed to the
 * connected wallet there.
 */
function QueueTransferAction({
  fixedTo,
  disabled,
  onSubmit,
}: {
  fixedTo: `0x${string}` | null;
  disabled: boolean;
  onSubmit: (tokenId: bigint, to: `0x${string}`) => void;
}) {
  const p = copy.protection;
  const [tokenId, setTokenId] = useState('');
  const [to, setTo] = useState('');
  const idOk = /^[0-9]+$/.test(tokenId.trim());
  const dest = fixedTo ?? (isAddress(to.trim()) ? (to.trim() as `0x${string}`) : null);
  return (
    <form
      className="cluster"
      onSubmit={(e) => {
        e.preventDefault();
        if (idOk && dest) onSubmit(BigInt(tokenId.trim()), dest);
      }}
    >
      <input
        className="input"
        inputMode="numeric"
        value={tokenId}
        placeholder={p.transferTokenId}
        aria-label={p.transferTokenId}
        onChange={(e) => setTokenId(e.target.value)}
        aria-invalid={tokenId !== '' && !idOk}
      />
      {fixedTo ? null : (
        <input
          className="input"
          value={to}
          placeholder={p.addressPlaceholder}
          aria-label={p.addressPlaceholder}
          onChange={(e) => setTo(e.target.value)}
          aria-invalid={to !== '' && !isAddress(to.trim())}
        />
      )}
      <button type="submit" className="btn btn-secondary" disabled={disabled || !idOk || !dest}>
        {p.transferQueue}
      </button>
    </form>
  );
}

/**
 * The account view. `asSigner` renders the signer's actions only; the owner
 * (or the controller of a retired account) gets the manager's.
 */
/** Every pending allowlist or signer addition, with its deadline and the
 *  actions the contract allows on it: cancel (while it is still listed,
 *  expired included) and activate (only between maturing and expiring; a
 *  signer only once it accepted). */
function PendingAdditions({
  rows,
  delaySeconds,
  now,
  busy,
  canCancel,
  onCancel,
  onActivate,
}: {
  rows: PendingAddition[] | null;
  delaySeconds: number;
  now: bigint;
  busy: boolean;
  canCancel: (address: `0x${string}`) => boolean;
  onCancel: (address: `0x${string}`) => void;
  onActivate: (address: `0x${string}`) => void;
}) {
  const p = copy.protection;
  if (rows === null) return <p className="banner banner-warn">{p.pendingUnknown}</p>;
  return (
    <>
      {rows.map((r) => {
        const status = additionStatus(r.at, delaySeconds, now);
        const waitingOnSigner = r.accepted === false;
        return (
          <div key={r.address} className="item-row" data-testid="pending-addition">
            <span className="row-main">
              <span className="row-title">{shortAddress(r.address)}</span>
              <br />
              <span className="row-sub">
                {status === 'waiting'
                  ? p.pendingAddAt(when(r.at))
                  : status === 'ready'
                    ? p.pendingAddReady
                    : p.pendingAddExpired(when(r.at + BigInt(delaySeconds)))}
                {waitingOnSigner ? ` ${p.signerNotAccepted}` : ''}
              </span>
            </span>
            {canCancel(r.address) ? (
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => onCancel(r.address)}>
                {p.cancel}
              </button>
            ) : null}
            {status === 'ready' && !waitingOnSigner ? (
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => onActivate(r.address)}>
                {p.activate}
              </button>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

function AccountView({
  account,
  snap,
  asSigner,
}: {
  account: `0x${string}`;
  snap: ProtectedAccountSnapshot;
  asSigner: boolean;
}) {
  const { address } = useActiveChain();
  const { write } = useDiamondWrite();
  const { busy, error, done, run } = useRunner();
  const nowSec = useNowSec();
  const p = copy.protection;
  const record = snap.record!;
  const now = chainNowOf(snap, nowSec);
  const manager = isManager(account, record, address);
  const signer = Boolean(
    address && snap.signers?.some((s) => s.signer.toLowerCase() === address.toLowerCase()),
  );
  const canGuard = manager || signer;
  // A lock a signer holds bars the owner's wallet from cancelling or
  // redirecting a replacement; a lock by the owner's wallet (or its keeper)
  // does not, so a signer may lock over it.
  const lockedBySigner = Boolean(
    snap.signers?.some((s) => s.signer.toLowerCase() === record.lockedBy.toLowerCase()),
  );
  const signerMayLockOver = signer && record.locked && !lockedBySigner;
  const [delayChoice, setDelayChoice] = useState(Math.round(record.delaySeconds / DAY) || 3);
  const bounds = snap.delayBounds ?? { min: 2 * DAY, max: 5 * DAY };
  const dayOptions: number[] = [];
  for (let d = Math.ceil(bounds.min / DAY); d <= Math.floor(bounds.max / DAY); d++) dayOptions.push(d);

  const tx = (fn: string, args: readonly unknown[]) => run(() => write(fn, args));

  // `kind` is the contract's CHANGE_* constant {cancelSettingChange} takes.
  const pending: Array<{ key: string; label: string; at: bigint; kind: number }> = [];
  if (record.pendingDelayAt > 0n)
    pending.push({ key: 'delay', label: p.changeDelay(days(record.pendingDelay)), at: record.pendingDelayAt, kind: 2 });
  if (record.pendingDisableAt > 0n)
    pending.push({ key: 'disable', label: p.changeDisable, at: record.pendingDisableAt, kind: 1 });
  if (record.pendingUnlockAt > 0n)
    pending.push({ key: 'unlock', label: p.changeUnlock, at: record.pendingUnlockAt, kind: 5 });
  if (record.pendingNftOffAt > 0n)
    pending.push({ key: 'nfts', label: p.changeNftsOff, at: record.pendingNftOffAt, kind: 3 });
  if (record.pendingCosignOffAt > 0n)
    pending.push({ key: 'cosign', label: p.changeCosignOff, at: record.pendingCosignOffAt, kind: 4 });
  if (record.pendingUnpinAt > 0n)
    pending.push({ key: 'unpin', label: p.changeUnpin, at: record.pendingUnpinAt, kind: 6 });
  const anyDue = pending.some((c) => isDue(c.at, now));
  const repl = snap.replacement;

  return (
    <div className="stack">
      <Feedback error={error} done={done} />

      <section className="card">
        <h2 className="card-title">
          {record.locked ? <Lock size={18} aria-hidden /> : <ShieldCheck size={18} aria-hidden />}{' '}
          {record.locked ? p.statusLocked : p.statusOn}
        </h2>
        <p>
          {p.summaryDelay(days(record.delaySeconds))}{' '}
          {record.retired && !record.protectNfts
            ? p.summaryNftsRetired
            : record.protectNfts
              ? p.summaryNftsOn
              : p.summaryNftsOff}{' '}
          {record.requireCosign ? p.summaryCosignOn : ''}
        </p>
        {record.retired ? <p className="muted">{p.retiredNote(shortAddress(record.controller))}</p> : null}
        {record.locked ? <p>{p.lockedNote(when(record.lockedAt))}</p> : null}
        <p className="muted">{p.watchNote}</p>
      </section>

      {snap.escapeOpen ? (
        <div className="banner banner-warn" role="status">
          <span className="banner-body">
            <strong>{p.escapeTitle}.</strong> {p.escapeBody}
          </span>
        </div>
      ) : null}

      {pending.length > 0 ? (
        <section className="card">
          <h2 className="card-title">{p.changesTitle}</h2>
          {pending.map((c) => (
            <div key={c.key} className="item-row">
              <span className="row-main">
                <span className="row-title">{c.label}</span>
                <br />
                <span className="row-sub">{isDue(c.at, now) ? p.changeDue : p.changeAt(when(c.at))}</span>
              </span>
              {canGuard ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => tx('cancelSettingChange', [account, c.kind])}
                >
                  {p.cancel}
                </button>
              ) : null}
            </div>
          ))}
          {anyDue ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => tx('finalizeSettingChanges', [account])}
            >
              {p.applyChanges}
            </button>
          ) : null}
        </section>
      ) : null}

      {(canGuard && !record.locked) || signerMayLockOver ? (
        <section className="card">
          <h2 className="card-title">{p.lockTitle}</h2>
          <p>{signerMayLockOver ? p.lockOverBody : p.lockBody}</p>
          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => tx('lockVault', [account])}>
            {asSigner ? p.lockAccount : p.lockNow}
          </button>
        </section>
      ) : null}
      {manager && record.locked && record.pendingUnlockAt === 0n ? (
        <section className="card">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => tx('requestUnlock', [account])}
          >
            {p.requestUnlock}
          </button>
        </section>
      ) : null}

      <section className="card">
        <h2 className="card-title">{p.payoutsTitle}</h2>
        {snap.payouts === null ? (
          <p className="banner banner-warn">{p.payoutsUnknown}</p>
        ) : snap.payouts.length === 0 ? (
          <p className="muted">{p.payoutsEmpty}</p>
        ) : (
          snap.payouts.map((row) => {
            const status = payoutStatus(row, record, now);
            return (
              <div key={row.id.toString()} className="item-row">
                <span className="row-main">
                  <span className="row-title">
                    <PayoutAmount row={row} /> → {shortAddress(row.recipient)}
                  </span>
                  <br />
                  <span className="row-sub">
                    <strong>{row.code ? p.requestCode(row.code) : p.requestCodeUnknown}</strong> ·{' '}
                    {status === 'waiting'
                      ? p.statusWaiting(when(row.releaseAt))
                      : status === 'due'
                        ? p.statusDue
                        : status === 'needsCosign'
                          ? p.statusNeedsCosign
                          : p.statusLockedRow}
                  </span>
                </span>
                <span className="cluster">
                  {status === 'due' ? (
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() => tx('releasePayout', [row.id])}
                    >
                      {p.release}
                    </button>
                  ) : null}
                  {signer && record.requireCosign && !row.cosigned ? (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={busy}
                      onClick={() => tx('cosignPayout', [row.id])}
                    >
                      {p.cosign}
                    </button>
                  ) : null}
                  {canGuard ? (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={busy}
                      onClick={() => tx('cancelPayout', [row.id])}
                    >
                      {p.cancel}
                    </button>
                  ) : null}
                </span>
              </div>
            );
          })
        )}
        <p className="muted">{p.codeHint}</p>
      </section>

      {record.protectNfts || record.retired || (snap.transfers?.length ?? 0) > 0 || snap.transfers === null ? (
        <section className="card">
          <h2 className="card-title">{p.transfersTitle}</h2>
          {snap.transfers === null ? (
            <p className="banner banner-warn">{p.transfersUnknown}</p>
          ) : snap.transfers.length === 0 ? (
            <p className="muted">{p.transfersEmpty}</p>
          ) : (
            snap.transfers.map((t) => (
              <div key={t.id.toString()} className="item-row">
                <span className="row-main">
                  <span className="row-title">{p.transferLine(t.tokenId.toString(), shortAddress(t.to))}</span>
                  <br />
                  <span className="row-sub">
                    <strong>{t.code ? p.requestCode(t.code) : p.requestCodeUnknown}</strong> ·{' '}
                    {record.locked
                      ? p.statusLockedRow
                      : now < t.releaseAt
                        ? p.statusWaiting(when(t.releaseAt))
                        : p.statusDue}
                  </span>
                </span>
                <span className="cluster">
                  {!record.locked && now >= t.releaseAt ? (
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() => tx('releasePositionTransfer', [t.id])}
                    >
                      {p.release}
                    </button>
                  ) : null}
                  {canGuard ? (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={busy}
                      onClick={() => tx('cancelPositionTransfer', [t.id])}
                    >
                      {p.cancel}
                    </button>
                  ) : null}
                </span>
              </div>
            ))
          )}
          {manager && !record.locked && address && (record.protectNfts || record.retired) ? (
            <>
              <p>{record.retired ? p.transferQueueRetired : p.transferQueueOwner}</p>
              <QueueTransferAction
                fixedTo={record.retired ? address : null}
                disabled={busy}
                onSubmit={(id, to) => tx('queuePositionTransfer', [id, to])}
              />
            </>
          ) : null}
        </section>
      ) : null}

      {manager ? (
        <section className="card">
          <h2 className="card-title">{p.settingsTitle}</h2>
          <div className="cluster">
            <label htmlFor="protect-delay">{p.delayLabel}</label>
            <select
              id="protect-delay"
              className="input"
              value={delayChoice}
              onChange={(e) => setDelayChoice(Number(e.target.value))}
            >
              {dayOptions.map((d) => (
                <option key={d} value={d}>
                  {copy.protection.delayDays(d)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy || delayChoice * DAY === record.delaySeconds}
              onClick={() => tx('setProtectedDelay', [account, delayChoice * DAY])}
            >
              {p.setDelay}
            </button>
          </div>
          <div className="cluster">
            {record.retired ? null : (
              // A replaced account delays position NFT transfers whatever the
              // setting says, so the toggle is not offered there.
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => tx('setProtectNfts', [account, !record.protectNfts])}
              >
                {record.protectNfts ? p.nftsOff : p.nftsOn}
              </button>
            )}
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy || (!record.requireCosign && (snap.signers?.length ?? 0) === 0)}
              onClick={() => tx('setRequireCosign', [account, !record.requireCosign])}
            >
              {record.requireCosign ? p.cosignOff : p.cosignOn}
            </button>
            {record.pendingDisableAt === 0n && !record.retired ? (
              // The switch-off acts on the caller's own account, and a
              // replaced account cannot be switched off, so a controller
              // viewing it is never offered one.
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => tx('requestDisableProtectedMode', [])}
              >
                {p.disable}
              </button>
            ) : null}
          </div>
          <p className="muted">{p.tightenNote}</p>
        </section>
      ) : null}

      <section className="card">
        <h2 className="card-title">{p.allowlistTitle}</h2>
        <p>{record.retired ? p.allowlistRetired : p.allowlistBody}</p>
        {snap.allowlist === null ? (
          <p className="banner banner-warn">{p.allowlistUnknown}</p>
        ) : snap.allowlist.length === 0 ? (
          <p className="muted">{p.allowlistEmpty}</p>
        ) : (
          snap.allowlist.map((a) => (
            <div key={a} className="item-row">
              <span className="row-main">{shortAddress(a)}</span>
              {canGuard ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => tx('removeAllowlisted', [account, a])}
                >
                  {p.remove}
                </button>
              ) : null}
            </div>
          ))
        )}
        <PendingAdditions
          rows={snap.pendingAllowlist}
          delaySeconds={record.delaySeconds}
          now={now}
          busy={busy}
          canCancel={() => canGuard}
          onCancel={(a) => tx('cancelAddAllowlisted', [account, a])}
          onActivate={(a) => tx('finalizeAddAllowlisted', [account, a])}
        />
        {manager && !record.retired ? (
          // A replaced account's payouts go only to its controller: the
          // contract refuses every allowlist addition for it.
          <AddressAction
            placeholder={p.addressPlaceholder}
            label={p.addAddress}
            disabled={busy}
            onSubmit={(a) => tx('addAllowlisted', [account, a])}
          />
        ) : null}
      </section>

      <section className="card">
        <h2 className="card-title">{p.signersTitle}</h2>
        <p>{p.signersBody}</p>
        {snap.signers === null ? (
          <p className="banner banner-warn">{p.signersUnknown}</p>
        ) : snap.signers.length === 0 ? (
          <p className="muted">{p.signersEmpty}</p>
        ) : (
          snap.signers.map((s) => (
            <div key={s.signer} className="item-row">
              <span className="row-main">
                <span className="row-title">{shortAddress(s.signer)}</span>
                {s.removeAt > 0n ? (
                  <>
                    <br />
                    <span className="row-sub">{p.signerRemovalAt(when(s.removeAt))}</span>
                  </>
                ) : null}
              </span>
              {manager && s.removeAt === 0n ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => tx('requestRemoveSigner', [account, s.signer])}
                >
                  {p.removeSigner}
                </button>
              ) : null}
              {s.removeAt > 0n && canGuard && address?.toLowerCase() !== s.signer.toLowerCase() ? (
                // The contract refuses a signer cancelling its own removal,
                // so the button is offered to the manager and the OTHER
                // signers only.
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => tx('cancelRemoveSigner', [account, s.signer])}
                >
                  {p.cancel}
                </button>
              ) : null}
              {s.removeAt > 0n && isDue(s.removeAt, now) ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => tx('finalizeRemoveSigner', [account, s.signer])}
                >
                  {p.applyChanges}
                </button>
              ) : null}
            </div>
          ))
        )}
        <PendingAdditions
          rows={snap.pendingSigners}
          delaySeconds={record.delaySeconds}
          now={now}
          busy={busy}
          // The nominee may withdraw its own nomination too.
          canCancel={(a) => canGuard || address?.toLowerCase() === a.toLowerCase()}
          onCancel={(a) => tx('cancelAddSigner', [account, a])}
          onActivate={(a) => tx('finalizeAddSigner', [account, a])}
        />
        {manager ? (
          <>
            <AddressAction
              placeholder={p.addressPlaceholder}
              label={p.inviteSigner}
              disabled={busy}
              onSubmit={(a) => tx('addSigner', [account, a])}
            />
            <p className="muted">{p.signersMinNote}</p>
          </>
        ) : null}
      </section>

      <section className="card">
        <h2 className="card-title">{p.replacementTitle}</h2>
        {repl === null ? (
          // The account record read but the proposal did not: a live
          // takeover proposal may exist, so this is stated as unknown,
          // never as "no move proposed".
          <p className="banner banner-warn">{p.replacementUnknown}</p>
        ) : !hasReplacement(repl) ? (
          <p className="muted">{p.replacementNone}</p>
        ) : (
          <>
            <p>{p.replacementLine(shortAddress(repl!.nominee), repl!.approvals, repl!.threshold)}</p>
            {repl!.readyAt > 0n ? <p>{p.replacementReady(when(repl!.readyAt))}</p> : null}
            {signer ? (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => tx('approveReplacement', [account])}
              >
                {p.approveReplacement}
              </button>
            ) : null}
            {canGuard ? (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => tx('cancelReplacement', [account])}
              >
                {p.cancel}
              </button>
            ) : null}
            {isDue(repl!.readyAt, now) ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => tx('finalizeReplacement', [account])}
              >
                {p.finalizeReplacement}
              </button>
            ) : null}
          </>
        )}
        {signer && repl !== null && !hasReplacement(repl) ? (
          <AddressAction
            placeholder={p.nomineePlaceholder}
            label={p.proposeReplacement}
            disabled={busy}
            onSubmit={(a) => tx('proposeReplacement', [account, a])}
          />
        ) : null}
      </section>
    </div>
  );
}

/** Enable form for an account with protection off. */
function EnableForm({ snap }: { snap: ProtectedAccountSnapshot }) {
  const { write } = useDiamondWrite();
  const { busy, error, done, run } = useRunner();
  const p = copy.protection;
  const bounds = snap.delayBounds ?? { min: 2 * DAY, max: 5 * DAY };
  const dayOptions: number[] = [];
  for (let d = Math.ceil(bounds.min / DAY); d <= Math.floor(bounds.max / DAY); d++) dayOptions.push(d);
  const [delay, setDelay] = useState(dayOptions.includes(3) ? 3 : dayOptions[0]);
  const [nfts, setNfts] = useState(true);
  return (
    <section className="card">
      <h2 className="card-title">{p.statusOff}</h2>
      <p>{p.offExplainer}</p>
      <p className="muted">{p.watchNote}</p>
      <div className="cluster">
        <label htmlFor="enable-delay">{p.delayLabel}</label>
        <select id="enable-delay" className="input" value={delay} onChange={(e) => setDelay(Number(e.target.value))}>
          {dayOptions.map((d) => (
            <option key={d} value={d}>
              {p.delayDays(d)}
            </option>
          ))}
        </select>
      </div>
      <label className="cluster">
        <input type="checkbox" checked={nfts} onChange={(e) => setNfts(e.target.checked)} /> {p.protectNftsLabel}
      </label>
      <button
        type="button"
        className="btn btn-primary"
        disabled={busy}
        onClick={() => run(() => write('enableProtectedMode', [delay * DAY, nfts]))}
      >
        {busy ? p.working : p.enable}
      </button>
      <Feedback error={error} done={done} />
    </section>
  );
}

/** The signer's entry: open another account's view. */
function SignerEntryCard() {
  const p = copy.protection;
  const [account, setAccount] = useState<`0x${string}` | undefined>();
  const snap = useProtectedAccount(account);
  const { address, walletChain } = useActiveChain();
  const { write } = useDiamondWrite();
  const { busy, error, done, run } = useRunner();
  const data = snap.data;
  const nowSec = useNowSec();
  const isSigner = Boolean(
    address && data?.signers?.some((s) => s.signer.toLowerCase() === address.toLowerCase()),
  );
  const nomination = address
    ? data?.pendingSigners?.find((r) => r.address.toLowerCase() === address.toLowerCase())
    : undefined;
  return (
    <section className="card">
      <h2 className="card-title">{p.signerViewTitle}</h2>
      <p>{p.signerViewBody}</p>
      <AddressAction placeholder={p.accountPlaceholder} label={p.loadAccount} disabled={false} onSubmit={setAccount} />
      {account && walletChain ? (
        <>
          <Feedback error={error} done={done} />
          {snap.isLoading ? (
            <p className="muted">{p.loading}</p>
          ) : snap.isError || !data || data.recordFailed ? (
            <UnavailableState body={p.unavailable} />
          ) : !data.supported ? (
            <UnavailableState body={p.unsupported} />
          ) : data.signers === null ? (
            <UnavailableState body={p.signerRoleUnknown} />
          ) : isSigner ? (
            data.record?.enabled ? (
              <AccountView account={account} snap={data} asSigner />
            ) : (
              <p className="muted">{p.statusOff}</p>
            )
          ) : data.pendingSigners === null ? (
            <UnavailableState body={p.signerRoleUnknown} />
          ) : nomination && data.record ? (
            // An invited wallet that is not yet a signer: its own nomination,
            // with acceptance (only while not yet given), withdrawal and, once
            // matured and accepted, the permissionless activation.
            <div className="stack">
              <p>{p.nomineeBody}</p>
              <PendingAdditions
                rows={[nomination]}
                delaySeconds={data.record.delaySeconds}
                now={chainNowOf(data, nowSec)}
                busy={busy}
                canCancel={() => true}
                onCancel={(a) => run(() => write('cancelAddSigner', [account, a]))}
                onActivate={(a) => run(() => write('finalizeAddSigner', [account, a]))}
              />
              {nomination.accepted === false ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => run(() => write('acceptSignerRole', [account]))}
                >
                  {p.acceptRole}
                </button>
              ) : null}
            </div>
          ) : (
            <p className="muted">{p.notSigner}</p>
          )}
        </>
      ) : null}
    </section>
  );
}

/** The account a controller manages after a replacement moved it. */
function RetiredAccountCard({ account }: { account: `0x${string}` }) {
  const p = copy.protection;
  const snap = useProtectedAccount(account);
  const data = snap.data;
  if (snap.isLoading) return <p className="muted">{p.loading}</p>;
  if (!data || snap.isError || data.recordFailed || !data.record) return <UnavailableState body={p.unavailable} />;
  return (
    <section className="card">
      <h2 className="card-title">{p.managedAccountTitle(shortAddress(account))}</h2>
      <AccountView account={account} snap={data} asSigner={false} />
      {/* The controller withdraws the retired account's assets here: the
          wallet's own depository card would act on the controller's vault. */}
      <DepositoryCard account={account} />
    </section>
  );
}

export function Protection() {
  const { isConnected, address } = useActiveChain();
  const snap = useProtectedAccount();
  const retired = useRetiredAccountOf();
  const p = copy.protection;
  const data = snap.data;
  return (
    <div>
      <p>
        <Link to="/vault">← {copy.vault.title}</Link>
      </p>
      <h1 className="page-title">{p.title}</h1>
      <p className="page-lede">{p.lede}</p>
      {!isConnected || !address ? (
        <EmptyState icon={ShieldCheck} title={copy.wallet.connectFirst} />
      ) : snap.isLoading ? (
        <EmptyState icon={LoaderCircle} title={p.loading} />
      ) : !data || snap.isError ? (
        <UnavailableState body={p.unavailable} />
      ) : !data.supported ? (
        <UnavailableState body={p.unsupported} />
      ) : data.recordFailed || !data.record ? (
        <UnavailableState body={p.unavailable} />
      ) : (
        <div className="stack">
          {data.record.enabled ? <AccountView account={address} snap={data} asSigner={false} /> : <EnableForm snap={data} />}
          {retired.data ? <RetiredAccountCard account={retired.data} /> : null}
          {retired.isError ? <UnavailableState body={p.managedAccountUnknown} /> : null}
          <SignerEntryCard />
        </div>
      )}
    </div>
  );
}
