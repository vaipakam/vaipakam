/**
 * Pure ERC20 / EVM address helpers — no i18n, no React, no viem.
 *
 * Lives outside `format.ts` (which is i18n-coupled and stays
 * apps/app-local until the i18n surface is itself extracted) so a
 * consumer can import a clean address-shortener without pulling the
 * i18n tree. The original such consumer was `@vaipakam/ui`, retired
 * in #1963; the separation still earns its keep for every other
 * React-free caller.
 */

/** Canonical EVM zero-address. */
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Compact 6+4 ellipsised display of an address. Returns `'Native'`
 * for the zero-address (which is the conventional "native gas" /
 * "ETH" sentinel across the codebase) and `''` for empty input.
 *
 *   shortenAddr('0xC02aaA39…CC2') → '0xC02a...6Cc2'
 *   shortenAddr('0x0000…0000')    → 'Native'
 *   shortenAddr('')                → ''
 */
export function shortenAddr(addr: string): string {
  if (!addr) return '';
  if (addr.toLowerCase() === ZERO_ADDRESS) return 'Native';
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}
