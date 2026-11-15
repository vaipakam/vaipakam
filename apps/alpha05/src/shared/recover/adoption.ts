/**
 * ACC-25 — what an adoption signs, apart from every read: the declaration
 * word for word, the EIP-712 domain, type and message the protocol hashes
 * (`VaultDepositoryFacet.adoptionDigest`), and the subject and draft they
 * are built from. Pure, so the e2e suite signs the same message the app does.
 */
import { keccak256, toBytes } from 'viem';
import { ASSET_TYPE, type Standard } from '../nft/nft';

type Hex = `0x${string}`;

/**
 * The acknowledgement the wallet signs, word for word: the protocol binds
 * its keccak256 (`adoptionAckTextHash`), and the app refuses to ask for a
 * signature when the protocol's hash is not this text's.
 */
export const ADOPTION_ACK_TEXT =
  "I am declaring that the source address belongs to a wallet I control or authorized. The asset will be credited to my vault and will leave it only through an ordinary vault withdrawal. If the source is on the sanctions list, my vault will be locked under the protocol's sanctions policy until the address is de-listed.";

export const ADOPTION_ACK_HASH: Hex = keccak256(toBytes(ADOPTION_ACK_TEXT));

/** The word the reader types to confirm an adoption. */
export const CONFIRM_WORD = 'CONFIRM';

/** The asset the page looks up: its standard as its contract claims it, the
 *  token, and the token id (zero for an ERC-20). */
export interface RecoverSubject {
  standard: Standard;
  asset: Hex;
  tokenId: bigint;
}

/** The token id the protocol keys a subject under (zero for an ERC-20). */
export const subjectTokenId = (s: Pick<RecoverSubject, 'standard' | 'tokenId'>): bigint => (s.standard === 'erc20' ? 0n : s.tokenId);

/** What the reader chose to adopt: how much (one for an ERC-721) and the
 *  source declared for it. */
export interface AdoptDraft {
  subject: RecoverSubject;
  amount: bigint;
  source: Hex;
}

/** The amount an adoption credits, in the asset's own unit. */
export const adoptAmount = (d: Pick<AdoptDraft, 'subject' | 'amount'>): bigint => (d.subject.standard === 'erc721' ? 1n : d.amount);

/** The EIP-712 domain and types of the acknowledgement
 *  (`VaultDepositoryFacet.adoptionDigest`). */
export const ADOPTION_TYPES = {
  AdoptionAcknowledgment: [
    { name: 'user', type: 'address' },
    { name: 'asset', type: 'address' },
    { name: 'kind', type: 'uint8' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'declaredSource', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'ackTextHash', type: 'bytes32' },
  ],
} as const;

export function adoptionDomain(chainId: number, diamond: Hex) {
  return { name: 'Vaipakam Vault Adoption', version: '1', chainId, verifyingContract: diamond } as const;
}

export function adoptionMessage(account: Hex, d: AdoptDraft, nonce: bigint, deadline: bigint) {
  return {
    user: account,
    asset: d.subject.asset,
    kind: ASSET_TYPE[d.subject.standard],
    tokenId: subjectTokenId(d.subject),
    declaredSource: d.source,
    amount: adoptAmount(d),
    nonce,
    deadline,
    ackTextHash: ADOPTION_ACK_HASH,
  } as const;
}
