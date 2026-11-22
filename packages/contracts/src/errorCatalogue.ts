/**
 * The error catalogue (#3916): every error of every contract the platform
 * ships, keyed by its 4-byte selector, with its values and, where written,
 * its plain meaning, who can act on it, and whether it is internal.
 *
 * Generated: `errorCatalogue.json` is built by
 * `scripts/build-error-catalogue.mjs` from the shipped interfaces and the
 * hand-written `errors/meanings.json`. Which entry functions can raise each
 * error is a separate, larger file, `@vaipakam/contracts/error-raisers`, read
 * by tools only.
 *
 * Every reader (the shared decoder the apps use, the keeper, the indexer, the
 * transaction explainer) asks this one module, so a user, an operator and
 * support get the same answer for the same error.
 */

import catalogue from './errorCatalogue.json';

/** An ABI parameter as the catalogue keeps it. */
export interface ErrorCatalogueParam {
  name: string;
  type: string;
  components?: ErrorCatalogueParam[];
}

/** Who can act on an error. */
export type ErrorActor = 'user' | 'operator' | 'nobody';

export interface ErrorCatalogueRow {
  /** `Name(type,...)`, the text the selector hashes. */
  signature: string;
  name: string;
  inputs: ErrorCatalogueParam[];
  /**
   * `platform`: an exported interface declares it. `reached`: only a contract
   * the platform deploys without exporting its interface raises it.
   * `builtin`: `Error(string)` or `Panic(uint256)`.
   */
  source: 'platform' | 'reached' | 'builtin';
  /** Who can act on it, where a meaning is written. */
  actor?: ErrorActor;
  /** The text shown to whoever hits it: what happened and what they can do. */
  message?: string;
  /** It should be impossible: shown as a fault of the platform. */
  internal?: boolean;
  /** Users are known to reach it, and it still shows its name turned into words. */
  shownByName?: boolean;
}

/** Every catalogued error, keyed by lower-case `0x` selector. */
export const ERROR_CATALOGUE: Readonly<Record<string, ErrorCatalogueRow>> =
  catalogue.errors as Record<string, ErrorCatalogueRow>;

/** The row for a selector (any case, `0x` prefixed), or undefined. */
export function errorBySelector(selector: string): ErrorCatalogueRow | undefined {
  return ERROR_CATALOGUE[selector.toLowerCase()];
}

/** Every row of an error name, with its selector (a name can have several signatures). */
export function errorsByName(name: string): Array<[string, ErrorCatalogueRow]> {
  return Object.entries(ERROR_CATALOGUE).filter(([, row]) => row.name === name);
}
