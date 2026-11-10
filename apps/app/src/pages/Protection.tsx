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
import { isAddress, type Abi } from 'viem';
import { usePublicClient } from 'wagmi';
import { VaipakamVaultImplementationABI } from '@vaipakam/contracts/abis';
import {
  directAuth,
  protectionCall,
  VAULT_REPLACE,
  VAULT_SETTING,
  VAULT_SIGNER,
} from '@vaipakam/lib/protectedAccountView';
import { copy } from '../content/copy';
import { useActiveChain } from '../chain/useActiveChain';
import { DIAMOND_ABI_VIEM, useDiamondWrite } from '../contracts/diamond';
import { LEGACY_DIAMOND_NFT_ABI, POSITION_NFT_ABI } from '../contracts/positionNft';
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
  replacementStage,
  useProtectedAccount,
  useRetiredAccountOf,
  type PendingAddition,
  type HolderLockState,
  type PendingPayoutRow,
  type ProtectedAccountSnapshot,
} from '../data/protectedAccount';

const DAY = 86_400;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

/**
 * #3379 B2 — protected mode's writes. The record lives in the account's vault:
 * each write is the vault's `protect(bytes)` carrying one VaultProtection call,
 * authorized directly by the connected wallet (`directAuth`), and sent to the
 * ACCOUNT's vault whoever sends it (the owner, a signer, a nominee). A write
 * that changes the posture (a lock, a switch-on, a completed move) is followed
 * by the Diamond's `applyProtection(account)`, which applies the platform side.
 */
