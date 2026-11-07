// apps/keeper/src/protectedAccount.ts
//
// #3088 / #2984 — the PROTECTED ACCOUNT pass: the permissionless steps of
// protected account mode that nothing else calls on a schedule. Each one is
// open to anyone; without a keeper it waits until the owner, a signer or
// someone else makes the call by hand.
//
// Per chain, per run (every minute): the two Telegram steps when armed
// (`protectedTelegram.ts`: owner alerts, then LOCK), then the steps below, in
// an order rotated one place a run (`stepOrder`):
//
//   1. RELEASE — pay each queued payout whose delay has passed
//      (`VaultPayoutFacet.releasePayout`) and move each queued position-NFT
//      transfer whose delay has passed (`VaipakamNFTFacet.
//      releasePositionTransfer`). A row is sent only when the chain's own
//      record says it can go: still queued, past its release time by the
//      block's clock, its account not locked and with no open Telegram LOCK
//      request, and, while the account requires a co-sign, co-signed. A payout whose destination has left the account's
//      allowlist is cancelled by the release itself (the asset stays in the
//      vault); the run names it apart from a paid one. A recipient the
//      sanctions screen flags makes the release revert and the row stays
//      queued: the run names the refusal and tries again next run.
//   2. FINALIZE — apply each pending change whose delay has passed: the
//      account's setting changes (`finalizeSettingChanges`: a lowered delay,
//      NFT protection or the co-sign requirement switched off, an unlock,
//      switching the mode off — which waits while the account has
//      open rows, and is counted waiting when the chain says so), an
//      allowlist addition that has not expired (`finalizeAddAllowlisted`),
//      a signer addition the nominee has accepted and that has not expired
//      (`finalizeAddSigner`); each addition expires one delay after it
//      matures, as the chain refuses it then; a signer removal
//      (`finalizeRemoveSigner`) and a scheduled replacement of the primary
//      wallet that still has the approvals it needs (`finalizeReplacement`).
//      Nothing that is not due is sent, and nothing is sent for a locked
//      account except what an unlock itself needs.
//
// The work is nominated by the indexer's event ledger: `PayoutQueued` and
// `PositionTransferQueued` for step 1, the `*Requested` / `Scheduled` events
// for step 2. Each step reads its own page a run, from where the last run
// stopped and wrapping round, above a floor every row before which is
// finished (`ledgerRotation.ts`). A row is finished only when the chain shows
// it so at the finalized block: a payout or transfer no longer queued, a
// change whose pending time no longer equals the one its event announced
// (applied, cancelled or replaced by a newer request). Every decision is the
// chain's own record against the chain's own clock; a row only nominates.
// A page's records and the settings of the accounts its events name are read
// in one batch, so the settings never wait behind the records; and each run
// tries the page from a different row (`ledgerRotation.attemptOrder`), so a
// run of slow refusals at its top cannot keep a row below them unsent.
//
// Every call is simulated on the current state first and waits for its
// receipt before the next (`stepSender.ts`). None carries value from the
// keeper, and none moves value to it: a release pays the account's own
// recipient from the account's own vault. Needs no on-chain role.
//
// Gated by KEEPER_ENABLED + PROTECTED_ACCOUNT_ENABLED. Ships disarmed.

import { createPublicClient, decodeEventLog, http, type Abi, type Address, type Hex, type PublicClient } from 'viem';
import { ProtectedAccountFacetABI, VaipakamDiamondABI, VaipakamNFTFacetABI, VaultDepositoryFacetABI, VaultPayoutFacetABI } from '@vaipakam/contracts/abis';
import type { ChainConfig, Env } from './env';
import { getChainConfigs } from './env';
import { buildKeeperContext, passIsArmed, subStepArmed, type KeeperContext } from './keeper';
import { AlertDelivery, type Alert, type DeliveryOutcome } from './alertDelivery';
import { alertOwners, d1ProtectedStore, LOCK_REQUEST_TTL_SEC, lockFromTelegram, type AlertReport, type LockResult, type ProtectedStore } from './protectedTelegram';
import type { PassTick } from './passSchedule';
import { deadlineClient, PastRunDeadline } from './batchRead';
import { shortErr } from './callErrors';
import { d1EventLedger, type EventLedger, type LedgerRow } from './eventLedger';
import { attemptOrder, readLedgerRotation, type LedgerRotation } from './ledgerRotation';
import { d1ScanCursors, type FinalBlock, type ScanCursors } from './scanCursors';
import { boundedCall, PassReader } from './passReader';
import { StepSender } from './stepSender';
import { leadStageCutoffMs, runIndex } from './runWindow';

/** Only the functions and events this pass names, plus every Diamond error. */
const PICK: ReadonlySet<string> = new Set([
  'releasePayout',
  'lockVaultFor',
  'requestCode',
  'getPendingPayout',
  'getPendingPositionTransfer',
  'releasePositionTransfer',
  'getProtectedAccount',
  'getSignerChange',
  'getAllowlistPendingAt',
  'getReplacement',
  'finalizeSettingChanges',
  'finalizeAddAllowlisted',
  'finalizeAddSigner',
  'finalizeRemoveSigner',
  'finalizeReplacement',
  'PayoutReleased',
  'PayoutCancelled',
  // What applying each change emits ({@link changeApplied}).
  'SettingChangeApplied',
  'ProtectedModeDisabled',
  'AllowlistAdded',
  'SignerAdded',
  'SignerRemoved',
  'PrimaryReplaced',
]);
const pick = (abi: unknown) => (abi as Abi).filter((x) => x.type === 'error' || ('name' in x && PICK.has(x.name)));
export const ABI = dedupe([
  ...pick(VaultPayoutFacetABI),
  ...pick(VaipakamNFTFacetABI),
  ...pick(ProtectedAccountFacetABI),
  ...pick(VaultDepositoryFacetABI),
  ...(VaipakamDiamondABI as Abi).filter((x) => x.type === 'error'),
]);

