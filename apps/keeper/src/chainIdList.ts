// apps/keeper/src/chainIdList.ts
//
// The keeper's one reading of a setting that names chains: a comma list of
// decimal chain ids. Used by the discount path's arming (#2633) and the
// private submission fallback (#3240). Unset or empty names no chain. A value
// that cannot be read is reported by position, never echoed: these settings
// sit among the keeper's secrets in its env file, and a paste error is how a
// credential ends up on the wrong line.

/** The chains a list names, or why it could not be read. */
export type ChainIdList = { chains: ReadonlySet<number> } | { unread: string };

const CHAIN_ID = /^[1-9]\d*$/;

/** One chain id, or null when `entry` is not one. */
export function parseChainId(entry: string): number | null {
  const text = entry.trim();
  if (!CHAIN_ID.test(text) || !Number.isSafeInteger(Number(text))) return null;
  return Number(text);
}

/** The chains `raw` (the value of the setting `name`) names. */
export function parseChainIdList(name: string, raw: string | undefined): ChainIdList {
  const text = (raw ?? '').trim();
  const chains = new Set<number>();
  if (text === '') return { chains };
  const parts = text.split(',');
  for (let i = 0; i < parts.length; i += 1) {
    const id = parseChainId(parts[i]);
    if (id === null) return { unread: `${name} entry ${i + 1} of ${parts.length} is not a chain id` };
    if (chains.has(id)) return { unread: `${name} names chain ${id} twice` };
    chains.add(id);
  }
  return { chains };
}
