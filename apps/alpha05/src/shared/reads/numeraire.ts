/**
 * The protocol's numeraire: the unit every value comparison is made in (a
 * KYC threshold, the periodic-interest threshold, a position's value). Its
 * display symbol is the protocol's own setting, read live, never assumed.
 */
import { hexToString, type Abi, type PublicClient } from 'viem';
import { NumeraireConfigFacetABI } from '@vaipakam/contracts/abis';

type Hex = `0x${string}`;

const NUMERAIRE = NumeraireConfigFacetABI as Abi;

/** The numeraire's display symbol ("USD"), or null when unset or unreadable. */
export async function readNumeraireSymbol(client: PublicClient, diamond: Hex): Promise<string | null> {
  const raw = (await client.readContract({ address: diamond, abi: NUMERAIRE, functionName: 'getNumeraireSymbol' })) as Hex;
  const text = hexToString(raw, { size: 32 }).replace(/\0+$/, '');
  return text.length > 0 ? text : null;
}
