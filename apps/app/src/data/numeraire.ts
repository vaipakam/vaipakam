/**
 * The protocol's reference currency, from the packed 32-byte symbol
 * `getNumeraireSymbol()` returns (Codex #2683 r1). Shared by every surface
 * that names a numeraire-denominated figure, so they cannot disagree about
 * what the empty word means.
 */
import { hexToString, type Hex } from 'viem';

/** The empty word's meaning, as the contracts and the canonical parameter
 *  reference both state it: a deployment where governance never set the
 *  numeraire runs on USD. */
export const DEFAULT_NUMERAIRE = 'USD';

export interface Numeraire {
  symbol: string;
  /** True when the word was empty, so the symbol is the protocol's
   *  default rather than one governance set. */
  isDefault: boolean;
}

/**
 * The active reference currency from its packed 32-byte symbol. The empty
 * word is not "unset" in the sense of "none": the protocol reads it as its
 * USD default, so the caller can say USD and that it is the default. A word
 * that is not printable text is returned as null, and the caller shows the
 * raw word (or no unit) rather than invent a name for it.
 */
export function numeraireOf(word: string): Numeraire | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(word)) return null;
  if (/^0x0{64}$/.test(word)) return { symbol: DEFAULT_NUMERAIRE, isDefault: true };
  try {
    // With a size, viem trims the trailing zero bytes itself.
    const text = hexToString(word as Hex, { size: 32 });
    return /^[\x20-\x7e]+$/.test(text) ? { symbol: text.toUpperCase(), isDefault: false } : null;
  } catch {
    return null;
  }
}