function useProtectionWrites(account: `0x${string}` | undefined, vault: `0x${string}` | null) {
  const { address } = useActiveChain();
  const { write } = useDiamondWrite();
  /** `fn` with `args` (the Auth is appended unless `auth` is false). */
  const protect = (fn: string, args: readonly unknown[] = [], auth = true) => {
    if (!vault || !address) throw new Error(copy.protection.unavailable);
    return write('protect', [protectionCall(fn, auth ? [...args, directAuth(address)] : args)], {
      target: { address: vault, abi: VaipakamVaultImplementationABI as Abi },
    });
  };
  const apply = () => write('applyProtection', [account]);
  return { protect, apply, write };
}

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
  const { address, walletChain } = useActiveChain();
  const { protect, apply, write } = useProtectionWrites(account, snap.vault);
  const { busy, error, done, run } = useRunner();
  const nowSec = useNowSec();
  const p = copy.protection;
  const record = snap.record!;
  // #3205: the position-NFT queue exists only on a legacy-mode chain; a
  // standalone chain protects the NFTs with the PositionNFT holder lock.
  const legacyNfts = snap.nftMode === 'legacy';
  const now = chainNowOf(snap, nowSec);
  const manager = isManager(account, record, address);
  // A new primary's cool-down: no loosening change (an unlock included) can
  // be requested until it ends, so none is offered.
  const cooling = now < record.cooldownUntil;
  // The contract refuses every loosening request while the account is in
  // that cool-down OR locked (an unlock request aside, which is how a lock
  // ends), so neither state offers one.
  const loosenBlocked = cooling || record.locked;
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
  // The one rule for stopping or redirecting a replacement (the contract's
  // cancelReplacement and proposeReplacement): a recovery signer always may;
  // the manager may unless a signer holds a lock on the account.
  const managerHeldBySignerLock = manager && !signer && record.locked && lockedBySigner;
  const mayStopOrRedirectMove = signer || (manager && !managerHeldBySignerLock);
  const [delayChoice, setDelayChoice] = useState(Math.round(record.delaySeconds / DAY) || 3);
  const bounds = snap.delayBounds ?? { min: 2 * DAY, max: 5 * DAY };
  const dayOptions: number[] = [];
  for (let d = Math.ceil(bounds.min / DAY); d <= Math.floor(bounds.max / DAY); d++) dayOptions.push(d);

  const tx = (fn: string, args: readonly unknown[]) => run(() => write(fn, args));
  /** A vault protected-mode write, then the platform side when `applyAfter`. */
  const ptx = (fn: string, args: readonly unknown[] = [], applyAfter = false, auth = true) =>
    run(async () => {
      await protect(fn, args, auth);
      if (applyAfter) await apply();
    });
  // The old Diamond CHANGE_* kinds, routed to where each change now waits:
  // the vault (delay, switch-off, unlock) or the Diamond (co-sign, pin).
  const vaultKind: Readonly<Record<number, number>> = {
    1: VAULT_SETTING.disable,
    2: VAULT_SETTING.delay,
    5: VAULT_SETTING.unlock,
  };
  const cancelChange = (kind: number) =>
    vaultKind[kind] !== undefined ? ptx('cancelSetting', [vaultKind[kind]]) : tx('cancelSettingChange', [account, kind]);
  const applyDueChanges = () =>
    run(async () => {
      const due = pending.filter((c) => isDue(c.at, now) && !disableWaits(c));
      if (due.some((c) => vaultKind[c.kind] !== undefined)) await protect('finalizeSettings', [], false);
      if (due.some((c) => c.kind === 4)) await write('finalizeSettingChanges', [account]);
      // An unlock or a switch-off changes the posture the platform applies.
      if (due.some((c) => c.kind === 1 || c.kind === 5)) await apply();
    });
  // TODO(#3321 positionNft-legacy-removal): the legacy queue writes, sent
  // through the frozen pre-#3205 fragment.
  const txLegacyNft = (fn: string, args: readonly unknown[]) =>
    run(() =>
      write(fn, args, { target: { address: walletChain!.diamondAddress, abi: LEGACY_DIAMOND_NFT_ABI } }),
    );

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
  // Switching protection off completes only once no payout or position
  // transfer is open (the contract's finalize applies every other due change
  // and leaves the switch-off waiting, or refuses when it is the only one).
  // So a due switch-off counts as ready only when both queues are read and
  // empty; otherwise its row says what it waits for.
  const openRows =
    snap.payouts === null || snap.transfers === null ? null : snap.payouts.length + snap.transfers.length;
  const disableWaits = (c: { key: string; at: bigint }) =>
    c.key === 'disable' && isDue(c.at, now) && openRows !== 0;
  const anyDue = pending.some((c) => isDue(c.at, now) && !disableWaits(c));
  const repl = snap.replacement;
  // One verdict for where the move stands, by the contract's completion rule.
  const replStage = repl && hasReplacement(repl) ? replacementStage(repl, record, account, snap.signers, now) : null;

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
          {!legacyNfts
            ? snap.holderLock === null
              ? p.nftLockUnknown
              : snap.holderLock.locked
                ? p.summaryNftLockOn
                : p.summaryNftLockOff
            : record.retired && !record.protectNfts
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

      {/* #3204 — a vault version pin is no longer a protection setting;
          it waits at the VaultBeacon and moves to the vault page (#3281). */}
      <p className="row-sub">{p.pinMovedNote}</p>

      {pending.length > 0 ? (
        <section className="card">
          <h2 className="card-title">{p.changesTitle}</h2>
          {pending.map((c) => (
            <div key={c.key} className="item-row">
              <span className="row-main">
                <span className="row-title">{c.label}</span>
                <br />
                <span className="row-sub">
                  {disableWaits(c)
                    ? openRows === null
                      ? p.changeDisableRowsUnknown
                      : p.changeDisableWaitsForRows(String(openRows))
                    : isDue(c.at, now)
                      ? p.changeDue
                      : p.changeAt(when(c.at))}
                </span>
              </span>
              {canGuard ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => cancelChange(c.kind)}
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
              onClick={applyDueChanges}
            >
              {p.applyChanges}
            </button>
          ) : null}
        </section>
      ) : null}

      {manager && cooling ? (
        <p className="banner banner-warn" role="status">{p.cooldownNote(when(record.cooldownUntil))}</p>
      ) : null}
      {manager && record.locked && !cooling ? (
        <p className="muted" role="status">{p.lockedLoosenNote}</p>
      ) : null}
      {(canGuard && !record.locked) || signerMayLockOver ? (
        <section className="card">
          <h2 className="card-title">{p.lockTitle}</h2>
          <p>{signerMayLockOver ? p.lockOverBody : p.lockBody}</p>
          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => ptx('lock', [], true)}>
            {asSigner ? p.lockAccount : p.lockNow}
          </button>
        </section>
      ) : null}
      {manager && record.locked && record.pendingUnlockAt === 0n ? (
        <section className="card">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy || cooling}
            onClick={() => ptx('requestUnlock')}
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

      {legacyNfts &&
      (record.protectNfts || record.retired || (snap.transfers?.length ?? 0) > 0 || snap.transfers === null) ? (
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
                    {(() => {
                      // The same order the contract checks a release in.
                      const st = payoutStatus(t, record, now);
                      return st === 'locked'
                        ? p.statusLockedRow
                        : st === 'waiting'
                          ? p.statusWaiting(when(t.releaseAt))
                          : st === 'needsCosign'
                            ? p.statusNeedsCosign
                            : p.statusDue;
                    })()}
                  </span>
                </span>
                <span className="cluster">
                  {payoutStatus(t, record, now) === 'due' ? (
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() => txLegacyNft('releasePositionTransfer', [t.id])}
                    >
                      {p.release}
                    </button>
                  ) : null}
                  {signer && record.requireCosign && !t.cosigned ? (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={busy}
                      onClick={() => txLegacyNft('cosignPositionTransfer', [t.id])}
                    >
                      {p.cosign}
                    </button>
                  ) : null}
                  {canGuard ? (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={busy}
                      onClick={() => txLegacyNft('cancelPositionTransfer', [t.id])}
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
                onSubmit={(id, to) => txLegacyNft('queuePositionTransfer', [id, to])}
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
              disabled={busy || delayChoice * DAY === record.delaySeconds || (loosenBlocked && delayChoice * DAY < record.delaySeconds)}
              onClick={() =>
                // A raise applies at once, and the platform carries it
                // (applyProtection); a lowering waits the delay at the vault.
                ptx('setDelay', [delayChoice * DAY], delayChoice * DAY > record.delaySeconds)
              }
            >
              {p.setDelay}
            </button>
          </div>
          <div className="cluster">
            {record.retired ? null : legacyNfts ? (
              // A replaced account delays position NFT transfers whatever the
              // setting says, so the toggle is not offered there.
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy || (loosenBlocked && record.protectNfts)}
                onClick={() =>
                  // #3379 B2: the Diamond's NFT setting is retired; switching
                  // on is `lockPositionNfts`. There is no Diamond switch-off.
                  record.protectNfts ? undefined : tx('lockPositionNfts', [account])
                }
              >
                {record.protectNfts ? p.nftsOff : p.nftsOn}
              </button>
            ) : snap.holderLock?.locked ? null : (
              // Standalone: protection can only switch the holder lock ON;
              // unlocking is the holder's own, at the PositionNFT.
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => tx('lockPositionNfts', [account])}
              >
                {p.nftLockNow}
              </button>
            )}
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy || (!record.requireCosign && (snap.signers?.length ?? 0) === 0) || (loosenBlocked && record.requireCosign)}
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
                disabled={busy || loosenBlocked}
                onClick={() => ptx('requestDisable')}
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
                  onClick={() => ptx('removeAllowlisted', [a])}
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
          onCancel={(a) => ptx('cancelAllowlisted', [a])}
          onActivate={(a) => ptx('finalizeAllowlisted', [a], false, false)}
        />
        {manager && !record.retired ? (
          // A replaced account's payouts go only to its controller: the
          // contract refuses every allowlist addition for it.
          <AddressAction
            placeholder={p.addressPlaceholder}
            label={p.addAddress}
            disabled={busy || loosenBlocked}
            onSubmit={(a) => ptx('addAllowlisted', [a])}
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
                  disabled={busy || loosenBlocked}
                  onClick={() => ptx('signerChange', [VAULT_SIGNER.remove, s.signer])}
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
                  onClick={() => ptx('signerChange', [VAULT_SIGNER.cancel, s.signer])}
                >
                  {p.cancel}
                </button>
              ) : null}
              {s.removeAt > 0n && isDue(s.removeAt, now) ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => ptx('finalizeSigner', [s.signer], false, false)}
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
          onCancel={(a) => ptx('signerChange', [VAULT_SIGNER.cancel, a])}
          onActivate={(a) => ptx('finalizeSigner', [a], false, false)}
        />
        {manager ? (
          <>
            <AddressAction
              placeholder={p.addressPlaceholder}
              label={p.inviteSigner}
              disabled={busy || loosenBlocked}
              onSubmit={(a) => ptx('signerChange', [VAULT_SIGNER.add, a])}
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
            {/* B2: the vault does not expose its approval tally; an unknown
                count is shown as unknown, never as zero. */}
            <p>{p.replacementLine(shortAddress(repl!.nominee), repl!.approvals ?? '?', repl!.threshold)}</p>
            {replStage === 'scheduled' || replStage === 'due' ? <p>{p.replacementReady(when(repl!.readyAt))}</p> : null}
            {replStage === 'quorumLost' ? <p className="banner banner-warn">{p.replacementQuorumLost}</p> : null}
            {replStage === 'nomineeIsSigner' ? <p className="banner banner-warn">{p.replacementNomineeIsSigner}</p> : null}
            {replStage === null ? <p className="banner banner-warn">{p.replacementStageUnknown}</p> : null}
            {signer ? (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => ptx('replacement', [VAULT_REPLACE.approve, repl!.nominee])}
              >
                {p.approveReplacement}
              </button>
            ) : null}
            {managerHeldBySignerLock ? (
              <p className="muted" role="status">{p.signerLockHoldsMove}</p>
            ) : null}
            {mayStopOrRedirectMove ? (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => ptx('replacement', [VAULT_REPLACE.cancel, ZERO_ADDRESS])}
              >
                {p.cancel}
              </button>
            ) : null}
            {replStage === 'due' ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => ptx('finalizeReplacement', [], true, false)}
              >
                {p.finalizeReplacement}
              </button>
            ) : null}
          </>
        )}
        {/* A secondary signer proposes (approved by a signer majority); the
            manager may also propose its own move, which waits the delay, but
            not while a signer holds a lock on the account. */}
        {mayStopOrRedirectMove && repl !== null && !hasReplacement(repl) ? (
          <AddressAction
            placeholder={p.nomineePlaceholder}
            label={p.proposeReplacement}
            disabled={busy}
            onSubmit={(a) => ptx('replacement', [VAULT_REPLACE.propose, a])}
          />
        ) : null}
      </section>
    </div>
  );
}

