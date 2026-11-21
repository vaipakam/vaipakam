/**
 * #3433 — the issuer-power checks the off-chain checker runs on a token or
 * collection, as ONE list for the writer (the keeper machine's pass) and the
 * reader (the indexer's `GET /assets/issuer-powers`, then the apps).
 *
 * The contracts stay uncurated (owner decision 2026-11-15): nothing here
 * refuses an asset. A check states what was looked for and what was found.
 * 'not_found' means the checker looked and did not find that power; it never
 * means the asset is safe, and no surface may say so. 'unknown' means the
 * checker could not tell, which a surface states as such.
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

/** The checks, by stable id, with what each one looks for. */
export const ISSUER_POWER_CHECKS = {
  upgradeable_proxy:
    'The code is a proxy whose implementation can be replaced (EIP-1967 implementation or beacon slot, EIP-1822, a minimal proxy or a loupe).',
  admin_transfer:
    'The code has a function that moves holders’ tokens without their approval (clawback or forced transfer).',
  freeze: 'The code has a function that stops an address’s tokens from moving (freeze or blocklist).',
  pause: 'The code has a function that pauses every transfer of the token.',
  paused_now: 'paused() read true at the checked block.',
  transfer_validator:
    'The code consults a transfer validator, which can block a marketplace or the platform’s conduit.',
  soulbound: 'The code marks its tokens as non-transferable (soulbound or non-transferable markers).',
  vault_transfer:
    'A simulated transfer of one unit or one token from a vault that holds the asset to another vault, called as the holding vault (eth_call, no gas spent). Unknown when no vault holds the asset.',
  conduit_transfer:
    'A simulated transfer through the marketplace conduit the collateral sale uses (eth_call, no gas spent). Unknown where the network has no sale route.',
} as const;

export type IssuerPowerCheckId = keyof typeof ISSUER_POWER_CHECKS;

/** The version of the list above. A run stores the version it applied. */
export const ISSUER_CHECKER_VERSION = '2';

export const ISSUER_FINDING_RESULTS = ['found', 'not_found', 'unknown'] as const;
export type IssuerFindingResult = (typeof ISSUER_FINDING_RESULTS)[number];

export const ISSUER_ASSET_KINDS = ['erc20', 'erc721', 'erc1155', 'unknown'] as const;
export type IssuerAssetKind = (typeof ISSUER_ASSET_KINDS)[number];

export function isKnownIssuerCheck(id: string): id is IssuerPowerCheckId {
  return Object.hasOwn(ISSUER_POWER_CHECKS, id);
}
