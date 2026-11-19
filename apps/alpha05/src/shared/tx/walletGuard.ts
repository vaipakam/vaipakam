/**
 * #1691 — no wallet prompt opens, no transaction is sent and no pending
 * record is saved for a wallet or network other than the one a review was
 * read for. The check reads the wallet connection as it is at the moment of
 * the call (wagmi's own account state), never the page's last render, so a
 * switch the page has not re-rendered for yet is still caught.
 */
import type { TypedData } from 'viem';
import type { Config } from 'wagmi';
import { getAccount, signMessage, signTypedData, type SignMessageParameters, type SignTypedDataParameters } from 'wagmi/actions';

type Hex = `0x${string}`;

/** The connected wallet and network now, in the review identity's form
 *  (`chainId:account`, lower case), or null when no wallet is connected. */
export function liveIdentity(config: Config): string | null {
  const a = getAccount(config);
  if (a.status !== 'connected' || !a.address || a.chainId === undefined) return null;
  return `${a.chainId}:${a.address.toLowerCase()}`;
}

/** Thrown before a prompt when the wallet or network is not the reviewed one. */
export class WalletMoved extends Error {
  readonly expected: string;
  readonly live: string | null;
  constructor(expected: string, live: string | null) {
    super('The wallet or network changed after this was reviewed, so nothing was sent. Review it again.');
    this.name = 'WalletMoved';
    this.expected = expected;
    this.live = live;
  }
}

/** Refuses unless the live wallet and network are `identity`. */
export function assertLiveIdentity(config: Config, identity: string): void {
  const live = liveIdentity(config);
  if (live !== identity.toLowerCase()) throw new WalletMoved(identity, live);
}

/** The same check for a call that names its account and network. */
export function assertLiveWallet(config: Config, chainId: number, account: Hex): void {
  assertLiveIdentity(config, `${chainId}:${account.toLowerCase()}`);
}

/**
 * The only way this app asks the wallet for a typed-data signature: refused,
 * with no prompt, unless the wallet is `account` on `chainId` now.
 */
export async function signTypedDataFor<const typedData extends TypedData | Record<string, unknown>, primaryType extends keyof typedData | 'EIP712Domain'>(
  config: Config,
  chainId: number,
  parameters: SignTypedDataParameters<typedData, primaryType> & { account: Hex },
): Promise<Hex> {
  assertLiveWallet(config, chainId, parameters.account);
  return signTypedData(config, parameters as SignTypedDataParameters<typedData, primaryType>);
}

/** The same for a plain message signature. */
export async function signMessageFor(config: Config, chainId: number, parameters: SignMessageParameters & { account: Hex }): Promise<Hex> {
  assertLiveWallet(config, chainId, parameters.account);
  return signMessage(config, parameters);
}

/**
 * The start of a tracked send (`useTrackedTx.run`): the live wallet and
 * network are checked first, so a switch since the review opens no prompt
 * and saves no pending record of the flow. Otherwise the flow is recorded
 * (`save`) and sent. Returns the hash, or null when it stopped.
 */
export async function sendReviewed<F extends { identity: string }>(o: {
  frozen: F;
  liveIdentity: () => string | null;
  apply: (e: { type: 'sign' } | { type: 'failed'; message: string }) => void;
  save: (frozen: F) => void;
  send: () => Promise<Hex>;
  failure: (e: unknown) => string;
}): Promise<Hex | null> {
  o.apply({ type: 'sign' });
  if (o.liveIdentity() !== o.frozen.identity.toLowerCase()) {
    o.apply({ type: 'failed', message: o.failure(new WalletMoved(o.frozen.identity, o.liveIdentity())) });
    return null;
  }
  o.save(o.frozen);
  try {
    return await o.send();
  } catch (e) {
    o.apply({ type: 'failed', message: o.failure(e) });
    return null;
  }
}
