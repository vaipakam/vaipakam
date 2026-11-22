/**
 * Codex #3806 — a gift's outcome is read from its own transaction: the
 * position token's `Transfer` log from the giver to the reviewed receiver
 * for the reviewed token. Ownership at the end of the block cannot say it,
 * since a receiver may pass the token on in its receive hook or later in the
 * same block, and the gift has still happened.
 */
import { parseEventLogs, type Log } from 'viem';

type Hex = `0x${string}`;

const TRANSFER = [
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'tokenId', type: 'uint256', indexed: true },
    ],
  },
] as const;

/** True when `logs` carry `nft`'s `Transfer` of `tokenId` from `from` to `to`. */
export function giftTransferred(logs: readonly Log[], nft: Hex, from: Hex, to: Hex, tokenId: bigint): boolean {
  const own = logs.filter((l) => l.address.toLowerCase() === nft.toLowerCase());
  return parseEventLogs({ abi: TRANSFER, logs: own as Log[], eventName: 'Transfer', strict: false }).some(
    (l) => l.args.tokenId === tokenId && l.args.from?.toLowerCase() === from.toLowerCase() && l.args.to?.toLowerCase() === to.toLowerCase(),
  );
}
