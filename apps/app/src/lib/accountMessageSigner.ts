/**
 * #3836 — sign a message with the connected wallet, waiting for a Safe's
 * other owners when the wallet answers with a proposal.
 *
 * A Safe opened as a Safe App answers a message-signing request with an empty
 * signature (`0x`) while its other owners still have to approve it. Sending
 * that on would be refused, and the request would be dropped. So the signer
 * waits until the approval is complete (the Safe's own EIP-1271 answer on
 * chain, or the combined signature the Safe's service prepares) and returns
 * what the request must carry. The rule is `@vaipakam/lib/accountSignature`,
 * the same one alpha05 uses.
 *
 * The wait ends with {@link WalletMovedWhileWaiting} if the connected wallet
 * or network changes, so nothing is ever sent for another identity; the
 * caller keeps its request so it can be finished later.
 */
import type { Config } from 'wagmi';
import { getAccount, readContract, signMessage } from 'wagmi/actions';
import { hashMessage, type Hex } from 'viem';
import {
  ERC1271_ABI,
  awaitAccountSignature,
  gatewayRead,
  isPendingSignature,
  onChainRead,
  safeMessageUrl,
} from '@vaipakam/lib/accountSignature';

/** The wallet or network changed while a Safe's approval was awaited. */
export class WalletMovedWhileWaiting extends Error {
  constructor() {
    super('The connected wallet or network changed while the approval was awaited.');
    this.name = 'WalletMovedWhileWaiting';
  }
}

/**
 * Signs `message` with the connected wallet and returns what a request must
 * carry. `onAwaiting` is called once if the wallet answered with a proposal,
 * before the wait begins.
 */
export async function signAccountMessage(
  config: Config,
  message: string,
  onAwaiting: () => void,
): Promise<Hex> {
  const at = getAccount(config);
  const signature = await signMessage(config, { message });
  if (!isPendingSignature(signature) || at.connector?.id !== 'safe' || !at.address || at.chainId === undefined) {
    return signature;
  }
  const account = at.address;
  const chainId = at.chainId;
  const hash = hashMessage(message);
  onAwaiting();
  const stillLive = () => {
    const now = getAccount(config);
    if (now.address?.toLowerCase() !== account.toLowerCase() || now.chainId !== chainId) {
      throw new WalletMovedWhileWaiting();
    }
  };
  return awaitAccountSignature(
    [
      onChainRead(() =>
        readContract(config, {
          chainId,
          address: account,
          abi: ERC1271_ABI,
          functionName: 'isValidSignature',
          args: [hash, '0x'],
        }),
      ),
      gatewayRead(() => fetch(safeMessageUrl(chainId, account, hash))),
    ],
    stillLive,
  );
}
