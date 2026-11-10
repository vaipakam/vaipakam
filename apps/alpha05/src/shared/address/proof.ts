/**
 * #3415 — proof that the reader controls an address before it is saved as
 * a verified one (RB-ADDRESS-GUARD). The address signs a typed message
 * naming the account it will receive payouts for, itself, the network, the
 * protocol's contract and why; a smart-contract wallet signs through its
 * own contract (ERC-1271), and the check reads that contract. Nothing is
 * sent on chain: the signature only shows that whoever asked can sign for
 * the address, so a mistyped or poisoned address cannot pass.
 *
 * The request can travel to another device as a link, and the signature
 * back as a short code; both carry only what is signed, never a key.
 */
import { getAddress, isAddress, isHex, type PublicClient } from 'viem';

type Hex = `0x${string}`;

/** What the address is being saved for. */
export type ProofPurpose = 'destination' | 'keeper';

export interface ControlChallenge {
  chainId: number;
  /** The protocol's contract on that network, so a proof for one network or
   *  deployment is never read as one for another. */
  diamond: Hex;
  /** The wallet that asked: the account the address will serve. */
  account: Hex;
  /** The address that signs. */
  destination: Hex;
  purpose: ProofPurpose;
  /** Random, so two requests are never the same message. */
  nonce: Hex;
  /** When the request was made, in seconds. */
  issuedAt: number;
}

export interface ControlProof {
  challenge: ControlChallenge;
  signature: Hex;
}

/** How long a request may wait for its signature. */
export const CHALLENGE_LIFETIME_S = 7 * 86_400;

/** The signing domain: its own name, so the message can never be read as
 *  one of the protocol's on-chain signatures. */
export const PROOF_DOMAIN_NAME = 'Vaipakam Address Check';

export const CONTROL_TYPES = {
  AddressControl: [
    { name: 'account', type: 'address' },
    { name: 'destination', type: 'address' },
    { name: 'purpose', type: 'string' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'issuedAt', type: 'uint256' },
  ],
} as const;

/** The typed data the address signs. */
export function controlTypedData(c: ControlChallenge) {
  return {
    domain: { name: PROOF_DOMAIN_NAME, version: '1', chainId: c.chainId, verifyingContract: c.diamond },
    types: CONTROL_TYPES,
    primaryType: 'AddressControl' as const,
    message: { account: c.account, destination: c.destination, purpose: c.purpose, nonce: c.nonce, issuedAt: BigInt(c.issuedAt) },
  };
}

export function newChallenge(
  base: Omit<ControlChallenge, 'nonce' | 'issuedAt'>,
  now: number = Math.floor(Date.now() / 1000),
  random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
): ControlChallenge {
  const bytes = random(32);
  const nonce = ('0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')) as Hex;
  return { ...base, account: getAddress(base.account), destination: getAddress(base.destination), diamond: getAddress(base.diamond), nonce, issuedAt: now };
}

function isAddr(x: unknown): x is Hex {
  return typeof x === 'string' && isAddress(x, { strict: false });
}

/** Read a challenge strictly: any field of the wrong shape refuses the
 *  whole request, never a guess. */
export function parseChallenge(raw: unknown): ControlChallenge | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!Number.isSafeInteger(r.chainId) || (r.chainId as number) <= 0) return null;
  if (!isAddr(r.diamond) || !isAddr(r.account) || !isAddr(r.destination)) return null;
  if (r.purpose !== 'destination' && r.purpose !== 'keeper') return null;
  if (typeof r.nonce !== 'string' || !isHex(r.nonce) || r.nonce.length !== 66) return null;
  if (!Number.isSafeInteger(r.issuedAt) || (r.issuedAt as number) <= 0) return null;
  return {
    chainId: r.chainId as number,
    diamond: getAddress(r.diamond),
    account: getAddress(r.account),
    destination: getAddress(r.destination),
    purpose: r.purpose,
    nonce: r.nonce.toLowerCase() as Hex,
    issuedAt: r.issuedAt as number,
  };
}

export function parseProof(raw: unknown): ControlProof | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const challenge = parseChallenge(r.challenge);
  if (!challenge || typeof r.signature !== 'string' || !isHex(r.signature) || r.signature.length < 4) return null;
  return { challenge, signature: r.signature as Hex };
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(code: string): unknown {
  try {
    const b64 = code.trim().replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0))));
  } catch {
    return null;
  }
}

/** The request as it travels in a link. */
export function encodeChallenge(c: ControlChallenge): string {
  return toBase64Url(JSON.stringify(c));
}

export function decodeChallenge(code: string): ControlChallenge | null {
  return parseChallenge(fromBase64Url(code));
}

/** The signed answer as a code to paste back. */
export function encodeProof(p: ControlProof): string {
  return toBase64Url(JSON.stringify(p));
}

export function decodeProof(code: string): ControlProof | null {
  return parseProof(fromBase64Url(code));
}

export type ProofVerdict =
  | { ok: true }
  /** The code answers a different request than the one waiting. */
  | { ok: false; reason: 'mismatch' }
  /** The request waited longer than {@link CHALLENGE_LIFETIME_S}. */
  | { ok: false; reason: 'expired' }
  /** The signature is not the address's. */
  | { ok: false; reason: 'badSignature' };

function sameChallenge(a: ControlChallenge, b: ControlChallenge): boolean {
  return (
    a.chainId === b.chainId &&
    a.diamond.toLowerCase() === b.diamond.toLowerCase() &&
    a.account.toLowerCase() === b.account.toLowerCase() &&
    a.destination.toLowerCase() === b.destination.toLowerCase() &&
    a.purpose === b.purpose &&
    a.nonce.toLowerCase() === b.nonce.toLowerCase() &&
    a.issuedAt === b.issuedAt
  );
}

/** Check a proof against the request this browser is waiting on: the same
 *  request, still in time, signed by the address itself (an ordinary key,
 *  or a smart-contract wallet answering through its own contract). A source
 *  that fails to answer throws, so the caller's read rail can try the next
 *  source; only when every source fails does the caller state it unread. */
export async function verifyProof(
  client: Pick<PublicClient, 'verifyTypedData'>,
  proof: ControlProof,
  waiting: ControlChallenge,
  now: number = Math.floor(Date.now() / 1000),
): Promise<ProofVerdict> {
  if (!sameChallenge(proof.challenge, waiting)) return { ok: false, reason: 'mismatch' };
  if (now > waiting.issuedAt + CHALLENGE_LIFETIME_S) return { ok: false, reason: 'expired' };
  const valid = await client.verifyTypedData({ address: waiting.destination, signature: proof.signature, ...controlTypedData(waiting) });
  return valid ? { ok: true } : { ok: false, reason: 'badSignature' };
}
