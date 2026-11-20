// apps/keeper/src/protectedVaultEvents.ts
//
// #3346 — the protected account's security events that its VAULT emits. Since
// #3379 Stage B2 the protected record is held by the vault, so a lock, a
// proposed replacement and every request that loosens the protection are the
// vault's events, and the indexer's ledger does not carry them (until B4).
// The owner alert step used to look for the lock and the replacement in the
// ledger and so never found them. This step reads them from the chain
// itself: one address-less `eth_getLogs` per block range over these events,
// from where the last run stopped.
//
// This is the end state for the keeper's safety alerts, not a bridge: they do
// not depend on the indexer (owner decision via the design thread,
// 2026-11-20); the indexer's ingest of vault events (B4) serves the app's
// screens.
//
// Anyone can deploy a contract that emits an event of the same shape, so a
// log is believed only when its address is a real vault. The keeper keeps the
// set of real vaults itself, from the Diamond's own `UserVaultCreated`
// events read from the chain (`VaultSetStore`, the keeper's private
// database), and drops a log from any other address by a local lookup,
// without a chain read. A log from a known vault must also name the vault's
// creation owner as its account, and is confirmed by the Diamond's
// `getProtection(account)` before it alerts anyone. Each alert goes to the account's manager, as the ledger-driven
// alerts do. Where the step stopped is kept as a block and log position, so
// a run cut short or a channel that asks for a retry never repeats an alert
// already sent and never skips one.
//
// A backlog wider than `TAIL_BACKLOG` blocks (the keeper was down) is not
// worked from its start: the step jumps to the last `TAIL_BACKLOG` blocks and
// says how many it skipped. A first run starts at the head.

import type { Abi, AbiEvent, Address } from 'viem';
import { VaultFactoryFacetABI, VaultProtectionABI, VaultRecoveryABI } from '@vaipakam/contracts/abis';
import type { TelegramAlert } from '@vaipakam/lib/telegramAlerts/message';
import type { DiamondProtection } from '@vaipakam/lib/protectedAccountView';
import { PastRunDeadline } from './batchRead';
import { shortErr } from './callErrors';
import { decodePos, encodePos, type LedgerPos } from './eventLedger';
import { sendOwnerAlert, type OwnerAlertSendDeps } from './ownerAlertSend';
import type { PassReader } from './passReader';
import type { ScanCursors } from './scanCursors';
import { enqueueWork, getWorkCursor, getWorkItems, putWorkCursor, VAULT_SET_KIND } from './db';
import type { KeeperD1 } from './env';

/** The vault events that alert the account's manager. */
export const VAULT_ALERT_EVENTS = [
  'VaultLocked',
  'ReplacementProposed',
  'ProtectionSettingRequested',
  'SignerAddRequested',
  'SignerRemoveRequested',
  'AllowlistAddRequested',
  'RecoveryAddressRequested',
  'RecoveryAddressCleared',
  'RecoveryClaimSettingRequested',
] as const;

export const TAIL_ITEM = 'vault-tail';
/** Blocks per `eth_getLogs`. */
export const TAIL_SPAN = 2000n;
/** Ranges read per run. */
export const TAIL_CALLS = 3;
/** The widest backlog worked from its start. */
export const TAIL_BACKLOG = 20_000n;
/** A position past every log of its block: the block is finished. */
const BLOCK_DONE = 2 ** 31;

/** `VaultProtection`'s setting actions (`SETTINGS_*`). */
const SETTING_DELAY = 2;
const SETTING_DISABLE = 3;
const SETTING_UNLOCK = 4;

export interface VaultLog {
  kind: string;
  args: Record<string, unknown>;
  /** The contract that emitted it. */
  address: Address;
  block: number;
  log: number;
}

/** The set of real vaults: each vault the Diamond created and its owner. */
export interface VaultSetStore {
  /** The first block not yet read for vault creations; 0 when none. */
  next(): Promise<number>;
  setNext(block: number): Promise<void>;
  add(entries: readonly VaultCreation[]): Promise<void>;
  /** The owner of each of `vaults` that is in the set. */
  owners(vaults: readonly Address[]): Promise<Map<Address, Address>>;
}

export interface VaultCreation {
  vault: Address;
  owner: Address;
  block: number;
}

/** Blocks per read of the Diamond's vault creations (one address). */
export const SET_SPAN = 10_000n;
/** Creation ranges read per run (a first sync catches up over runs). */
export const SET_CALLS = 10;

