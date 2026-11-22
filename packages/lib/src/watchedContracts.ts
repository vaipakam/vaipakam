/**
 * The platform's contracts on a network, read from its deployment record
 * (#3919, #3921). One rule for every service that watches them: the failed
 * transaction pass (what users send to) and the indexer's event history
 * (what they emit).
 *
 * Every contract address in the record counts, except:
 *   - people and the treasury (`admin`, `treasury`, `keeperAddress`);
 *   - an implementation behind a proxy (a key ending `Impl`), reached through
 *     its proxy;
 *   - a facet (anything under `facets`), reached through the Diamond;
 *   - with `includeTestnetMocks: false`, the testnet's mock assets
 *     (`testnetMocks`), which are stand-ins for outside tokens, not the
 *     platform's own contracts.
 */

/** Keys of the deployment record that are people or the treasury, not contracts. */
const NOT_CONTRACTS = new Set(['admin', 'treasury', 'keeperAddress']);

export function watchedAddresses(record: Record<string, unknown>, opts: { includeTestnetMocks?: boolean } = {}): string[] {
  const includeMocks = opts.includeTestnetMocks ?? true;
  const out = new Set<string>();
  const walk = (v: unknown, key: string) => {
    if (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)) {
      if (!NOT_CONTRACTS.has(key) && !/Impl$/.test(key)) out.add(v.toLowerCase());
    } else if (v && typeof v === 'object') {
      if (key === 'facets') return;
      if (key === 'testnetMocks' && !includeMocks) return;
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, k);
    }
  };
  walk(record, '');
  return [...out].sort();
}
