/**
 * RB-CLICKS — the numeraire equivalent of an amount: what the protocol
 * itself would value it at now, by the one rule it uses for loan-to-value
 * and the health factor (`NumeraireValueFacet.getNumeraireValue`, a debt
 * leg rounded up, a collateral leg rounded down).
 *
 * Only a liquid asset has a value: the protocol values an illiquid one at
 * nothing, and refuses to price one whose price sources disagree. The
 * equivalent says which, instead of showing a figure the protocol would not
 * stand behind. A read that fails is the caller's to state as unread.
 */
import type { Abi, PublicClient } from 'viem';
import { NumeraireValueFacetABI } from '@vaipakam/contracts/abis';
import type { CopyAccess } from '../copy/useCopy';
import { readAssetClass, type AssetClass } from '../offers/assets';
import { formatScaled } from '../ui/format';

type Hex = `0x${string}`;

const VALUE = NumeraireValueFacetABI as Abi;

/** Which way the protocol rounds the leg: a debt (principal) up, collateral
 *  down. */
export type ValueLeg = 'debt' | 'collateral';

export type NumeraireEquivalent =
  /** 1e18-scaled numeraire value. */
  | { kind: 'value'; value: bigint }
  /** The protocol gives the asset no price and values it at nothing. */
  | { kind: 'unpriced' }
  /** The protocol's price sources disagree, so it values nothing now. */
  | { kind: 'distrusted' };

/** The equivalent for an asset whose class is already read. */
export async function readEquivalentFor(
  c: PublicClient,
  diamond: Hex,
  asset: Hex,
  amount: bigint,
  leg: ValueLeg,
  cls: AssetClass,
): Promise<NumeraireEquivalent> {
  if (cls === 'illiquid') return { kind: 'unpriced' };
  if (cls === 'distrusted') return { kind: 'distrusted' };
  const value = (await c.readContract({
    address: diamond,
    abi: VALUE,
    functionName: 'getNumeraireValue',
    args: [asset, amount, leg === 'debt'],
  })) as bigint;
  return { kind: 'value', value };
}

/** The equivalent of `amount` of `asset`, reading its class first. */
export async function readNumeraireEquivalent(c: PublicClient, diamond: Hex, asset: Hex, amount: bigint, leg: ValueLeg): Promise<NumeraireEquivalent> {
  return readEquivalentFor(c, diamond, asset, amount, leg, await readAssetClass(c, diamond, asset));
}

/** Below this a figure cut to two decimals would read as zero. */
const SMALLEST_SHOWN = 10n ** 16n;

/** The equivalent in words. `unit` is the numeraire's own symbol, or null
 *  when it is unset or unread (then a neutral unit is named). */
export function equivalentText(eq: NumeraireEquivalent, unit: string | null, asset: string, { text, format }: Pick<CopyAccess, 'text' | 'format'>): string {
  if (eq.kind === 'unpriced') return format('numeraire.unpriced', { asset });
  if (eq.kind === 'distrusted') return format('numeraire.distrusted', { asset });
  const u = unit ?? text('home.exposureUnit');
  if (eq.value > 0n && eq.value < SMALLEST_SHOWN) return format('numeraire.tiny', { unit: u });
  return format('numeraire.value', { value: formatScaled(eq.value), unit: u });
}
