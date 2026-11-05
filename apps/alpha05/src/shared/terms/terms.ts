/**
 * ACC-15 — the Terms gate's state, read on the network the ACTION is scoped
 * to. The protocol records one Terms version and its content fingerprint;
 * version 0 means no Terms are in force there, so nothing is gated. A
 * wallet whose recorded acceptance is not the current pair must accept
 * before a gated action (new exposure: a new offer, a deposit, turning a
 * consent on); exits are never gated. A read that fails is "cannot
 * confirm", never "not accepted": the surface says so and offers a retry.
 */
import type { Abi, PublicClient } from 'viem';
import { LegalFacetABI } from '@vaipakam/contracts/abis';
import { GUIDE_ORIGIN } from '../help/guide';

const LEGAL = LegalFacetABI as Abi;

type Hex = `0x${string}`;

export type TermsState =
  /** No Terms version is in force on this network: nothing is gated. */
  | { kind: 'none' }
  | { kind: 'accepted'; version: number; hash: Hex }
  /** The wallet must accept `version` before a gated action. `previous` is
   *  the version it accepted earlier, when it did (a newer version re-asks). */
  | { kind: 'needed'; version: number; hash: Hex; previous: { version: number; acceptedAt: number } | null };

/** The acceptance the protocol has recorded for a wallet, whatever version
 *  is in force now; null when it has recorded none. */
export interface AcceptanceRecord {
  version: number;
  hash: Hex;
  acceptedAt: number;
}

export async function readAcceptance(client: PublicClient, diamond: Hex, account: Hex): Promise<AcceptanceRecord | null> {
  const record = (await client.readContract({ address: diamond, abi: LEGAL, functionName: 'getUserTosAcceptance', args: [account] })) as {
    version: number;
    hash: Hex;
    acceptedAt: bigint;
  };
  return Number(record.version) === 0 ? null : { version: Number(record.version), hash: record.hash, acceptedAt: Number(record.acceptedAt) };
}

export async function readTerms(client: PublicClient, diamond: Hex, account: Hex): Promise<TermsState> {
  const [current, accepted, record] = await Promise.all([
    client.readContract({ address: diamond, abi: LEGAL, functionName: 'getCurrentTos' }) as Promise<readonly [number, Hex]>,
    client.readContract({ address: diamond, abi: LEGAL, functionName: 'hasAcceptedCurrentTerms', args: [account] }) as Promise<boolean>,
    readAcceptance(client, diamond, account),
  ]);
  return termsFrom(Number(current[0]), current[1], accepted, record === null ? null : { version: record.version, acceptedAt: record.acceptedAt });
}

/** The state from the three answers; pure, so the rule is tested once. */
export function termsFrom(version: number, hash: Hex, accepted: boolean, previous: { version: number; acceptedAt: number } | null): TermsState {
  if (version === 0) return { kind: 'none' };
  if (accepted) return { kind: 'accepted', version, hash };
  return { kind: 'needed', version, hash, previous };
}

/** The version's permanent address on the site: the text a version number
 *  resolves to never changes, and an unpublished version's page says so. */
export function termsUrl(version: number): string {
  return `${GUIDE_ORIGIN}/terms/v${version}`;
}

export const PRIVACY_URL = `${GUIDE_ORIGIN}/privacy`;

/** The fingerprint as shown: the whole hash, grouped for reading aloud. */
export function fingerprint(hash: Hex): string {
  const body = hash.slice(2);
  const groups: string[] = [];
  for (let i = 0; i < body.length; i += 8) groups.push(body.slice(i, i + 8));
  return `0x ${groups.join(' ')}`;
}

export const LEGAL_ABI = LEGAL;
