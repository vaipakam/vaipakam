// apps/keeper/src/feeCeiling.ts
//
// #2627 — the most one paid send may cost as its CCIP fee, on each chain.
//
// A keeper pass that pays a messenger's quoted fee from the keeper's unattended
// key reads its ceiling here. The messenger is governance-configured, so a fee
// set wrong (or by a compromised owner) would otherwise be paid up to the
// pass's send budget per chain per run. The ceiling is enforced in the one
// place every send goes through (`StepSender.call`): a quote above it is not
// paid, the call is reported refused with the quote and the ceiling, and the
// step stays owed until the quote falls or the ceiling is raised. A ceiling
// that cannot be read (the variable is malformed) holds every paid send, and
// says so: an unknown never pays.
//
// Each paying pass names its own variable, so raising one pass's ceiling never
// raises another's: a comma list of `<chainId>=<wei>` entries, plus an
// optional `*=<wei>` for every chain not named. Unset or empty means
// {@link DEFAULT_MAX_FEE_WEI} on every chain. Wei is a plain decimal integer;
// `0` pays nothing on that chain.

import type { SendFeeCeiling } from './stepSender';

/** The ceiling when the variable names neither the chain nor `*`: 0.002 of
 *  the chain's native token. At arming (2026-10-22) the day report's fee read
 *  about 0.00005 ETH on Arbitrum Sepolia and 0.00016 BNB on BNB Testnet, so the
 *  default still pays a quote about 12 to 40 times those. */
export const DEFAULT_MAX_FEE_WEI = 2n * 10n ** 15n;

const WEI = /^\d+$/;
const KEY = /^(\*|\d+)$/;

/**
 * What a `<chainId>=<wei>[,*=<wei>]` variable says for `chainId`: its own
 * entry, else its `*` entry, else nothing (`none`, also for an unset or empty
 * variable). Malformed text is `unread`, never a guess. Shared by every
 * keeper ceiling read from such a list (#2627 fee ceilings, #3543 gas
 * ceilings), so they parse alike.
 */
export function chainWeiEntry(
  raw: string | undefined,
  chainId: number,
  varName: string,
): { wei: bigint; from: string } | { none: true } | { unread: string } {
  const text = (raw ?? '').trim();
  if (text === '') return { none: true };
  const entries = new Map<string, bigint>();
  for (const part of text.split(',')) {
    const entry = part.trim();
    const eq = entry.indexOf('=');
    const key = eq < 0 ? '' : entry.slice(0, eq).trim();
    const wei = eq < 0 ? '' : entry.slice(eq + 1).trim();
    if (!KEY.test(key) || !WEI.test(wei)) return { unread: `"${entry}" is not <chainId>=<wei> or *=<wei>` };
    const k = key === '*' ? '*' : String(Number(key));
    if (entries.has(k)) return { unread: `${k === '*' ? '*' : `chain ${k}`} is named twice` };
    entries.set(k, BigInt(wei));
  }
  const own = entries.get(String(chainId));
  if (own !== undefined) return { wei: own, from: `${varName}, this chain's entry` };
  const rest = entries.get('*');
  if (rest !== undefined) return { wei: rest, from: `${varName}, its * entry` };
  return { none: true };
}

/** The fee ceiling `raw` (the value of `varName`) sets for `chainId`. */
export function feeCeiling(raw: string | undefined, chainId: number, varName: string): SendFeeCeiling {
  const entry = chainWeiEntry(raw, chainId, varName);
  if ('unread' in entry) return { unread: `this keeper's fee ceiling, ${varName} being malformed (${entry.unread})` };
  if ('wei' in entry) return entry;
  const unset = (raw ?? '').trim() === '';
  return {
    wei: DEFAULT_MAX_FEE_WEI,
    from: unset ? `the default, ${varName} being unset` : `the default, ${varName} naming neither this chain nor *`,
  };
}
