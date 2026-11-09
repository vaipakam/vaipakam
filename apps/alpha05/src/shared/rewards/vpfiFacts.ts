/**
 * RW-02, RW-04, RW-05 — what moving VPFI into or out of the vault changes
 * for the fee-discount tier, read at the review's own block.
 *
 * VPFI moves through the same deposit and withdrawal as any asset (the
 * depository entries ACC-22 / ACC-23 already use), and the protocol counts
 * it for the tier the same way on either route: the tier's input is the
 * protocol-tracked VPFI, which a recorded deposit raises and a recorded
 * withdrawal lowers. One route keeps one set of checks (the pause's escape
 * route, protected mode, the free figure) instead of a second copy for one
 * token. What this module adds is the tier's side: whether the asset IS
 * this network's VPFI, the tracked VPFI (so a withdrawal that takes it to
 * zero can say that the holding time restarts), and the wallet's
 * fee-discount consent (without which holding VPFI changes no fee), and
 * whether this is VPFI's home network: only there does vault VPFI set the
 * tier; elsewhere the tier is a copy of the home network's.
 */
import type { Abi, PublicClient } from 'viem';
import { VPFITokenFacetABI } from '@vaipakam/contracts/abis';
import { VPFI_DISCOUNT_ABI } from '../consent/feeDiscount';
import { answerOrNull } from '../reads/answer';

type Hex = `0x${string}`;

const VPFI_TOKEN = VPFITokenFacetABI as Abi;
const ZERO = '0x0000000000000000000000000000000000000000';

/** The tier's side of a VPFI move; null fields were not read. */
export interface VpfiFacts {
  /** The VPFI the protocol counts for this wallet's tier. */
  tracked: bigint | null;
  /** The wallet's fee-discount consent. */
  consent: boolean | null;
  /** Whether this network is VPFI's home network, the only one whose vault
   *  VPFI sets the tier (other networks apply a copy of the tier resolved
   *  there, so a move on them changes no tier). */
  home: boolean | null;
}

/** Whether this network is VPFI's home network (the protocol's own flag). */
export async function readVpfiHome(c: PublicClient, diamond: Hex, blockNumber?: bigint): Promise<boolean | null> {
  return answerOrNull(c.readContract({ address: diamond, abi: VPFI_TOKEN, functionName: 'isCanonicalVpfiChain', ...(blockNumber === undefined ? {} : { blockNumber }) }) as Promise<boolean>);
}

/** This network's VPFI token, or null when none is set (or it could not be
 *  read). */
export async function readVpfiTokenAt(c: PublicClient, diamond: Hex, blockNumber?: bigint): Promise<Hex | null> {
  const token = await answerOrNull(c.readContract({ address: diamond, abi: VPFI_TOKEN, functionName: 'getVPFIToken', ...(blockNumber === undefined ? {} : { blockNumber }) }) as Promise<Hex>);
  return token === null || token.toLowerCase() === ZERO ? null : token;
}

/** The tier facts when `asset` is this network's VPFI; null when it is not
 *  (or the token could not be read, which the receipt then cannot tie to
 *  the tier). */
export async function readVpfiFacts(c: PublicClient, diamond: Hex, account: Hex, asset: Hex, blockNumber: bigint): Promise<VpfiFacts | null> {
  const token = await readVpfiTokenAt(c, diamond, blockNumber);
  if (token === null || token.toLowerCase() !== asset.toLowerCase()) return null;
  const at = { blockNumber };
  const [tracked, consent, home] = await Promise.all([
    answerOrNull(c.readContract({ address: diamond, abi: VPFI_DISCOUNT_ABI, functionName: 'getTrackedVPFIBalance', args: [account], ...at }) as Promise<bigint>),
    answerOrNull(c.readContract({ address: diamond, abi: VPFI_DISCOUNT_ABI, functionName: 'getVPFIDiscountConsent', args: [account], ...at }) as Promise<boolean>),
    readVpfiHome(c, diamond, blockNumber),
  ]);
  return { tracked, consent, home };
}

/** Whether a withdrawal of `amount` takes the counted VPFI to zero; null
 *  when the counted figure was not read. */
export function emptiesTier(facts: VpfiFacts, amount: bigint): boolean | null {
  return facts.tracked === null ? null : facts.tracked > 0n && amount >= facts.tracked;
}
