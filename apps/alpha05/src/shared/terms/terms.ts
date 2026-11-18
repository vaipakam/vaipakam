/**
 * ACC-15 / #3734 — where a wallet stands on the Terms of Service on one
 * network, read on the network the action is scoped to. Each network keeps
 * two values: the LATEST version (the one a new acceptance names) and the
 * MINIMUM version (the oldest acceptance that still counts). A wallet is
 * current when it accepted a version in force from the minimum to the
 * latest; version 0 means no Terms are in force there, so nothing is gated.
 * A small change publishes a new latest version and leaves everyone current;
 * a material change raises the minimum, announced with a notice, and from
 * its date a wallet that has not accepted a version it counts takes on no
 * new position. Leaving or reducing a position is never gated. A read that
 * fails is "cannot confirm", never "not accepted": the surface says so and
 * offers a retry.
 */
import type { Abi, PublicClient } from 'viem';
import { LegalFacetABI } from '@vaipakam/contracts/abis';
import { GUIDE_ORIGIN } from '../help/guide';
import { batchCall } from '../tx/batch';

const LEGAL = LegalFacetABI as Abi;

type Hex = `0x${string}`;

/** A material change waiting for its date: from `effectiveAt` the minimum is
 *  `minVersion`. `newVersion` says it brings a new text (`version`, which a
 *  wallet may accept now); otherwise it raises the minimum to the version
 *  already latest. */
export interface TermsAnnouncement {
  version: number;
  hash: Hex;
  effectiveAt: number;
  minVersion: number;
  newVersion: boolean;
}

/** The network's two values and its pending change, with which versions
 *  this wallet accepted. */
export interface TermsPosture {
  latest: number;
  latestHash: Hex;
  minimum: number;
  announced: TermsAnnouncement | null;
  accepted: readonly number[];
}

export type TermsState =
  /** No Terms version is in force on this network: nothing is gated. */
  | { kind: 'none' }
  /** The wallet is current. `version` / `hash` are the latest in force.
   *  `latestAccepted` is false after a small change the wallet has not
   *  accepted (it stays current; accepting is offered, never required).
   *  `due` is a pending material change after whose date the wallet would
   *  no longer be current, with the version to accept for it. */
  | { kind: 'accepted'; version: number; hash: Hex; posture: TermsPosture; latestAccepted: boolean; due: TermsAnnouncement | null }
  /** The wallet must accept `version` (the latest) before a gated action.
   *  `previous` is its most recent earlier acceptance, when it has one.
   *  `alsoAnnounced` is a new version announced and not yet accepted, which
   *  the same transaction accepts too, so the wallet is not asked again on
   *  its date. */
  | {
      kind: 'needed';
      version: number;
      hash: Hex;
      previous: { version: number; acceptedAt: number } | null;
      posture: TermsPosture;
      alsoAnnounced: TermsAnnouncement | null;
    };

/** The acceptance the protocol has recorded for a wallet, whatever version
 *  is in force now; null when it has recorded none. */
export interface AcceptanceRecord {
  version: number;
  hash: Hex;
  acceptedAt: number;
}

/** `at` pins a read to a block (a measurement); omitted, it reads latest. */
type At = { blockNumber: bigint } | undefined;

export async function readAcceptance(client: PublicClient, diamond: Hex, account: Hex, at?: At): Promise<AcceptanceRecord | null> {
  const record = (await client.readContract({ address: diamond, abi: LEGAL, functionName: 'getUserTosAcceptance', args: [account], ...at })) as {
    version: number;
    hash: Hex;
    acceptedAt: bigint;
  };
  return Number(record.version) === 0 ? null : { version: Number(record.version), hash: record.hash, acceptedAt: Number(record.acceptedAt) };
}

/** The acceptance of one version, or null when the wallet has none for it. */
export async function readAcceptanceOf(client: PublicClient, diamond: Hex, account: Hex, version: number, at?: At): Promise<AcceptanceRecord | null> {
  const record = (await client.readContract({ address: diamond, abi: LEGAL, functionName: 'getUserTosAcceptanceOf', args: [account, version], ...at })) as {
    version: number;
    hash: Hex;
    acceptedAt: bigint;
  };
  return Number(record.version) === 0 ? null : { version: Number(record.version), hash: record.hash, acceptedAt: Number(record.acceptedAt) };
}

/** The network's Terms posture with nobody's acceptances: what the Connect
 *  step shows before a wallet is chosen. */
