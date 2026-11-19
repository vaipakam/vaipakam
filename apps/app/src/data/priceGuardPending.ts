/**
 * #3453 — the price guard's changes still waiting out its delay, as the
 * indexer's `/config/:chainId` reports them, read defensively.
 *
 * A change to a price setting is proposed, waits the guard's delay, and only
 * then may be carried out. The delay is the window in which people can see a
 * change coming, so the console lists every waiting change. The list comes
 * from the indexer only (the chain keeps pending changes by key, and only the
 * guard's own logs say which keys exist), so the console also says how far
 * back the list reaches, and says plainly when it has no list at all.
 */
import {
  PRICE_GUARD_SOURCE_NAMES,
  priceGuardKindName,
  type PendingPriceGuardChange,
} from '@vaipakam/lib/priceGuardChanges';

export interface PriceGuardPendingView {
  guard: string;
  /** The first block whose guard logs the indexer read. */
  listedFromBlock: number;
  /** Reading began at or before this deployment: every change since is listed. */
  sinceDeploy: boolean;
  changes: PendingPriceGuardChange[];
}

const WORD = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The view, or undefined when the response carries none or carries one this
 *  build cannot read. An unreadable list is never shown as "none waiting". */
export function parsePriceGuardPending(raw: unknown): PriceGuardPendingView | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.guard !== 'string' ||
    !ADDRESS.test(r.guard) ||
    typeof r.listedFromBlock !== 'number' ||
    !Number.isSafeInteger(r.listedFromBlock) ||
    typeof r.sinceDeploy !== 'boolean' ||
    !Array.isArray(r.changes)
  ) {
    return undefined;
  }
  const changes: PendingPriceGuardChange[] = [];
  for (const c of r.changes as unknown[]) {
    if (typeof c !== 'object' || c === null) return undefined;
    const x = c as Record<string, unknown>;
    if (
      typeof x.kind !== 'number' ||
      !Number.isInteger(x.kind) ||
      typeof x.subject !== 'string' ||
      !WORD.test(x.subject) ||
      typeof x.value !== 'string' ||
      !WORD.test(x.value) ||
      typeof x.executableAt !== 'number' ||
      !Number.isSafeInteger(x.executableAt) ||
      typeof x.proposedBlock !== 'number'
    ) {
      return undefined;
    }
    changes.push({
      kind: x.kind,
      // Named by this build, never by the response.
      kindName: priceGuardKindName(x.kind),
      subject: x.subject as `0x${string}`,
      value: x.value as `0x${string}`,
      executableAt: x.executableAt,
      proposedBlock: x.proposedBlock,
      ...(typeof x.knobKey === 'string' ? { knobKey: x.knobKey } : {}),
    });
  }
  return { guard: r.guard, listedFromBlock: r.listedFromBlock, sinceDeploy: r.sinceDeploy, changes };
}

/** A stored 32-byte word as the string a console row of `format` reads: the
 *  low 20 bytes for an address, the word itself for a 32-byte value, else
 *  the unsigned number. */
export function wordAsSetting(word: `0x${string}`, format: string): string {
  if (format === 'address') return `0x${word.slice(-40)}`;
  if (format === 'bytes32') return word;
  return BigInt(word).toString();
}

/** A secondary source's name from its subject word, or the raw word. */
export function sourceName(word: `0x${string}`): string {
  const n = BigInt(word);
  return n < BigInt(PRICE_GUARD_SOURCE_NAMES.length) ? PRICE_GUARD_SOURCE_NAMES[Number(n)] : word;
}