export interface VaultTailReads {
  head(): Promise<bigint>;
  /** The Diamond's `UserVaultCreated` in `[from, to]`. Throws when unread. */
  creations(from: bigint, to: bigint): Promise<VaultCreation[]>;
  /** The active Diamond's deploy block (0 when unknown). */
  floor: number;
  /** The vault alert events in `[from, to]`, any address. Throws when unread. */
  logs(from: bigint, to: bigint): Promise<VaultLog[]>;
  /** Each account's vault (zero when none); undefined where unread. */
  vaults(accounts: readonly Address[]): Promise<(Address | undefined)[]>;
  /** Whom the account's alerts go to; null when unread. */
  manager(account: Address): Promise<Address | null>;
}

export interface VaultTailDeps extends OwnerAlertSendDeps {
  reads: VaultTailReads;
  vaultSet: VaultSetStore;
  cursors: ScanCursors;
  /** The step's cutoff (ms): no send starts at or past it. */
  cutoff: number;
}

export interface VaultTailReport {
  sent: number;
  /** Alerts nobody could be told of (no chat linked, no Push). */
  nobody: number;
  /** A delivery that may go on another try: the step stopped there. */
  retrying: number;
  /** Logs of these events from a contract that is not the account's vault. */
  foreign: number;
  /** Vaults added to the set this run. */
  vaultsAdded: number;
  /** Blocks of a backlog jumped over. */
  skippedBlocks: number;
  /** Something not read this run. */
  unread: string | null;
}

const lower = (a: unknown): Address | null => {
  const s = String(a ?? '').toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(s) ? (s as Address) : null;
};
const num = (v: unknown): number | null => {
  const s = String(v ?? '');
  return /^\d+$/.test(s) && Number(s) <= 2 ** 40 ? Number(s) : null;
};
const isZero = (a: string): boolean => /^0x0{40}$/i.test(a);
const after = (a: LedgerPos, b: LedgerPos) => a.block > b.block || (a.block === b.block && a.log > b.log);

/** The alert a vault log makes, or null for one that alerts nobody (a
 *  setting request that tightens). */
export function vaultAlert(l: VaultLog): TelegramAlert | null {
  const a = l.args;
  const mk = (c: Extract<TelegramAlert, { kind: 'securityChange' }>['change'], p: Partial<Extract<TelegramAlert, { kind: 'securityChange' }>>): TelegramAlert => ({
    kind: 'securityChange',
    change: c,
    subject: null,
    what: null,
    seconds: null,
    at: null,
    by: lower(a.by),
    ...p,
  });
  switch (l.kind) {
    case 'VaultLocked':
      return { kind: 'locked', by: lower(a.by) };
    case 'ReplacementProposed': {
      const nominee = lower(a.nominee);
      const by = lower(a.by);
      return nominee === null || by === null ? null : { kind: 'replacement', nominee, by };
    }
    case 'ProtectionSettingRequested': {
      const action = num(a.action);
      const at = num(a.at);
      if (action === SETTING_UNLOCK) return mk('unlockRequested', { at });
      if (action === SETTING_DISABLE) return mk('switchOffRequested', { at });
      // A lengthening applies at once, so a requested delay change is a
      // shortening.
      if (action === SETTING_DELAY) return mk('delayShortRequested', { at, seconds: num(a.value) });
      return null;
    }
    case 'SignerAddRequested':
      return mk('signerAddRequested', { subject: lower(a.signer), at: num(a.readyAt) });
    case 'SignerRemoveRequested':
      return mk('signerRemoveRequested', { subject: lower(a.signer), at: num(a.readyAt) });
    case 'AllowlistAddRequested':
      return mk('allowlistAddRequested', { subject: lower(a.destination), at: num(a.readyAt) });
    case 'RecoveryAddressRequested':
      return mk('recoveryRequested', { subject: lower(a.recovery), at: num(a.at) });
    case 'RecoveryAddressCleared':
      return mk('recoveryCleared', { subject: lower(a.recovery) });
    case 'RecoveryClaimSettingRequested':
      return mk('claimSettingRequested', { seconds: num(a.wait), at: num(a.at) });
    default:
      return null;
  }
}