/**
 * #3205 — the PositionNFT holder lock on the connected wallet's own tokens
 * (standalone mode). Lock, ask to unlock and cancel act on the caller; the
 * unlock, once its delay has passed, can be applied by anyone.
 */
/** #3205 — the connected wallet's own PositionNFT holder lock, on a standalone
 *  chain. Rendered at the page root, not inside the protected-account view:
 *  the lock outlives protected mode (switching protection off cannot unlock
 *  the holder), so its state and unlock controls must show whether or not
 *  protected mode is on (#3318 Codex r3). */
function OwnHolderLock({ snap, holder }: { snap: ProtectedAccountSnapshot; holder: `0x${string}` }) {
  const nowSec = useNowSec();
  if (snap.nftMode !== 'standalone') return null;
  return <HolderLockCard lock={snap.holderLock} holder={holder} now={chainNowOf(snap, nowSec)} />;
}

function HolderLockCard({
  lock,
  holder,
  now,
}: {
  lock: HolderLockState | null;
  holder: `0x${string}`;
  now: bigint;
}) {
  const { write } = useDiamondWrite();
  const { walletChain } = useActiveChain();
  const { busy, error, done, run } = useRunner();
  const p = copy.protection;
  const nft = (fn: string, args: readonly unknown[]) =>
    run(() => write(fn, args, { target: { address: walletChain!.positionNft.nft, abi: POSITION_NFT_ABI } }));
  return (
    <section className="card" data-testid="holder-lock">
      <h2 className="card-title">{p.nftLockTitle}</h2>
      {lock === null ? (
        <p className="banner banner-warn">{p.nftLockUnknown}</p>
      ) : (
        <>
          <p>{lock.locked ? p.nftLockOn : p.nftLockOff}</p>
          <p className="muted">
            {lock.delay > 0n ? p.nftLockDelay(days(Number(lock.delay))) : p.nftLockNoDelay}
          </p>
          {lock.unlockAt > 0n ? (
            <p role="status">{isDue(lock.unlockAt, now) ? p.nftUnlockDue : p.nftUnlockPending(when(lock.unlockAt))}</p>
          ) : null}
          {lock.lowerAt > 0n ? (
            <p className="muted">{p.nftLowerPending(days(Number(lock.lowerDelay)), when(lock.lowerAt))}</p>
          ) : null}
          <div className="cluster">
            {!lock.locked ? (
              <button type="button" className="btn btn-danger" disabled={busy} onClick={() => nft('lock', [])}>
                {p.nftLockNow}
              </button>
            ) : lock.unlockAt === 0n ? (
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => nft('requestUnlock', [])}>
                {p.requestUnlock}
              </button>
            ) : (
              <>
                {isDue(lock.unlockAt, now) ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={() => nft('executeUnlock', [holder])}
                  >
                    {p.nftExecuteUnlock}
                  </button>
                ) : null}
                <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => nft('cancelUnlock', [])}>
                  {p.nftCancelUnlock}
                </button>
              </>
            )}
          </div>
        </>
      )}
      <p className="muted">{p.nftLockNote}</p>
      <Feedback error={error} done={done} />
    </section>
  );
}

