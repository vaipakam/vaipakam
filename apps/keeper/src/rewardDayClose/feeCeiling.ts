// apps/keeper/src/rewardDayClose/feeCeiling.ts
//
// #2627 — the most this pass pays, as the CCIP fee of one send, on each chain.
//
// Every paid send (a mirror's `closeDay`, Base's `broadcastGlobal` and
// `broadcastGlobalTo`) carries the fee its messenger quoted in the same run.
// The messenger is governance-configured, so a fee set wrong (or by a
// compromised owner) would otherwise be paid from the keeper's unattended
// key, up to `MAX_SENDS_PER_RUN` times per chain per run. The ceiling is
// checked in the one place every send goes through (`Sender.call`): a quote
// above it is not paid, the call is reported refused with the quote and the
// ceiling, and the day stays owed until the quote falls or the ceiling is
// raised. A ceiling that cannot be read (the variable is malformed) holds
// every paid send, and says so: an unknown never pays.
//
// The variable is one plain knob, `REWARD_DAY_CLOSE_MAX_FEE_WEI`: a comma
// list of `<chainId>=<wei>` entries, plus an optional `*=<wei>` for every
// chain not named. Unset or empty means {@link DEFAULT_MAX_FEE_WEI} on every
// chain. Wei is a plain decimal integer; `0` pays nothing on that chain.

/** The ceiling when the variable names neither the chain nor `*`: 0.002 of
 *  the chain's native token. At arming (2026-10-22) the report fee read about
 *  0.00005 ETH on Arbitrum Sepolia and 0.00016 BNB on BNB Testnet, so the
 *  default still pays a quote about 12 to 40 times those. */
export const DEFAULT_MAX_FEE_WEI = 2n * 10n ** 15n;
export const MAX_FEE_VAR = 'REWARD_DAY_CLOSE_MAX_FEE_WEI';

/** The ceiling for one chain and where it came from, or why it is unknown. */
export type FeeCeiling = { wei: bigint; from: string } | { unread: string };

const WEI = /^\d+$/;
const KEY = /^(\*|\d+)$/;

/** The fee ceiling `raw` (the variable's value) sets for `chainId`. */
export function feeCeiling(raw: string | undefined, chainId: number): FeeCeiling {
  const text = (raw ?? '').trim();
  if (text === '') return { wei: DEFAULT_MAX_FEE_WEI, from: `the default, ${MAX_FEE_VAR} being unset` };
  const entries = new Map<string, bigint>();
  for (const part of text.split(',')) {
    const entry = part.trim();
    const eq = entry.indexOf('=');
    const key = eq < 0 ? '' : entry.slice(0, eq).trim();
    const wei = eq < 0 ? '' : entry.slice(eq + 1).trim();
    if (!KEY.test(key) || !WEI.test(wei)) return malformed(`"${entry}" is not <chainId>=<wei> or *=<wei>`);
    const k = key === '*' ? '*' : String(Number(key));
    if (entries.has(k)) return malformed(`${k === '*' ? '*' : `chain ${k}`} is named twice`);
    entries.set(k, BigInt(wei));
  }
  const own = entries.get(String(chainId));
  if (own !== undefined) return { wei: own, from: `${MAX_FEE_VAR}, this chain's entry` };
  const rest = entries.get('*');
  if (rest !== undefined) return { wei: rest, from: `${MAX_FEE_VAR}, its * entry` };
  return { wei: DEFAULT_MAX_FEE_WEI, from: `the default, ${MAX_FEE_VAR} naming neither this chain nor *` };
}

function malformed(why: string): FeeCeiling {
  return { unread: `this keeper's fee ceiling, ${MAX_FEE_VAR} being malformed (${why})` };
}
