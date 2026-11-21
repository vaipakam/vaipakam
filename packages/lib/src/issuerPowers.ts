/**
 * #3433 — the issuer-power checks the off-chain checker runs on a token or
 * collection, as ONE list for the writer (the keeper machine's pass) and the
 * reader (the indexer's `GET /assets/issuer-powers`, then the apps).
 *
 * The contracts stay uncurated (owner decision 2026-11-15): nothing here
 * refuses an asset. A check states what was looked for and what was found.
 * 'not_found' means the checker looked and did not find that power (for a
 * simulated move: the move went through); it never means the asset is safe,
 * and no surface may say so. 'unknown' means the checker could not tell,
 * which a surface states as such. A check that does not apply to the asset's
 * kind is not expected; a check the current list does not run is named as
 * not checked.
 *
 * A 'found' for a function check means the code has a function with that
 * selector. It never says the issuer can use it today (a role may have been
 * renounced), and no surface may say so either.
 *
 * Adding a check needs no migration: the stored id is free text, and a reader
 * that meets an id it does not know shows it as an unrecognised check rather
 * than dropping it. Bump {@link ISSUER_CHECKER_VERSION} with the list, so a
 * reader can tell a run that never looked for a newer power.
 */

export const ISSUER_ASSET_KINDS = ['erc20', 'erc721', 'erc1155', 'unknown'] as const;
export type IssuerAssetKind = (typeof ISSUER_ASSET_KINDS)[number];

const ALL_KINDS = ['erc20', 'erc721', 'erc1155'] as const;
const NFT_KINDS = ['erc721', 'erc1155'] as const;

/** One check: what it looks for, which asset kinds it applies to, and
 *  whether the current list ({@link ISSUER_CHECKER_VERSION}) runs it. */
export interface IssuerPowerCheck {
  readonly description: string;
  readonly appliesTo: readonly Exclude<IssuerAssetKind, 'unknown'>[];
  /** False for a check the current list names but does not run yet: a reader
   *  states it as not checked, never as not found. */
  readonly run: boolean;
}

/**
 * The checks, by stable id. For a function or marker check, 'found' means the
 * code has it. For a simulated move, 'found' means the move was REFUSED (the
 * evidence carries the revert name, or "returned false") and 'not_found'
 * means it went through.
 */
export const ISSUER_POWER_CHECKS = {
  upgradeable_proxy: {
    description:
      'The code is a proxy whose implementation can be replaced (EIP-1967 implementation or beacon slot, EIP-1822, a minimal proxy or a loupe).',
    appliesTo: ALL_KINDS,
    run: true,
  },
  admin_transfer: {
    description: 'The code has a function that moves holders’ tokens without their approval (clawback or forced transfer).',
    appliesTo: ALL_KINDS,
    run: true,
  },
  freeze: {
    description: 'The code has a function that stops an address’s tokens from moving (freeze or blocklist).',
    appliesTo: ALL_KINDS,
    run: true,
  },
  pause: { description: 'The code has a function that pauses every transfer of the token.', appliesTo: ALL_KINDS, run: true },
  paused_now: { description: 'paused() read true at the checked block.', appliesTo: ALL_KINDS, run: true },
  transfer_validator: {
    description: 'The code consults a transfer validator, which can block a marketplace or the platform’s conduit.',
    appliesTo: NFT_KINDS,
    run: true,
  },
  soulbound: {
    description: 'The code marks its tokens as non-transferable (soulbound or non-transferable markers).',
    appliesTo: NFT_KINDS,
    run: true,
  },
  vault_transfer: {
    description:
      'A simulated transfer of one unit or one token between two vaults, called as the vault holding it (eth_call, no gas spent), was refused. Found: the move was refused (evidence: the revert name, or "returned false"). Not found: the move went through. Unknown when no vault holds the asset.',
    appliesTo: ALL_KINDS,
    run: true,
  },
  conduit_transfer: {
    description:
      'A simulated transfer through the marketplace conduit the collateral sale uses (eth_call, no gas spent) was refused. Found: the move was refused (evidence: the revert name, or "returned false"). Not found: the move went through. Not run by checker version 2, so it is reported as not checked.',
    appliesTo: NFT_KINDS,
    run: false,
  },
} as const satisfies Record<string, IssuerPowerCheck>;

export type IssuerPowerCheckId = keyof typeof ISSUER_POWER_CHECKS;

/** The version of the list above. A run stores the version it applied. */
export const ISSUER_CHECKER_VERSION = '2';

export const ISSUER_FINDING_RESULTS = ['found', 'not_found', 'unknown'] as const;
export type IssuerFindingResult = (typeof ISSUER_FINDING_RESULTS)[number];

export function isKnownIssuerCheck(id: string): id is IssuerPowerCheckId {
  return Object.hasOwn(ISSUER_POWER_CHECKS, id);
}

const CHECK_IDS = Object.keys(ISSUER_POWER_CHECKS) as IssuerPowerCheckId[];

/**
 * Whether a check applies to an asset of `kind`. When the checker could not
 * tell the kind ('unknown'), only the checks that apply to every kind count:
 * an NFT-only check is never expected of an asset not known to be an NFT.
 */
export function issuerCheckApplies(id: IssuerPowerCheckId, kind: string): boolean {
  const applies: readonly string[] = ISSUER_POWER_CHECKS[id].appliesTo;
  return kind === 'unknown' ? applies.length === ALL_KINDS.length : applies.includes(kind);
}

/** The checks the current list runs on an asset of `kind`: the set a run is
 *  complete over (every one of them answered found or not_found). */
export function issuerChecksRunFor(kind: string): IssuerPowerCheckId[] {
  return CHECK_IDS.filter((id) => ISSUER_POWER_CHECKS[id].run && issuerCheckApplies(id, kind));
}

/** The checks that apply to `kind` but the current list does not run yet:
 *  a reader names them as not checked. */
export function issuerChecksNotRunFor(kind: string): IssuerPowerCheckId[] {
  return CHECK_IDS.filter((id) => !ISSUER_POWER_CHECKS[id].run && issuerCheckApplies(id, kind));
}

/**
 * Whether a run under the CURRENT list is complete: every check it runs on
 * that kind answered found or not_found. A check that does not apply, or that
 * the list does not run, never makes a run incomplete.
 */
export function issuerRunComplete(kind: string, results: ReadonlyMap<string, string>): boolean {
  return issuerChecksRunFor(kind).every((id) => {
    const r = results.get(id);
    return r === 'found' || r === 'not_found';
  });
}
