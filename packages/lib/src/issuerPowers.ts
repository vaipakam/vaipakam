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
 * Adding a check needs no migration: the stored id is free text, and a reader
 * that meets an id it does not know shows it as an unrecognised check rather
 * than dropping it. Bump {@link ISSUER_CHECKER_VERSION} with the list, so a
 * reader can tell a run that never looked for a newer power.
 */

/** The checks, by stable id, with what each one looks for. */
export const ISSUER_POWER_CHECKS = {
  upgradeable_proxy:
    'The contract is a proxy whose code an admin can replace (EIP-1967, beacon or transparent proxy slots).',
  admin_transfer:
    'An admin can move holders’ tokens without their approval (clawback or forced-transfer functions).',
  freeze:
    'An admin can freeze an address so its tokens cannot move (freeze or blocklist functions).',
  pause: 'An admin can pause every transfer of the token.',
  transfer_validator:
    'A collection consults a transfer validator that can block a marketplace or the platform’s conduit.',
  soulbound: 'The tokens cannot be transferred at all (soulbound or non-transferable markers).',
  conduit_transfer:
    'A simulated transfer through the platform’s conduit succeeded or failed (eth_call, no gas spent).',
} as const;

export type IssuerPowerCheckId = keyof typeof ISSUER_POWER_CHECKS;

/** The version of the list above. A run stores the version it applied. */
export const ISSUER_CHECKER_VERSION = '1';

export const ISSUER_FINDING_RESULTS = ['found', 'not_found', 'unknown'] as const;
export type IssuerFindingResult = (typeof ISSUER_FINDING_RESULTS)[number];

export const ISSUER_ASSET_KINDS = ['erc20', 'erc721', 'erc1155', 'unknown'] as const;
export type IssuerAssetKind = (typeof ISSUER_ASSET_KINDS)[number];

export function isKnownIssuerCheck(id: string): id is IssuerPowerCheckId {
  return Object.hasOwn(ISSUER_POWER_CHECKS, id);
}
