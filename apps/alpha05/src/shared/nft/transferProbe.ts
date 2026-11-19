/**
 * #3433 — a test transfer of an NFT before an offer that pledges it is built.
 * A collection can block a move without any protocol call (a soulbound or
 * non-transferable token, a paused collection, a transfer validator that
 * refuses the protocol as operator), and a loan must never come to rest on a
 * token that cannot reach the vault. So the review asks the token itself, by
 * a simulated call that sends nothing and costs nothing, at the block the
 * holding was read at.
 *
 * Who moves it in the test is said: the protocol, the operator a real post
 * uses, once the wallet lets it move the token; before that, the wallet
 * itself (which catches a token that cannot move at all; the protocol's own
 * move is then tested by the dry run after the approval). The test moves the
 * token to the poster's vault, or for an ERC-721 to the protocol when the
 * post opens the vault. An ERC-1155 move calls the receiver's hook, so it is
 * tested only into a vault that exists.
 */
import { parseAbi, type PublicClient } from 'viem';
import type { OwnStateClient } from '../../chain/ownRail';
import { refusalFromError } from '../eligibility/refusal';
import { askThrough } from '../tx/simulate';

type Hex = `0x${string}`;
const ZERO = /^0x0{40}$/i;

const MOVE_ABI = parseAbi([
  'function transferFrom(address from, address to, uint256 tokenId)',
  'function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes data)',
]);

export type TransferProbe =
  | { kind: 'moves'; by: 'protocol' | 'holder'; blockNumber: bigint }
  | { kind: 'refused'; by: 'protocol' | 'holder'; reason: string; blockNumber: bigint }
  | { kind: 'unread'; reason: string }
  /** Not asked: the wallet does not hold it, or an ERC-1155 has no vault yet. */
  | { kind: 'not-asked' };

export interface ProbeInput {
  asset: Hex;
  standard: 'erc721' | 'erc1155';
  tokenId: bigint;
  /** How many, for an ERC-1155. */
  quantity: bigint;
  holder: Hex;
  diamond: Hex;
  /** The holder's vault; the zero address when posting opens it. */
  vault: Hex;
  /** Whether the wallet already lets the protocol move it. */
  protocolMayMove: boolean;
  blockNumber: bigint;
}

/** The call the test makes, or null when there is none to make. */
export function probeCall(p: ProbeInput): { by: 'protocol' | 'holder'; account: Hex; to: Hex; call: Parameters<PublicClient['simulateContract']>[0] } | null {
  const noVault = ZERO.test(p.vault);
  if (p.standard === 'erc1155' && noVault) return null;
  const to = noVault ? p.diamond : p.vault;
  const by = p.protocolMayMove ? 'protocol' : 'holder';
  const account = by === 'protocol' ? p.diamond : p.holder;
  const call =
    p.standard === 'erc721'
      ? { address: p.asset, abi: MOVE_ABI, functionName: 'transferFrom' as const, args: [p.holder, to, p.tokenId] as const, account, blockNumber: p.blockNumber }
      : {
          address: p.asset,
          abi: MOVE_ABI,
          functionName: 'safeTransferFrom' as const,
          args: [p.holder, to, p.tokenId, p.quantity, '0x'] as const,
          account,
          blockNumber: p.blockNumber,
        };
  return { by, account, to, call: call as Parameters<PublicClient['simulateContract']>[0] };
}

export async function probeTransfer(own: Pick<OwnStateClient, 'sources'>, p: ProbeInput): Promise<TransferProbe> {
  const c = probeCall(p);
  if (c === null) return { kind: 'not-asked' };
  const asked = await askThrough(own, (client) => client.simulateContract(c.call));
  if (asked.kind === 'answered') return { kind: 'moves', by: c.by, blockNumber: p.blockNumber };
  if (asked.kind === 'reverted') return { kind: 'refused', by: c.by, reason: refusalFromError(asked.error).reason, blockNumber: p.blockNumber };
  return { kind: 'unread', reason: asked.reason };
}
