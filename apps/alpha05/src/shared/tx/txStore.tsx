/**
 * RB-REVIEW / RB-CONFIDENCE — every write's tracker lives HERE, above the
 * router, keyed by the action that owns it, and not in the page that shows
 * it. A page unmounts when the reader navigates, disconnects or moves to a
 * network the app does not serve; a transaction already handed to the
 * wallet does not stop when it does. Holding the phase, the submission
 * context and what the reader confirmed (`Frozen`) here means:
 * - the pending hash is never lost, and the tracker's own promise keeps
 *   writing its progress while no page shows it;
 * - a page that mounts again finds the flow where it is and shows it, so
 *   no second submission is offered while the first may still execute;
 * - progress and the finish card are drawn from what was confirmed (its
 *   receipt, its network's explorer), never rebuilt for the network or
 *   wallet connected now;
 * - while no page shows an outstanding flow, the shell says one exists.
 */
import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { TransactionReceipt } from 'viem';
import type { Receipt } from '../receipt/types';
import type { LegOutcome, TxPhase } from './outcome';
import type { OwnStateSource } from '../../chain/ownRail';
import type { AnchoredReader } from './anchored';

/** What the reader confirmed, frozen when the wallet is asked. */
export interface Frozen {
  /** The wallet and network the review was built under (`chainId:account`). */
  identity: string;
  chainId: number;
  receipt: Receipt | null;
  /** The explorer origin of the network the transaction was sent on. */
  explorer: string;
  /** The page that owns the flow, for the shell's pointer back to it. */
  where: string;
}

/** What a transaction was submitted with, kept with its hash. */
export interface Submission {
  chainId: number;
  account: `0x${string}`;
  /** The sender's own-rail sources, which the measurement reads through. */
  sources: readonly OwnStateSource[];
  measure: (receipt: TransactionReceipt, at: AnchoredReader) => Promise<readonly LegOutcome[]>;
}

export interface TxEntry {
  phase: TxPhase;
  frozen: Frozen | null;
  submission: Submission | null;
  /** How many flows on screen show this entry right now. */
  shown: number;
}

const IDLE: TxEntry = { phase: { kind: 'idle' }, frozen: null, submission: null, shown: 0 };

/** Out with the wallet or the chain: never reset, never re-opened. */
export function inFlight(phase: TxPhase): boolean {
  return phase.kind === 'signing' || phase.kind === 'submitted' || phase.kind === 'mined';
}

/** A flow that exists without the page's review inputs: anything past the
 *  review. A page shows it whenever it is mounted. */
export function holdsFlow(phase: TxPhase): boolean {
  return phase.kind !== 'idle' && phase.kind !== 'review';
}

export class TxStore {
  private entries = new Map<string, TxEntry>();
  private values = new Map<string, unknown>();
  private listeners = new Set<() => void>();
  private list: readonly [string, TxEntry][] = [];

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  get(key: string): TxEntry {
    return this.entries.get(key) ?? IDLE;
  }

  update(key: string, fn: (e: TxEntry) => TxEntry): TxEntry {
    const next = fn(this.get(key));
    this.entries.set(key, next);
    this.emit();
    return next;
  }

  /** Every entry, as one stable snapshot per change. */
  all = (): readonly [string, TxEntry][] => this.list;

  value<T>(key: string): T | null {
    return (this.values.get(key) as T | undefined) ?? null;
  }

  setValue<T>(key: string, v: T | null) {
    if (v === null) this.values.delete(key);
    else this.values.set(key, v);
    this.emit();
  }

  private emit() {
    this.list = [...this.entries.entries()];
    for (const fn of this.listeners) fn();
  }
}

const TxStoreContext = createContext<TxStore | null>(null);

export function TxStoreProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new TxStore());
  return <TxStoreContext.Provider value={store}>{children}</TxStoreContext.Provider>;
}

export function useTxStore(): TxStore {
  const store = useContext(TxStoreContext);
  if (!store) throw new Error('useTxStore outside TxStoreProvider');
  return store;
}

export function useTxEntry(key: string): TxEntry {
  const store = useTxStore();
  return useSyncExternalStore(store.subscribe, () => store.get(key));
}

export function useTxEntries(): readonly [string, TxEntry][] {
  const store = useTxStore();
  return useSyncExternalStore(store.subscribe, store.all);
}

/** A small piece of a flow's review state that must outlive its page (the
 *  Terms under review while their acceptance is out), kept beside it. */
export function useStoredValue<T>(key: string): [T | null, (next: T | null | ((current: T | null) => T | null)) => void] {
  const store = useTxStore();
  const v = useSyncExternalStore(store.subscribe, () => store.value<T>(key));
  return [v, (next) => store.setValue(key, typeof next === 'function' ? (next as (c: T | null) => T | null)(store.value<T>(key)) : next)];
}