/** Enable form for an account with protection off. */
function EnableForm({ snap }: { snap: ProtectedAccountSnapshot }) {
  const { address, walletChain } = useActiveChain();
  const { write } = useDiamondWrite();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const { busy, error, done, run } = useRunner();
  /** #3379 B2: the switch-on is the vault's. Like the retired Diamond entry,
   *  it first makes sure the wallet has a vault; then turns protection on at
   *  the vault, holds the position NFTs when asked, and applies the platform
   *  side. */
  async function enable(delaySeconds: number, nfts: boolean) {
    if (!address || !walletChain || !publicClient) throw new Error(copy.errors.walletConnectFirst);
    let vault = snap.vault;
    if (!vault) {
      await write('getOrCreateUserVault', [address]);
      vault = (await publicClient.readContract({
        address: walletChain.diamondAddress,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'getUserVaultAddress',
        args: [address],
      })) as `0x${string}`;
    }
    await write('protect', [protectionCall('enable', [delaySeconds, directAuth(address)])], {
      target: { address: vault, abi: VaipakamVaultImplementationABI as Abi },
    });
    if (nfts) await write('lockPositionNfts', [address]);
    await write('applyProtection', [address]);
  }
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
        <input type="checkbox" checked={nfts} onChange={(e) => setNfts(e.target.checked)} />{' '}
        {snap.nftMode === 'legacy' ? p.protectNftsLabel : p.protectNftsLockLabel}
      </label>
      <button
        type="button"
        className="btn btn-primary"
        disabled={busy}
        onClick={() => run(() => enable(delay * DAY, nfts))}
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
  const { protect } = useProtectionWrites(account, snap.data?.vault ?? null);
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
                onCancel={(a) => run(() => protect('signerChange', [VAULT_SIGNER.cancel, a]))}
                onActivate={(a) => run(() => protect('finalizeSigner', [a], false))}
              />
              {nomination.accepted === false ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => run(() => protect('signerChange', [VAULT_SIGNER.accept, address]))}
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
          <OwnHolderLock snap={data} holder={address} />
          {retired.data ? <RetiredAccountCard account={retired.data} /> : null}
          {retired.isError ? <UnavailableState body={p.managedAccountUnknown} /> : null}
          <SignerEntryCard />
        </div>
      )}
    </div>
  );
}