export async function vaultSecurityAlerts(d: VaultTailDeps): Promise<VaultTailReport> {
  const report: VaultTailReport = { sent: 0, nobody: 0, retrying: 0, foreign: 0, vaultsAdded: 0, skippedBlocks: 0, unread: null };
  const head = await d.reads.head();
  const setThrough = await syncVaultSet(d, head, report);
  let pos = decodePos((await d.cursors.get([TAIL_ITEM])).get(TAIL_ITEM));
  if (pos === null) {
    // A first run starts at the head: it has no record of what was sent.
    await d.cursors.put(TAIL_ITEM, encodePos({ block: Number(head), log: BLOCK_DONE }));
    return report;
  }
  const save = async (p: LedgerPos) => {
    pos = p;
    await d.cursors.put(TAIL_ITEM, encodePos(p));
  };
  let from = BigInt(pos.log === BLOCK_DONE ? pos.block + 1 : pos.block);
  if (head - from > TAIL_BACKLOG) {
    const jump = head - TAIL_BACKLOG;
    report.skippedBlocks = Number(jump - from);
    from = jump;
    await save({ block: Number(jump) - 1, log: BLOCK_DONE });
  }
  const managers = new Map<Address, Address | null>();
  const confirmed = new Map<Address, Address | undefined>();
  for (let call = 0; call < TAIL_CALLS && from <= head; call++) {
    const to = from + TAIL_SPAN - 1n < head ? from + TAIL_SPAN - 1n : head;
    let logs: VaultLog[];
    try {
      // eslint-disable-next-line no-await-in-loop
      logs = await d.reads.logs(from, to);
    } catch (err) {
      if (err instanceof PastRunDeadline) throw err;
      report.unread = `the vault events of blocks ${from}-${to} (${shortErr(err)})`;
      return report;
    }
    const fresh = logs.filter((l) => after(l, pos!)).sort((x, y) => x.block - y.block || x.log - y.log);
    // eslint-disable-next-line no-await-in-loop
    const owners = await d.vaultSet.owners([...new Set(fresh.map((l) => l.address.toLowerCase() as Address))]);
    for (const l of fresh) {
      const owner = owners.get(l.address.toLowerCase() as Address);
      if (owner === undefined && l.block > setThrough) {
        // The set has not been read up to this block yet: the vault may be
        // new. Wait rather than drop it.
        report.unread = `the vault set, read through block ${setThrough}, behind an event at block ${l.block}`;
        return report;
      }
      const account = lower(l.args.account);
      const alert = owner !== undefined && account !== null && owner === account ? vaultAlert(l) : null;
      if (owner === undefined || owner !== account) report.foreign += 1;
      if (alert !== null && account !== null) {
        // A hit: the Diamond confirms the account's vault before anyone is told.
        if (!confirmed.has(account)) {
          // eslint-disable-next-line no-await-in-loop
          confirmed.set(account, (await d.reads.vaults([account]))[0]);
        }
        const vault = confirmed.get(account);
        if (vault === undefined) {
          report.unread = `the vault of ${account} (its protected-account record)`;
          return report;
        }
        if (vault.toLowerCase() !== l.address.toLowerCase()) {
          report.foreign += 1;
        } else {
          if (Date.now() >= d.cutoff) throw new PastRunDeadline('vault security alerts: the step reached its cutoff');
          // eslint-disable-next-line no-await-in-loop
          if (!managers.has(account)) managers.set(account, await d.reads.manager(account));
          const manager = managers.get(account)!;
          if (manager === null) {
            report.unread = `whom ${account}'s alerts go to (its protected-account settings)`;
            return report;
          }
          // eslint-disable-next-line no-await-in-loop
          const result = await sendOwnerAlert(d, account, manager, alert);
          if (result === 'retry') {
            report.retrying += 1;
            return report;
          }
          if (result === 'sent') report.sent += 1;
          else report.nobody += 1;
        }
      }
      // eslint-disable-next-line no-await-in-loop
      await save({ block: l.block, log: l.log });
    }
    // eslint-disable-next-line no-await-in-loop
    await save({ block: Number(to), log: BLOCK_DONE });
    from = to + 1n;
  }
  return report;
}

/** Read the Diamond's vault creations since the set's last block, a bounded
 *  number of ranges a run. Returns the last block the set is complete
 *  through. A read that fails leaves the set where it was, and the tail waits
 *  for it on any log past that block. */
async function syncVaultSet(d: VaultTailDeps, head: bigint, report: VaultTailReport): Promise<number> {
  let next = BigInt(Math.max(await d.vaultSet.next(), d.reads.floor));
  for (let call = 0; call < SET_CALLS && next <= head; call++) {
    const to = next + SET_SPAN - 1n < head ? next + SET_SPAN - 1n : head;
    let found: VaultCreation[];
    try {
      // eslint-disable-next-line no-await-in-loop
      found = await d.reads.creations(next, to);
    } catch (err) {
      if (err instanceof PastRunDeadline) throw err;
      report.unread = `the vault creations of blocks ${next}-${to} (${shortErr(err)})`;
      break;
    }
    // eslint-disable-next-line no-await-in-loop
    await d.vaultSet.add(found);
    report.vaultsAdded += found.length;
    // eslint-disable-next-line no-await-in-loop
    await d.vaultSet.setNext(Number(to) + 1);
    next = to + 1n;
  }
  return Number(next) - 1;
}

