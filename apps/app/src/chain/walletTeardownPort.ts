/**
 * The wagmi side of the erasure's wallet teardown (#2039, #2035).
 *
 * `lib/walletTeardown.ts` holds the rules and knows nothing about wagmi; this
 * builds the port it reads from the app's wagmi config. Everything is read
 * from the config AT CALL TIME and disconnects go through `@wagmi/core`'s
 * action rather than a React hook, so a teardown keeps working after the page
 * that started it has been remounted — which is what happens on every
 * erasure in a non-English locale (#2038).
 */
import type { Config, Connector } from 'wagmi';
import { disconnect } from 'wagmi/actions';
import type { WalletPort } from '../lib/walletTeardown';

/**
 * The connector ids whose disconnect reloads the page.
 *
 * `coinbaseWalletSDK` — `@coinbase/wallet-sdk@4.3.6`'s WalletLink signer (the
 * Coinbase Wallet mobile / QR path that `coinbaseWallet({ preference:
 * { options: 'all' } })` in `chain/wagmi.ts` can select) ends its `cleanup()`
 * in `WalletLinkRelay.resetAndReload`, which calls
 * `document.location.reload()` once the relay connection is destroyed. The
 * same connector can also be backed by the extension, which does not reload;
 * it cannot be told apart from here, so the whole connector is treated as
 * reload-prone. Closing it last costs the extension case nothing.
 */
export const RELOADS_ON_DISCONNECT: ReadonlySet<string> = new Set([
  'coinbaseWalletSDK',
]);

export function wagmiWalletPort(config: Config): WalletPort<Connector> {
  return {
    status: () => config.state.status,
    connectors: () =>
      [...config.state.connections.values()].map(
        (connection) => connection.connector,
      ),
    // A hydrated placeholder carries the id of the connector `reconnect()`
    // replaces it with; the uid is not stable across that replacement.
    identify: (connector) => connector.id,
    // A persisted record restored by `hydrate` is the serialized connector —
    // id, name, type, uid — with no methods. A live one has `disconnect`.
    isLive: (connector) =>
      typeof (connector as { disconnect?: unknown }).disconnect === 'function',
    reloadsOnDisconnect: (connector) => RELOADS_ON_DISCONNECT.has(connector.id),
    disconnect: (connector) => disconnect(config, { connector }),
    whenSettled: (timeoutMs) =>
      new Promise<boolean>((resolve) => {
        if (config.state.status !== 'reconnecting') {
          resolve(true);
          return;
        }
        let unsubscribe = () => {};
        const timer = setTimeout(() => {
          unsubscribe();
          resolve(false);
        }, timeoutMs);
        unsubscribe = config.subscribe(
          (state) => state.status,
          (status) => {
            if (status === 'reconnecting') return;
            clearTimeout(timer);
            unsubscribe();
            resolve(true);
          },
        );
      }),
  };
}