export async function readPosture(client: PublicClient, diamond: Hex, at?: At): Promise<Omit<TermsPosture, 'accepted'>> {
  const [versions, announced] = await Promise.all([
    client.readContract({ address: diamond, abi: LEGAL, functionName: 'getTosVersions', ...at }) as Promise<readonly [number, Hex, number]>,
    client.readContract({ address: diamond, abi: LEGAL, functionName: 'getAnnouncedTos', ...at }) as Promise<readonly [number, Hex, bigint, number, boolean]>,
  ]);
  return {
    latest: Number(versions[0]),
    latestHash: versions[1],
    minimum: Number(versions[2]),
    announced:
      Number(announced[0]) === 0
        ? null
        : { version: Number(announced[0]), hash: announced[1], effectiveAt: Number(announced[2]), minVersion: Number(announced[3]), newVersion: announced[4] },
  };
}

export async function readTerms(client: PublicClient, diamond: Hex, account: Hex, at?: At): Promise<TermsState> {
  const [posture, current, accepted, record] = await Promise.all([
    readPosture(client, diamond, at),
    client.readContract({ address: diamond, abi: LEGAL, functionName: 'isTermsCurrent', args: [account], ...at }) as Promise<boolean>,
    client.readContract({ address: diamond, abi: LEGAL, functionName: 'getUserAcceptedTosVersions', args: [account], ...at }) as Promise<readonly number[]>,
    readAcceptance(client, diamond, account, at),
  ]);
  return termsFrom({ ...posture, accepted: accepted.map(Number) }, current, record === null ? null : { version: record.version, acceptedAt: record.acceptedAt });
}

/** The state from the answers; pure, so the rule is tested once. `current`
 *  is the protocol's own verdict and is never recomputed here; the posture
 *  only says which version to ask for and what is due. */
export function termsFrom(posture: TermsPosture, current: boolean, previous: { version: number; acceptedAt: number } | null): TermsState {
  if (posture.latest === 0) return { kind: 'none' };
  const has = (v: number) => posture.accepted.includes(v);
  const a = posture.announced;
  if (current) {
    // After the date, a version from the announced minimum up to the latest
    // then (the announced new version, or the latest now) counts.
    const ceiling = a ? (a.newVersion ? a.version : posture.latest) : 0;
    const due = a && !posture.accepted.some((v) => v >= a.minVersion && v <= ceiling) ? a : null;
    return { kind: 'accepted', version: posture.latest, hash: posture.latestHash, posture, latestAccepted: has(posture.latest), due };
  }
  const alsoAnnounced = a && a.newVersion && !has(a.version) ? a : null;
  return { kind: 'needed', version: posture.latest, hash: posture.latestHash, previous, posture, alsoAnnounced };
}

/** What a current wallet is offered to accept: the announced version when
 *  that is what is due and the latest is already accepted, otherwise the
 *  latest (with an announced new version in the same transaction). */
export function updateTerms(t: Extract<TermsState, { kind: 'accepted' }>): Extract<TermsState, { kind: 'needed' }> | null {
  const a = t.posture.announced;
  const alsoAnnounced = a && a.newVersion && !t.posture.accepted.includes(a.version) ? a : null;
  if (t.latestAccepted && alsoAnnounced)
    return { kind: 'needed', version: alsoAnnounced.version, hash: alsoAnnounced.hash, previous: null, posture: t.posture, alsoAnnounced: null };
  if (t.latestAccepted && !t.due) return null;
  return { kind: 'needed', version: t.version, hash: t.hash, previous: null, posture: t.posture, alsoAnnounced };
}

/** The newest version the wallet accepted that counts now (from the minimum
 *  up to the latest); 0 when none does. */
export function countingVersion(posture: TermsPosture): number {
  return posture.accepted.filter((v) => v >= posture.minimum && v <= posture.latest).reduce((m, v) => Math.max(m, v), 0);
}

/** The wallet's own acceptance as one call: `acceptTerms` for the version
 *  asked, and, while a new version is announced and not yet accepted, a batch
 *  of two `acceptTerms` items (the latest, then the announced one), so the
 *  wallet is not asked again on its date. Never for anyone but the sender. */
export function acceptTermsCall(terms: { version: number; hash: Hex; alsoAnnounced?: TermsAnnouncement | null }) {
  const one = { abi: LEGAL, functionName: 'acceptTerms', args: [terms.version, terms.hash] as const };
  if (!terms.alsoAnnounced) return one;
  return batchCall([one, { abi: LEGAL, functionName: 'acceptTerms', args: [terms.alsoAnnounced.version, terms.alsoAnnounced.hash] }]);
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
