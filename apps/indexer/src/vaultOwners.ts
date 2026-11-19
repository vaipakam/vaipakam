/**
 * #3388 — the owner of each user vault, so a `VaultOutflow` paid INTO a vault
 * is filed under that vault's owner.
 *
 * A holder payout, claim custody or matched leg pays a vault, and the event
 * names the vault contract as `to`, which is no wallet. The indexer knows
 * each vault's owner from two facts the chain states (`UserVaultCreated(user,
 * proxy)`, and every outflow's own `(owner, vault)`), keeps them in
 * `vault_owners` (migration 0107), and adds the receiving vault's owner to
 * the row's args as `recipientOwner`, which the shared participant rule reads
 * (`INDEXER_ADDED_PARTIES`). When the owner is not known the field is left
 * out: the row then reaches the holder through the loan filter only, as it
 * did before, and nothing claims an owner the indexer has not seen.
 */
import { chunkD1InList } from '@vaipakam/lib/d1Binds';

const ADDRESS = /^0x[0-9a-f]{40}$/;
const ZERO = '0x0000000000000000000000000000000000000000';

/** The minimum a decoded log needs here. */
interface LogLike {
  eventName: string;
  args: unknown;
}

function addr(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const a = v.toLowerCase();
  return ADDRESS.test(a) && a !== ZERO ? a : null;
}

/** The (vault → owner) pairs these logs state themselves. */
export function vaultPairsOf(logs: readonly LogLike[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const log of logs) {
    const args = (log.args ?? {}) as Record<string, unknown>;
    let vault: string | null = null;
    let owner: string | null = null;
    if (log.eventName === 'UserVaultCreated') {
      vault = addr(args.proxy);
      owner = addr(args.user);
    } else if (log.eventName === 'VaultOutflow') {
      vault = addr(args.vault);
      owner = addr(args.owner);
    }
    if (vault && owner) out.set(vault, owner);
  }
  return out;
}

/** The recipients of these logs' outflows that might be vaults: every `to`
 *  that is not the outflow's own owner (an owner's withdrawal to their own
 *  wallet) and not already known. */
export function unresolvedRecipients(logs: readonly LogLike[], known: ReadonlyMap<string, string>): string[] {
  const out = new Set<string>();
  for (const log of logs) {
    if (log.eventName !== 'VaultOutflow') continue;
    const args = (log.args ?? {}) as Record<string, unknown>;
    const to = addr(args.to);
    if (to && to !== addr(args.owner) && !known.has(to)) out.add(to);
  }
  return [...out];
}

/**
 * The owners these logs need: the pairs they state, plus a lookup of the
 * other recipients in `vault_owners`. One `batch()` round trip, and only when
 * there is something to look up. Throws when the lookup fails; the caller
 * decides whether that is fail-open.
 */
export async function loadVaultOwners(db: D1Database, chainId: number, logs: readonly LogLike[]): Promise<Map<string, string>> {
  const owners = vaultPairsOf(logs);
  const missing = unresolvedRecipients(logs, owners);
  if (missing.length === 0) return owners;
  const chunks = chunkD1InList(missing, { before: [chainId] });
  const parts = await db.batch<{ vault: string; owner: string }>(
    chunks.map((c) =>
      db.prepare(`SELECT vault, owner FROM vault_owners WHERE chain_id = ? AND vault IN (${c.placeholders})`).bind(...c.binds),
    ),
  );
  for (const part of parts) for (const r of part.results ?? []) owners.set(r.vault, r.owner);
  return owners;
}

/** Rows per INSERT: three bound values each, inside D1's 100-parameter cap. */
const PAIRS_PER_STATEMENT = 33;

/** Statements recording these pairs. Idempotent: a vault's owner never changes. */
export function vaultOwnerStatements(db: D1Database, chainId: number, pairs: ReadonlyMap<string, string>): D1PreparedStatement[] {
  const rows = [...pairs.entries()];
  const out: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += PAIRS_PER_STATEMENT) {
    const chunk = rows.slice(i, i + PAIRS_PER_STATEMENT);
    out.push(
      db
        .prepare(`INSERT OR IGNORE INTO vault_owners (chain_id, vault, owner) VALUES ${chunk.map(() => '(?, ?, ?)').join(', ')}`)
        .bind(...chunk.flatMap(([vault, owner]) => [chainId, vault, owner])),
    );
  }
  return out;
}

/** A `VaultOutflow`'s args with `recipientOwner` added when its `to` is a
 *  vault whose owner is known; every other log's args unchanged. */
export function withRecipientOwner(eventName: string, args: Record<string, unknown>, owners: ReadonlyMap<string, string>): Record<string, unknown> {
  if (eventName !== 'VaultOutflow') return args;
  const to = addr(args.to);
  const owner = to ? owners.get(to) : undefined;
  return owner ? { ...args, recipientOwner: owner } : args;
}