function dedupe(abi: Abi): Abi {
  const seen = new Set<string>();
  return abi.filter((x) => {
    const k = JSON.stringify(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }) as Abi;
}

/** The pass's cadence, in seconds; the scheduler reads it from here. A
 *  release is due to the second its delay ends, so a run every minute keeps
 *  the wait the owner chose from growing by more than that. */
export const PASS_CADENCE_SEC = 60;
/** Sends per step per chain per run. Each step has its own share, so a
 *  long payout queue cannot leave an unlock, a replacement or a signer
 *  addition (which expires) unsent run after run, and a burst of Telegram
 *  LOCK requests cannot hold back the rest (`StepSender.stepBudgets`). */
export const STEP_SENDS: Readonly<Record<string, number>> = { lock: 4, release: 4, transfer: 4, finalize: 4 };
/** The three steps, in the order of the run whose index is 0. */
export const STEP_NAMES = ['release', 'transfer', 'finalize'] as const;
export type StepName = (typeof STEP_NAMES)[number];

/**
 * The order the steps run in on run `visit`: rotated one place a run, so
 * each step goes first one run in three. A share of sends (`STEP_SENDS`)
 * bounds how many calls a step makes; it does not bound how long they take,
 * since every send waits for its receipt. On a chain with slow blocks a step
 * that always ran first could use the whole read window run after run and
 * leave the later steps unread. Rotated, every step starts a run with the
 * whole window at least every third run, so a due unlock, replacement or
 * signer addition waits at most two runs behind a payout queue.
 */
export function stepOrder(visit: number): readonly StepName[] {
  const k = ((Math.trunc(visit) % STEP_NAMES.length) + STEP_NAMES.length) % STEP_NAMES.length;
  return [...STEP_NAMES.slice(k), ...STEP_NAMES.slice(0, k)];
}

/** The share of the read window the owner alerts may use. They run first,
 *  so no receipt wait holds them back; the share keeps a slow channel from
 *  using the time the LOCK step and the releases after them need. */
export const ALERT_STAGE_SHARE = 1 / 3;
/** The share of what is left of the read window the LOCK step may start
 *  locks in. It runs before every release, so without a bound a stream of
 *  LOCK requests with slow receipts would take the whole window each run and
 *  no release or finalize would ever run (Codex #3092 r10). A lock started
 *  inside the share may finish past it; the releases keep the rest. */
export const LOCK_STAGE_SHARE = 1 / 2;

/** Sends per chain per run: every step's share, and no more. */
export const MAX_SENDS_PER_RUN = Object.values(STEP_SENDS).reduce((a, b) => a + b, 0);
export const RECEIPT_TIMEOUT_MS = 30_000;
/** Ledger rows read per step per run, rotating above the step's floor. */
export const PAGE = 200;
export const PAYOUT_FLOOR_ITEM = 'payout-floor';
export const PAYOUT_NEXT_ITEM = 'payout-next';
export const TRANSFER_FLOOR_ITEM = 'transfer-floor';
export const TRANSFER_NEXT_ITEM = 'transfer-next';
export const CHANGE_FLOOR_ITEM = 'change-floor';
export const CHANGE_NEXT_ITEM = 'change-next';

/** `LibProtectedAccount.ROW_*`. */
const ROW_QUEUED = 1;
/** A row the chain does not hold reads as state 0 (never queued). */
const ROW_NONE = 0;

/** `ProtectedAccountFacet.CHANGE_*` → the `ProtectedAccount` field that holds
 *  when that change matures. */
export const SETTING_FIELD: Readonly<Record<number, keyof ProtectedAccount>> = {
  1: 'pendingDisableAt',
  2: 'pendingDelayAt',
  3: 'pendingNftOffAt',
  4: 'pendingCosignOffAt',
  5: 'pendingUnlockAt',
  // 6 (unpin) retired by #3204: a pin change waits at the VaultBeacon, and
  // its keeper pass is #3282.
};
const SETTING_NAME: Readonly<Record<number, string>> = {
  1: 'switch-off',
  2: 'lower-delay',
  3: 'nft-protection-off',
  4: 'cosign-off',
  5: 'unlock',
};
/** The switch-off, which waits for the account's open rows. */
const CHANGE_DISABLE = 1;

export const PAYOUT_EVENT = 'PayoutQueued';
export const TRANSFER_EVENT = 'PositionTransferQueued';
export const CHANGE_EVENTS = [
  'SettingChangeRequested',
  'AllowlistAddRequested',
  'SignerAddRequested',
  'SignerRemoveRequested',
  'ReplacementScheduled',
] as const;

/** Refusals that mean another caller got there first. */
export const RACES = new Set(['RowNotQueued', 'ChangeNotRequested', 'NoReplacementProposed']);
export const PAUSED_REFUSAL = 'EnforcedPause';
/** `finalizeSettingChanges` when the only due change is a switch-off that
 *  waits for open rows: a wait, not a refusal. */
const SWITCH_OFF_WAITS = 'PendingRowsExist';

/** `LibVaipakam.ProtectedAccount`, as the view returns it. */
export interface ProtectedAccount {
  enabled: boolean;
  locked: boolean;
  protectNfts: boolean;
  requireCosign: boolean;
  retired: boolean;
  delaySeconds: number;
  pendingDelay: number;
  pendingDelayAt: bigint;
  pendingDisableAt: bigint;
  pendingUnlockAt: bigint;
  pendingNftOffAt: bigint;
  pendingCosignOffAt: bigint;
  cooldownUntil: bigint;
  lockedAt: bigint;
  lockedBy: Address;
  controller: Address;
  /** #3204 — retired; a pending pin change is held by the VaultBeacon. */
  retiredPendingUnpinAt: bigint;
}

interface PendingPayout {
  user: Address;
  kind: number;
  state: number;
  cosigned: boolean;
  releaseAt: bigint;
  asset: Address;
  recipient: Address;
  tokenId: bigint;
  amount: bigint;
  delivered: bigint;
}

interface PendingTransfer {
  from: Address;
  state: number;
  releaseAt: bigint;
  to: Address;
  tokenId: bigint;
}

interface SignerChange {
  addAt: bigint;
  accepted: boolean;
  removeAt: bigint;
}

interface ReplacementProposal {
  nominee: Address;
  proposedBy: Address;
  readyAt: bigint;
  round: number;
  approvals: number;
}

/** One pending change an event announced, keyed by what its event named. */
export type Change =
  | { t: 'setting'; account: Address; kind: number; at: bigint }
  | { t: 'allow'; account: Address; other: Address; at: bigint }
  | { t: 'signerAdd'; account: Address; other: Address; at: bigint }
  | { t: 'signerRemove'; account: Address; other: Address; at: bigint }
  | { t: 'replace'; account: Address; other: Address; at: bigint };

/** What one chain's run reads and signs with. Injected so a run is testable. */
export interface ProtectedDeps {
  /** Deadline-bound client: single reads and the clock. */
  client: PublicClient;
  /** Plain client for the batched reads, which carry the deadline themselves. */
  readClient: PublicClient;
  context: () => KeeperContext | null;
  sendDeadline: number;
  cursors: ScanCursors;
  ledger: EventLedger;
  /** Which run this is (`runIndex`), for the rotated batched reads. */
  visit?: number;
  /** The Telegram steps (`protectedTelegram.ts`); each off when its flag is. */
  telegram?: {
    lock: boolean;
    alerts: boolean;
    store: ProtectedStore;
    notify: (alert: Alert) => Promise<DeliveryOutcome>;
    appOrigin: string;
    nowSec?: () => number;
  };
}

/** What a run did on one chain: its log line's figures, and what tests read. */
export interface ProtectedReport {
  chainId: number;
  skipped?: string;
  /** Payout ids paid this run, with what the recipient received. */
  released: { id: bigint; delivered: bigint }[];
  /** Payout ids the release cancelled (destination no longer allowed). */
  cancelled: bigint[];
  /** Position-transfer ids moved this run. */
  transferred: bigint[];
  /** Changes applied this run, as `kind:account[:other]`. */
  finalized: string[];
  /** Rows not sent this run for a reason the chain states, by reason. */
  waiting: Map<string, number>;
  /** Each LOCK request worked this run, with how it ended and whether its
   *  answer reached the chat; null when the LOCK step is off. */
  locks: LockResult[] | null;
  /** The alert step's figures; null when it is off. */
  alerts: AlertReport | null;
  refused: Map<string, string>;
  unread: Map<string, string>;
  /** Steps that used their whole share of sends this run; what they left
   *  stays queued for the next run. */
  budgetReached: Set<string>;
  stopped: string | null;
}

export async function runProtectedAccount(env: Env, tick: PassTick): Promise<void> {
  if (!passIsArmed(env, 'protectedAccount', 'PROTECTED_ACCOUNT_ENABLED')) return;
  const lock = subStepArmed(env, 'protectedAccount', 'Telegram LOCK', 'PROTECTED_LOCK_ENABLED');
  const alertsOn = subStepArmed(env, 'protectedAccount', 'owner alerts', 'PROTECTED_ALERTS_ENABLED');
  const delivery = new AlertDelivery(env);
  const store = d1ProtectedStore(env.DB);
  const appOrigin = env.FRONTEND_ORIGIN ?? '';
  const sendDeadline = tick.deadlineMs;
  const visit = runIndex(tick, PASS_CADENCE_SEC * 1000);
  const ledger = d1EventLedger(env.DB);
  const chains = getChainConfigs(env).filter((c) => c.diamond);
  // Chains side by side (runWindow.ts, rule 1): each has its own nonce lane.
  await Promise.all(
    chains.map(async (chain: ChainConfig) => {
      try {
        const plain = createPublicClient({ transport: http(chain.rpc) }) as PublicClient;
        const client = deadlineClient(plain, sendDeadline);
        const report = await protectedOnce(chain.id, chain.diamond as Address, {
          client,
          readClient: plain,
          context: () => buildKeeperContext(env, chain, client, { notAfterMs: sendDeadline }),
          sendDeadline,
          cursors: d1ScanCursors(env.KEEPER_DB, chain.id, chain.diamond as string, 'protectedAccount'),
          ledger,
          visit,
          telegram: { lock, alerts: alertsOn, store, notify: (a) => delivery.deliver(a), appOrigin },
        });
        console.log(describeReport(report));
      } catch (err) {
        console.error(`[keeper] protectedAccount chain=${chain.id} failed: ${shortErr(err)}`);
      }
    }),
  );
  delivery.disclose('protectedAccount');
}

/** The run's one line for a chain. */
export function describeReport(r: ProtectedReport): string {
  if (r.skipped) return `[keeper] protectedAccount chain=${r.chainId}: not worked this run: ${r.skipped}`;
  const parts = [
    `[keeper] protectedAccount chain=${r.chainId}`,
    `payouts-released=${r.released.map((x) => `${x.id}(delivered ${x.delivered})`).join(',') || 'none'}`,
    ...(r.cancelled.length > 0 ? [`payouts-cancelled-by-release=${r.cancelled.join(',')} (destination no longer allowed; the asset stays in the vault)`] : []),
    `transfers-released=${r.transferred.join(',') || 'none'}`,
    `changes-finalized=${r.finalized.join(',') || 'none'}`,
    ...(r.locks === null
      ? []
      : [`telegram-locks=${r.locks.map((l) => `${l.wallet.slice(0, 10)}(${l.outcome}${l.answered === false ? ', answer not delivered' : ''})`).join(',') || 'none'}`]),
    ...(r.alerts === null
      ? []
      : [
          `owner-alerts=sent ${r.alerts.sent}, retrying ${r.alerts.retrying}, undelivered ${r.alerts.undelivered}, stale ${r.alerts.stale}, unsubscribed ${r.alerts.unsubscribed}`,
        ]),
    ...(r.waiting.size > 0 ? [`waiting=${[...r.waiting].map(([k, v]) => `${k}(${v})`).join(',')}`] : []),
    ...(r.refused.size > 0 ? [`refused=${[...r.refused].map(([k, v]) => `${k}(${v})`).join(',')}`] : []),
    ...(r.unread.size > 0 ? [`unread=${[...r.unread].map(([k, v]) => `${k}(${v})`).join(',')}`] : []),
    ...(r.budgetReached.size > 0 ? [`step-budget-reached=${[...r.budgetReached].join(',')} (the rest waits for the next run)`] : []),
    ...(r.stopped ? [`stopped=${r.stopped}`] : []),
  ];
  return parts.join(' ');
}

/** One chain's run. Exported for tests. */
export async function protectedOnce(chainId: number, diamond: Address, deps: ProtectedDeps): Promise<ProtectedReport> {
  const sender = new StepSender(
    {
      pass: 'protectedAccount',
      abi: ABI,
      maxSends: MAX_SENDS_PER_RUN,
      stepBudgets: STEP_SENDS,
      receiptTimeoutMs: RECEIPT_TIMEOUT_MS,
      races: RACES,
      pausedRefusal: PAUSED_REFUSAL,
      unrecorded: new Set([SWITCH_OFF_WAITS]),
      describe: (s) => String(s),
      spends: 'the gas',
    },
    { context: deps.context, sendDeadline: deps.sendDeadline },
  );
  const report: ProtectedReport = {
    chainId,
    released: [],
    cancelled: [],
    transferred: [],
    finalized: [],
    waiting: new Map(),
    locks: deps.telegram?.lock === true ? [] : null,
    alerts: deps.telegram?.alerts === true ? { sent: 0, undelivered: 0, retrying: 0, stale: 0, unsubscribed: 0 } : null,
    refused: sender.refused,
    unread: sender.unread,
    budgetReached: sender.budgetReached,
    stopped: null,
  };
  const r = new Reader(deps, diamond);
  try {
    // The RPC must answer for this chain: a deterministic deployment can put
    // a Diamond at the same address on another chain.
    let served: number;
    try {
      served = await r.call('the chain id', (c) => c.getChainId());
    } catch (err) {
      if (err instanceof PastRunDeadline) throw err;
      return { ...report, skipped: `the RPC's chain id could not be read (${shortErr(err)})` };
    }
    if (served !== chainId) return { ...report, skipped: `the RPC configured for chain ${chainId} serves chain ${served}` };
    const step = new Step(r, sender, report, deps, chainId);
    // The alerts first: they send nothing on chain, so no receipt wait of
    // any step can use up their time, and a warning about a queued payout is
    // never held behind a lock or a queue of releases. They take only a
    // share of the read window (`ALERT_STAGE_SHARE`), so a slow channel
    // cannot in turn hold back the LOCK step. The LOCK next, before
    // any release: a lock cancels every queued row, so nothing is released
    // this run for an account its owner just asked to lock. And a request
    // the LOCK step could not reach this run (its share of sends used, the
    // read window spent) still holds back that account's releases: an owner's
    // LOCK is never overtaken by the payout it was sent to stop. The LOCK
    // step in turn starts locks only in a share of what is left
    // (`LOCK_STAGE_SHARE`), so a run of LOCK requests cannot hold back every
    // other owner's releases and matured changes run after run.
    const tg = deps.telegram;
    const tgDeps = tg
      ? {
          r,
          sender,
          cursors: deps.cursors,
          store: tg.store,
          ledger: deps.ledger,
          chainId,
          notify: tg.notify,
          canSign: () => deps.context() !== null,
          lockOn: tg.lock === true,
          appOrigin: tg.appOrigin,
          nowSec: tg.nowSec ?? (() => Math.floor(Date.now() / 1000)),
          markLocked: (w: Address) => step.markLocked(w),
          sendDeadline: deps.sendDeadline,
        }
      : null;
    if (tgDeps && tg!.alerts) {
      const stage = r.withCutoff(leadStageCutoffMs(Date.now(), r.cutoff, ALERT_STAGE_SHARE));
      report.alerts = await alertOwners({ ...tgDeps, r: stage }, r.cutoff);
    }
    if (tgDeps && tg!.lock) {
      report.locks = await lockFromTelegram(tgDeps, leadStageCutoffMs(Date.now(), r.cutoff, LOCK_STAGE_SHARE));
      await step.holdForLockRequests(tg!.store, tgDeps.nowSec());
    }
    const work: Record<StepName, () => Promise<void>> = {
      release: () => step.releasePayouts(),
      transfer: () => step.releaseTransfers(),
      finalize: () => step.finalizeChanges(),
    };
    // eslint-disable-next-line no-await-in-loop
    for (const name of stepOrder(deps.visit ?? 0)) await work[name]();
  } catch (err) {
    if (!(err instanceof PastRunDeadline)) throw err;
    sender.noteUnread('run', 'the run deadline passed during its reads');
  }
  report.stopped = sender.stopped ? sender.stopReason : null;
  return report;
}

/** The pass's reads, each stopped at the run's read cutoff (`passReader.ts`). */
class Reader extends PassReader {
  constructor(deps: ProtectedDeps, diamond: Address) {
    super(deps, deps.sendDeadline, diamond, ABI, 'protectedAccount');
  }
}

// ─── Ledger rows ────────────────────────────────────────────────────────────

const lower = (a: unknown): Address | null => {
  const s = String(a ?? '').toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(s) ? (s as Address) : null;
};
const uint = (v: unknown): bigint | null => {
  const s = String(v ?? '');
  return /^\d+$/.test(s) ? BigInt(s) : null;
};

/** The row id a `PayoutQueued` / `PositionTransferQueued` row names. */
export const rowId = (row: LedgerRow): bigint | null => uint(row.args.id);

/** The pending change a step-2 row announces; null when it names none. */
export function changeOf(row: LedgerRow): Change | null {
  const account = lower(row.args.account);
  if (account === null) return null;
  switch (row.kind) {
    case 'SettingChangeRequested': {
      const kind = Number(row.args.kind);
      const at = uint(row.args.effectiveAt);
      return SETTING_FIELD[kind] !== undefined && at !== null ? { t: 'setting', account, kind, at } : null;
    }
    case 'AllowlistAddRequested':
    case 'SignerAddRequested':
    case 'SignerRemoveRequested': {
      const other = lower(row.kind === 'AllowlistAddRequested' ? row.args.destination : row.args.signer);
      const at = uint(row.args.effectiveAt);
      if (other === null || at === null) return null;
      const t = row.kind === 'AllowlistAddRequested' ? 'allow' : row.kind === 'SignerAddRequested' ? 'signerAdd' : 'signerRemove';
      return { t, account, other, at };
    }
    case 'ReplacementScheduled': {
      const other = lower(row.args.nominee);
      const at = uint(row.args.readyAt);
      return other !== null && at !== null ? { t: 'replace', account, other, at } : null;
    }
    default:
      return null;
  }
}

export const changeId = (c: Change): string =>
  c.t === 'setting' ? `setting:${c.account}:${c.kind}:${c.at}` : `${c.t}:${c.account}:${c.other}:${c.at}`;

/** How a change reads in the run's line. */
const changeLabel = (c: Change): string =>
  c.t === 'setting' ? `${SETTING_NAME[c.kind]}:${c.account.slice(0, 10)}` : `${c.t}:${c.account.slice(0, 10)}:${c.other.slice(0, 10)}`;

// ─── The steps ──────────────────────────────────────────────────────────────

class Step {
  private now: bigint | null = null;
  /** Accounts read this run, at the head. */
  private readonly accounts = new Map<Address, ProtectedAccount | undefined>();

  constructor(
    private readonly r: Reader,
    private readonly sender: StepSender,
    private readonly report: ProtectedReport,
    private readonly deps: ProtectedDeps,
    private readonly chainId: number,
  ) {}

  /** Wallets with a LOCK request still open; null when they could not be
   *  read, and then nothing is released this run (`holdForLockRequests`). */
  private lockRequested: Set<Address> | null = new Set();

  /**
   * Read the wallets whose LOCK request is still open and young enough to be
   * acted on, and hold their payouts and position transfers until the LOCK
   * step reaches them. When the read fails, hold every release this run: a
   * release cannot be undone, and an owner who sent LOCK sent it to stop one.
   */
  async holdForLockRequests(store: ProtectedStore, nowSec: number): Promise<void> {
    try {
      this.lockRequested = await boundedCall(this.r.cutoff, 'the open LOCK requests', () =>
        store.pendingLockWallets(this.chainId, nowSec - LOCK_REQUEST_TTL_SEC),
      );
    } catch (err) {
      if (err instanceof PastRunDeadline) throw err;
      this.lockRequested = null;
      this.sender.noteUnread('release', `the open LOCK requests (${shortErr(err)}); no payout or transfer is released this run`);
    }
  }

  /** The lock step locked `wallet` this run: read it as locked from here on. */
  markLocked(wallet: Address): void {
    const a = this.accounts.get(wallet);
    this.accounts.set(wallet, { ...(a ?? ({ enabled: true } as ProtectedAccount)), locked: true });
  }

  private wait(why: string): void {
    this.report.waiting.set(why, (this.report.waiting.get(why) ?? 0) + 1);
  }

  /** The chain's clock, read once a run; null (and said) when unread. */
  private async clock(step: string): Promise<bigint | null> {
    if (this.now !== null) return this.now;
    try {
      this.now = (await this.r.call("the chain's clock", (c) => c.getBlock())).timestamp;
    } catch (err) {
      if (err instanceof PastRunDeadline) throw err;
      this.sender.noteUnread(step, `the chain's clock (${shortErr(err)})`);
      return null;
    }
    return this.now;
  }

  /** An account's settings as read this run; undefined until a read of
   *  them has come back. */
  private known(a: Address): boolean {
    return this.accounts.get(a) !== undefined;
  }

  /** Keep a settings answer that came back; an unread one changes nothing,
   *  so a later read this run may still fill it. */
  private learn(a: Address, got: unknown): void {
    if (got !== undefined && !this.known(a)) this.accounts.set(a, got as ProtectedAccount);
  }

  /** The accounts' settings at the head, for those not read yet this run. */
  private async readAccounts(accounts: readonly Address[]): Promise<void> {
    const want = [...new Set(accounts)].filter((a) => !this.known(a));
    const got = await this.r.many(want.map((a) => ({ functionName: 'getProtectedAccount', args: [a] })), 'accounts');
    want.forEach((a, i) => this.learn(a, got[i]));
  }

  /**
   * `calls`, each read TOGETHER with the settings of the account it names
   * (when those are not read yet this run); returns `calls`' answers. A row's
   * account is named by the event that queued it, so its settings need not
   * wait for its record.
   *
   * Each record and its settings are one group of the reader
   * (`PassReader.groups`), which never splits a group across chunks. A read
   * window that completes only some chunks therefore still yields whole
   * pairs, and a record the run reached always has the settings it needs to
   * be acted on. The settings read is repeated for every record of the same
   * account rather than shared: shared, it sits in one chunk, and a record of
   * that account in another chunk can be read every run without its settings
   * ever coming back with it (Codex #3090 r7). The repeat costs one read per
   * extra record of an account and buys that guarantee.
   */
  private async readWithAccounts(calls: readonly AccountCall[], label: string): Promise<unknown[]> {
    const groups = calls.map((c) => {
      const record = { functionName: c.functionName, args: c.args };
      return c.account !== null && !this.known(c.account)
        ? [record, { functionName: 'getProtectedAccount', args: [c.account] }]
        : [record];
    });
    const got = await this.r.groups(groups, label);
    calls.forEach((c, i) => {
      if (c.account !== null && got[i].length > 1) this.learn(c.account, got[i][1]);
    });
    return got.map((g) => g[0]);
  }

  /** The order this run tries the page's nominees in (`attemptOrder`). */
  private order(n: number): number[] {
    return attemptOrder(n, this.deps.visit ?? 0);
  }

  // 1a. Payouts.
  async releasePayouts(): Promise<void> {
    if (this.lockRequested === null) return;
    const page = await readLedgerRotation<bigint>({
      ledger: this.deps.ledger,
      cursors: this.deps.cursors,
      chainId: this.chainId,
      kinds: [PAYOUT_EVENT],
      floorItem: PAYOUT_FLOOR_ITEM,
      nextItem: PAYOUT_NEXT_ITEM,
      limit: PAGE,
      cutoff: this.r.cutoff,
      nominee: rowId,
      id: (id) => String(id),
    });
    if (page === null) {
      this.sender.noteUnread('payout', 'the event ledger of queued payouts');
      return;
    }
    const ids = page.nominees;
    const read = (xs: readonly bigint[], label: string, block?: bigint) =>
      this.r.many(xs.map((id) => ({ functionName: 'getPendingPayout', args: [id] })), label, block);
    const settled = new Set<bigint>();
    if (ids.length > 0) {
      const now = await this.clock('payout');
      if (now === null) return;
      const named = accountsNamed(page);
      const rows = (await this.readWithAccounts(
        ids.map((id) => ({ functionName: 'getPendingPayout', args: [id], account: named.get(id) ?? null })),
        'payouts',
      )) as (PendingPayout | undefined)[];
      // A record naming an account its event did not (none should) has that
      // account read now.
      await this.readAccounts(rows.flatMap((x) => (x && Number(x.state) === ROW_QUEUED ? [lower(x.user)!] : [])));
      for (const i of this.order(ids.length)) {
        const id = ids[i];
        const p = rows[i];
        if (p === undefined) {
          this.sender.noteUnread(`release:${id}`, 'its pending payout record');
          continue;
        }
        if (Number(p.state) !== ROW_QUEUED) {
          // Released or cancelled. A row never queued (state 0) is the
          // ledger ahead of the head the read was made at: not finished.
          if (Number(p.state) !== ROW_NONE) settled.add(id);
          continue;
        }
        if (p.releaseAt > now) {
          this.wait('payout-not-due');
          continue;
        }
        const a = this.accounts.get(lower(p.user)!);
        if (a === undefined) {
          this.sender.noteUnread(`release:${id}`, "its account's settings");
          continue;
        }
        if (a.locked) {
          this.wait('payout-account-locked');
          continue;
        }
        if (this.lockRequested.has(lower(p.user)!)) {
          this.wait('payout-lock-requested');
          continue;
        }
        if (a.requireCosign && !p.cosigned) {
          this.wait('payout-needs-cosign');
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const res = await this.sender.call('release', String(id), 'releasePayout', [id]);
        if (res !== 'landed') continue;
        settled.add(id);
        const receipt = this.sender.receipt;
        const cancelled = receipt?.logs.some((l) => this.isEvent(l, 'PayoutCancelled', id)) ?? false;
        if (cancelled) this.report.cancelled.push(id);
        else this.report.released.push({ id, delivered: this.delivered(receipt, id) });
      }
    }
    // A row is finished once its payout is no longer queued, at the finalized
    // block as at the head (`ledgerRotation.ts`): a release a reorg undoes
    // leaves its row above the floor, to be sent again.
    await page.liftFloor(this.r.finalized, (id) => settled.has(id), async (xs, block: FinalBlock) => {
      const at = (await read(xs, 'payouts-final', block.number)) as (PendingPayout | undefined)[];
      const done = new Set(xs.filter((_, j) => at[j] !== undefined && ![ROW_NONE, ROW_QUEUED].includes(Number(at[j]!.state))));
      return (id) => done.has(id);
    });
  }

  // 1b. Position transfers.
  async releaseTransfers(): Promise<void> {
    if (this.lockRequested === null) return;
    const page = await readLedgerRotation<bigint>({
      ledger: this.deps.ledger,
      cursors: this.deps.cursors,
      chainId: this.chainId,
      kinds: [TRANSFER_EVENT],
      floorItem: TRANSFER_FLOOR_ITEM,
      nextItem: TRANSFER_NEXT_ITEM,
      limit: PAGE,
      cutoff: this.r.cutoff,
      nominee: rowId,
      id: (id) => String(id),
    });
    if (page === null) {
      this.sender.noteUnread('transfer', 'the event ledger of queued position transfers');
      return;
    }
    const ids = page.nominees;
    const read = (xs: readonly bigint[], label: string, block?: bigint) =>
      this.r.many(xs.map((id) => ({ functionName: 'getPendingPositionTransfer', args: [id] })), label, block);
    const settled = new Set<bigint>();
    if (ids.length > 0) {
      const now = await this.clock('transfer');
      if (now === null) return;
      const named = accountsNamed(page);
      const rows = (await this.readWithAccounts(
        ids.map((id) => ({ functionName: 'getPendingPositionTransfer', args: [id], account: named.get(id) ?? null })),
        'transfers',
      )) as (PendingTransfer | undefined)[];
      // A record naming an account its event did not (none should) has that
      // account read now.
      await this.readAccounts(rows.flatMap((x) => (x && Number(x.state) === ROW_QUEUED ? [lower(x.from)!] : [])));
      for (const i of this.order(ids.length)) {
        const id = ids[i];
        const t = rows[i];
        if (t === undefined) {
          this.sender.noteUnread(`transfer:${id}`, 'its pending position-transfer record');
          continue;
        }
        if (Number(t.state) !== ROW_QUEUED) {
          if (Number(t.state) !== ROW_NONE) settled.add(id);
          continue;
        }
        if (t.releaseAt > now) {
          this.wait('transfer-not-due');
          continue;
        }
        const a = this.accounts.get(lower(t.from)!);
        if (a === undefined) {
          this.sender.noteUnread(`transfer:${id}`, "its account's settings");
          continue;
        }
        if (a.locked) {
          this.wait('transfer-account-locked');
          continue;
        }
        if (this.lockRequested.has(lower(t.from)!)) {
          this.wait('transfer-lock-requested');
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const res = await this.sender.call('transfer', String(id), 'releasePositionTransfer', [id]);
        if (res !== 'landed') continue;
        settled.add(id);
        this.report.transferred.push(id);
      }
    }
    await page.liftFloor(this.r.finalized, (id) => settled.has(id), async (xs, block: FinalBlock) => {
      const at = (await read(xs, 'transfers-final', block.number)) as (PendingTransfer | undefined)[];
      const done = new Set(xs.filter((_, j) => at[j] !== undefined && ![ROW_NONE, ROW_QUEUED].includes(Number(at[j]!.state))));
      return (id) => done.has(id);
    });
  }

  // 2. Pending changes.
  async finalizeChanges(): Promise<void> {
    const page = await readLedgerRotation<Change>({
      ledger: this.deps.ledger,
      cursors: this.deps.cursors,
      chainId: this.chainId,
      kinds: CHANGE_EVENTS,
      floorItem: CHANGE_FLOOR_ITEM,
      nextItem: CHANGE_NEXT_ITEM,
      limit: PAGE,
      cutoff: this.r.cutoff,
      nominee: changeOf,
      id: changeId,
    });
    if (page === null) {
      this.sender.noteUnread('change', 'the event ledger of pending changes');
      return;
    }
    const changes = page.nominees;
    const settled = new Set<string>();
    if (changes.length > 0) {
      const now = await this.clock('change');
      if (now === null) return;
      const st = (await this.readWithAccounts(changeCalls(changes).map((call, i) => ({ ...call, account: changes[i].account })), 'changes')) as (ChangeState | undefined)[];
      // One `finalizeSettingChanges` per account applies every due setting;
      // what it applied is read from its receipt (`applied`), never assumed
      // from its landing (Codex #3090).
      const settingsSent = new Set<Address>();
      const applied = new Map<Address, readonly ReceiptLog[]>();
      for (const i of this.order(changes.length)) {
        const c = changes[i];
        const key = changeId(c);
        const s = st[i];
        const a = this.accounts.get(c.account);
        if (s === undefined || a === undefined) {
          this.sender.noteUnread(`finalize:${key}`, 'its pending change or its account');
          continue;
        }
        if (pendingAt(c, s) !== c.at) {
          settled.add(key);
          continue;
        }
        if (c.at > now) {
          this.wait('change-not-due');
          continue;
        }
        const why = this.blocked(c, s, a, now);
        if (why !== null) {
          this.wait(why);
          continue;
        }
        let logs: readonly ReceiptLog[];
        if (c.t === 'setting' && settingsSent.has(c.account)) {
          // The account's call this run already went out; it applied this
          // setting only if its receipt says so.
          const sent = applied.get(c.account);
          if (sent === undefined) continue;
          logs = sent;
        } else {
          // eslint-disable-next-line no-await-in-loop
          const res = await this.finalize(c);
          if (c.t === 'setting') settingsSent.add(c.account);
          // A due switch-off waits while the account has open rows; the chain
          // refuses the call only when nothing else was due.
          if (res === SWITCH_OFF_WAITS) this.wait('switch-off-waits-for-open-rows');
          if (res !== 'landed') continue;
          logs = this.sender.receipt?.logs ?? [];
          if (c.t === 'setting') applied.set(c.account, logs);
        }
        // A landed call is not proof the change applied: a replacement
        // finalized first drops the account's pending settings, another
        // caller may cancel one between the read and the send, and a
        // switch-off waits while rows are open. Only the change's own event
        // in the receipt reports it; otherwise the next run reads it again.
        if (!changeApplied(logs, this.r.diamond, c)) {
          this.wait(c.t === 'setting' && c.kind === CHANGE_DISABLE ? 'switch-off-waits-for-open-rows' : 'change-not-applied');
          continue;
        }
        settled.add(key);
        this.report.finalized.push(changeLabel(c));
      }
    }
    await page.liftFloor(this.r.finalized, (c) => settled.has(changeId(c)), async (cs, block: FinalBlock) => {
      const at = await this.readChanges(cs, block.number);
      const done = new Set(cs.filter((c, j) => at[j] !== undefined && pendingAt(c, at[j]!) !== c.at).map(changeId));
      return (c) => done.has(changeId(c));
    });
  }

  /** Why a due change is not sent, in the chain's terms; null to send. */
  private blocked(c: Change, s: ChangeState, a: ProtectedAccount, now: bigint): string | null {
    if (!a.enabled) return 'change-mode-off';
    switch (c.t) {
      case 'setting':
        // An unlock is how a locked account gets out; every other setting
        // was dropped by the lock, so a due one here is the unlock's.
        return null;
      case 'allow':
        if (a.locked) return 'change-account-locked';
        if (a.retired) return 'allowlist-add-on-retired-account';
        // Like a signer addition, it expires one delay after it matures.
        if (now > c.at + BigInt(a.delaySeconds)) return 'allowlist-add-expired';
        return null;
      case 'signerAdd': {
        if (a.locked) return 'change-account-locked';
        const sc = s as SignerChange;
        if (!sc.accepted) return 'signer-not-accepted';
        // It expires one delay after it matures; only a cancel clears it.
        if (now > sc.addAt + BigInt(a.delaySeconds)) return 'signer-add-expired';
        return null;
      }
      case 'signerRemove':
        return a.locked ? 'change-account-locked' : null;
      case 'replace': {
        const [p, approvals, threshold] = s as readonly [ReplacementProposal, bigint, bigint];
        const manager = (a.retired ? lower(a.controller) : c.account) as Address;
        // A proposal the manager made needs no approvals; any other still
        // needs its majority among the signers active now.
        if (lower(p.proposedBy) !== manager && approvals < threshold) return 'replacement-lacks-approvals';
        return null;
      }
    }
  }

  private finalize(c: Change): Promise<string> {
    switch (c.t) {
      case 'setting':
        return this.sender.call('finalize', `settings:${c.account}`, 'finalizeSettingChanges', [c.account]);
      case 'allow':
        return this.sender.call('finalize', `allow:${c.account}:${c.other}`, 'finalizeAddAllowlisted', [c.account, c.other]);
      case 'signerAdd':
        return this.sender.call('finalize', `signer-add:${c.account}:${c.other}`, 'finalizeAddSigner', [c.account, c.other]);
      case 'signerRemove':
        return this.sender.call('finalize', `signer-remove:${c.account}:${c.other}`, 'finalizeRemoveSigner', [c.account, c.other]);
      case 'replace':
        return this.sender.call('finalize', `replace:${c.account}`, 'finalizeReplacement', [c.account]);
    }
  }

  /** Each change's own pending record at `block`, by position; undefined
   *  where unread. */
  private async readChanges(cs: readonly Change[], block: bigint): Promise<(ChangeState | undefined)[]> {
    return (await this.r.many(changeCalls(cs), 'changes-final', block)) as (ChangeState | undefined)[];
  }

  private isEvent(log: { topics: readonly string[]; address: string }, name: string, id: bigint): boolean {
    return log.address.toLowerCase() === this.r.diamond.toLowerCase() && eventIdOf(log, name) === id;
  }

  private delivered(receipt: StepSender['receipt'], id: bigint): bigint {
    for (const log of receipt?.logs ?? []) {
      if (log.address.toLowerCase() !== this.r.diamond.toLowerCase()) continue;
      const d = payoutDelivered(log, id);
      if (d !== null) return d;
    }
    return 0n;
  }
}

/** The read of each change's own pending record. */
function changeCalls(cs: readonly Change[]): { functionName: string; args: readonly unknown[] }[] {
  return cs.map((c) => {
    switch (c.t) {
      case 'setting':
        return { functionName: 'getProtectedAccount', args: [c.account] };
      case 'allow':
        return { functionName: 'getAllowlistPendingAt', args: [c.account, c.other] };
      case 'signerAdd':
      case 'signerRemove':
        return { functionName: 'getSignerChange', args: [c.account, c.other] };
      case 'replace':
        return { functionName: 'getReplacement', args: [c.account] };
    }
  });
}

/** The accounts the page's events name (`PayoutQueued` and
 *  `PositionTransferQueued` both carry it), so their settings are read with
 *  the rows' own records. */
/** A read and the account whose settings go with it (null: none named). */
type AccountCall = { functionName: string; args: readonly unknown[]; account: Address | null };

/** The account the event that first named each nominee names, by nominee. */
function accountsNamed(page: LedgerRotation<bigint>): Map<bigint, Address> {
  const out = new Map<bigint, Address>();
  page.rows.forEach((row, i) => {
    const id = page.named[i];
    const a = id === null ? null : lower(row.args.account);
    if (id !== null && a !== null && !out.has(id)) out.set(id, a);
  });
  return out;
}

/** What a change's own record read returns. */
type ChangeState = ProtectedAccount | bigint | SignerChange | readonly [ReplacementProposal, bigint, bigint];

/** The pending time the chain holds now for the change a row announced. A
 *  change is still the row's own only while this equals the row's time. */
export function pendingAt(c: Change, s: ChangeState): bigint {
  switch (c.t) {
    case 'setting':
      return BigInt((s as ProtectedAccount)[SETTING_FIELD[c.kind]] as bigint);
    case 'allow':
      return BigInt(s as bigint);
    case 'signerAdd':
      return BigInt((s as SignerChange).addAt);
    case 'signerRemove':
      return BigInt((s as SignerChange).removeAt);
    case 'replace': {
      const p = (s as readonly [ReplacementProposal, bigint, bigint])[0];
      // A different nominee, or none, is no longer this row's proposal.
      return lower(p.nominee) === c.other ? BigInt(p.readyAt) : -1n;
    }
  }
}

// ─── Receipt logs ───────────────────────────────────────────────────────────

/** A receipt log, as far as the decoding here reads it. */
type ReceiptLog = { address: string; topics: readonly string[]; data?: string };

/** Whether the receipt's logs carry the event that APPLYING `c` emits, from
 *  this Diamond, for its account (and its destination, signer or nominee):
 *  `SettingChangeApplied` for a setting (`ProtectedModeDisabled` for the
 *  switch-off), `AllowlistAdded`, `SignerAdded`, `SignerRemoved` or
 *  `PrimaryReplaced`. Pure. Exported for the tests. */
export function changeApplied(logs: readonly ReceiptLog[], diamond: Address, c: Change): boolean {
  for (const log of logs) {
    if (log.address.toLowerCase() !== diamond.toLowerCase()) continue;
    let ev: { eventName: string; args: Record<string, unknown> };
    try {
      ev = decodeEventLog({ abi: ABI, data: (log.data ?? '0x') as Hex, topics: log.topics as [Hex, ...Hex[]] }) as unknown as typeof ev;
    } catch {
      continue;
    }
    const a = ev.args;
    if (lower(a.account as Address) !== c.account) continue;
    switch (c.t) {
      case 'setting':
        if (c.kind === CHANGE_DISABLE ? ev.eventName === 'ProtectedModeDisabled' : ev.eventName === 'SettingChangeApplied' && Number(a.kind) === c.kind) return true;
        break;
      case 'allow':
        if (ev.eventName === 'AllowlistAdded' && lower(a.destination as Address) === c.other) return true;
        break;
      case 'signerAdd':
        if (ev.eventName === 'SignerAdded' && lower(a.signer as Address) === c.other) return true;
        break;
      case 'signerRemove':
        if (ev.eventName === 'SignerRemoved' && lower(a.signer as Address) === c.other) return true;
        break;
      case 'replace':
        if (ev.eventName === 'PrimaryReplaced' && lower(a.controller as Address) === c.other) return true;
        break;
    }
  }
  return false;
}

function eventIdOf(log: { topics: readonly string[]; data?: string }, name: string): bigint | null {
  try {
    const ev = decodeEventLog({ abi: ABI, data: (log.data ?? '0x') as Hex, topics: log.topics as [Hex, ...Hex[]] });
    if (ev.eventName !== name) return null;
    return BigInt((ev.args as unknown as { id: bigint }).id);
  } catch {
    return null;
  }
}

function payoutDelivered(log: { topics: readonly string[]; data?: string }, id: bigint): bigint | null {
  try {
    const ev = decodeEventLog({ abi: ABI, data: (log.data ?? '0x') as Hex, topics: log.topics as [Hex, ...Hex[]] });
    if (ev.eventName !== 'PayoutReleased') return null;
    const a = ev.args as unknown as { id: bigint; delivered: bigint };
    return BigInt(a.id) === id ? BigInt(a.delivered) : null;
  } catch {
    return null;
  }
}