export function describeTailReport(r: VaultTailReport): string {
  const parts = [`vault-alerts=sent ${r.sent}, retrying ${r.retrying}, nobody ${r.nobody}, foreign ${r.foreign}, vaults-added ${r.vaultsAdded}`];
  if (r.skippedBlocks > 0) parts.push(`vault-alerts-skipped-blocks=${r.skippedBlocks}`);
  if (r.unread) parts.push(`vault-alerts-unread=${r.unread}`);
  return parts.join(' ');
}

// ─── Chain reads ────────────────────────────────────────────────────────────

const EVENT_ITEMS: AbiEvent[] = (() => {
  const seen = new Set<string>();
  return [...(VaultProtectionABI as Abi), ...(VaultRecoveryABI as Abi)].filter((x): x is AbiEvent => {
    if (x.type !== 'event' || !(VAULT_ALERT_EVENTS as readonly string[]).includes(x.name) || seen.has(x.name)) return false;
    seen.add(x.name);
    return true;
  });
})();

/** The reads through the pass's reader; `manager` is the pass's own rule. */
const CREATED = (VaultFactoryFacetABI as Abi).find((x): x is AbiEvent => x.type === 'event' && x.name === 'UserVaultCreated');

export function chainTailReads(r: PassReader, diamond: Address, floor: number, manager: (account: Address) => Promise<Address | null>): VaultTailReads {
  return {
    head: () => r.call('the head block', (c) => c.getBlockNumber()),
    floor,
    async creations(from, to) {
      if (!CREATED) throw new Error('UserVaultCreated is not in the vault factory ABI');
      const logs = await r.call('the vault creations', (c) => c.getLogs({ address: diamond, event: CREATED, fromBlock: from, toBlock: to }));
      return (logs as unknown as { args: { user?: Address; proxy?: Address }; blockNumber: bigint }[]).flatMap((l) => {
        const owner = lower(l.args.user);
        const vault = lower(l.args.proxy);
        return owner && vault ? [{ vault, owner, block: Number(l.blockNumber) }] : [];
      });
    },
    async logs(from, to) {
      const logs = await r.call('the vault events', (c) => c.getLogs({ events: EVENT_ITEMS, fromBlock: from, toBlock: to }));
      return (logs as unknown as { eventName: string; args: Record<string, unknown>; address: Address; blockNumber: bigint; logIndex: number }[]).map((l) => ({
        kind: l.eventName,
        args: l.args,
        address: l.address,
        block: Number(l.blockNumber),
        log: Number(l.logIndex),
      }));
    },
    async vaults(accounts) {
      const got = await r.many(
        accounts.map((a) => ({ functionName: 'getProtection', args: [a] })),
        'vault event accounts',
      );
      return got.map((p) => (p === undefined ? undefined : ((p as DiamondProtection)[0].toLowerCase() as Address)));
    },
    manager,
  };
}

export const missingEvents = (): string[] => VAULT_ALERT_EVENTS.filter((n) => !EVENT_ITEMS.some((e) => e.name === n));

/** The set in the keeper's private database: one `protected_vault` work row
 *  per vault (item = the vault, payload = its owner), and the next block to
 *  read under the same kind's cursor. */
export function d1VaultSet(db: KeeperD1, chainId: number, diamond: string): VaultSetStore {
  return {
    next: () => getWorkCursor(db, chainId, diamond, VAULT_SET_KIND),
    setNext: (block) => putWorkCursor(db, chainId, diamond, VAULT_SET_KIND, block),
    add: (entries) => enqueueWork(db, chainId, diamond, VAULT_SET_KIND, entries.map((e) => ({ item: e.vault, block: e.block, payload: { owner: e.owner } }))),
    async owners(vaults) {
      const rows = await getWorkItems<{ owner: string }>(db, chainId, diamond, VAULT_SET_KIND, vaults);
      return new Map([...rows].flatMap(([k, v]) => {
        const o = lower(v.payload.owner);
        return o ? [[k as Address, o] as const] : [];
      }));
    },
  };
}

/** A set in memory, for tests. */
export function memoryVaultSet(): VaultSetStore & { rows: Map<Address, Address> } {
  const rows = new Map<Address, Address>();
  let n = 0;
  return {
    rows,
    next: async () => n,
    setNext: async (b) => {
      n = Math.max(n, b);
    },
    add: async (entries) => {
      for (const e of entries) if (!rows.has(e.vault)) rows.set(e.vault, e.owner);
    },
    owners: async (vaults) => new Map(vaults.flatMap((v) => (rows.has(v) ? [[v, rows.get(v)!] as const] : []))),
  };
}
