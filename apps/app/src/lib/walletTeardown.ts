/**
 * How an erasure closes the wallet connections (#2039, #2035).
 *
 * Kept free of wagmi, like the rest of the data-rights library: the wallet is
 * reached through a small structural port (`WalletPort`), which the app
 * builds from its wagmi config in `chain/walletTeardownPort.ts` and a test
 * builds from plain values. The two rules that make a teardown trustworthy
 * live here, where a test can reach them:
 *
 * 1. WAIT FOR A RECONNECT, BOUNDED, AND NEVER TOUCH A PLACEHOLDER (#2039).
 *    While a persisted session is restoring, the connection map holds
 *    method-less records and `reconnect()` is free to install the real
 *    connection afterwards — there is no cancel. Closing the placeholder
 *    stops nothing. So the teardown waits for the reconnect to settle and
 *    closes whatever is then live; if the bound passes first it raises
 *    `ReconnectPendingError`, and the page says the wallet could not be
 *    closed YET rather than that it refused.
 * 2. RELOAD-PRONE CONNECTIONS GO LAST (#2035). A connection whose disconnect
 *    reloads the page is closed by a separate teardown, which the erasure
 *    runs only after everything it counts has been cleared.
 */
import { ReconnectPendingError, disconnectEvery } from './dataRights';

/**
 * How long to wait for a restoring session to settle before saying the
 * wallet could not be closed yet.
 *
 * Inside the whole-teardown bound (`DISCONNECT_TIMEOUT_MS`), so a settled
 * reconnect still leaves time to close what it installed. Longer than an
 * injected wallet takes to restore, shorter than a user will sit through.
 */
export const RECONNECT_SETTLE_TIMEOUT_MS = 5_000;

/** The wallet as the erasure needs to see it. `C` is a connector. */
export interface WalletPort<C> {
  /** The connection status now: `connected`, `reconnecting`, … */
  readonly status: () => string;
  /** The connectors in the connection map now — live or placeholder. */
  readonly connectors: () => readonly C[];
  /** False for a persisted record that `reconnect()` has not replaced yet. */
  readonly isLive: (connector: C) => boolean;
  /** True for a connection whose disconnect reloads the page. */
  readonly reloadsOnDisconnect: (connector: C) => boolean;
  readonly disconnect: (connector: C) => Promise<unknown>;
  /**
   * Resolves `true` once the status has left `reconnecting`, or `false` if
   * `timeoutMs` passes first. Resolves at once when not reconnecting.
   */
  readonly whenSettled: (timeoutMs: number) => Promise<boolean>;
}

export interface WalletTeardownOptions {
  /** See `DisconnectEveryOptions.onStragglerSettled`. */
  readonly onStragglerSettled?: () => void;
  /**
   * Called once, when the reconnect has settled and before anything is
   * closed. The erasure re-takes its connection mark here: a reconnect
   * completing during the wait installs the very session being erased, and
   * must not read as a session that postdates the request.
   */
  readonly onSettled?: () => void;
  readonly perConnectorTimeoutMs?: number;
  readonly settleTimeoutMs?: number;
}

export interface WalletTeardownPlan {
  /** Closes every connection that does not reload the page. */
  readonly first?: () => Promise<void>;
  /**
   * Closes the connections that reload the page, calling `beforeClosing`
   * first ONLY when there is one to close. Resolves `true` if it closed
   * any, `false` if there were none.
   */
  readonly last?: (beforeClosing?: () => void) => Promise<boolean>;
}

/**
 * Plan the teardown at the moment of the request.
 *
 * Supplies NOTHING when nothing is connected or restoring (#1862 Part 2
 * round 2 P2): a teardown resolving over nothing would be reported as a
 * sign-out that never happened. `connecting` is excluded for the same reason
 * (round 8): it is the state with a wallet modal open and an empty map.
 *
 * Both teardowns re-read the map when they run, after the settle, so a
 * connection the render did not have yet is still closed — and one that a
 * failed reconnect dropped is no longer asked to close. A planned teardown
 * that finds nothing left to close resolves: the session that was being
 * restored at the request is gone either way, and the erasure removed what
 * would have restored it.
 */
export function planWalletTeardown<C>(
  port: WalletPort<C>,
  options: WalletTeardownOptions = {},
): WalletTeardownPlan {
  const status = port.status();
  if (
    (status !== 'connected' && status !== 'reconnecting') ||
    port.connectors().length === 0
  ) {
    return {};
  }
  let settled: Promise<void> | undefined;
  const settle = () => {
    settled ??= port
      .whenSettled(options.settleTimeoutMs ?? RECONNECT_SETTLE_TIMEOUT_MS)
      .then(() => {
        // The status is re-read rather than trusting the boolean, and the
        // map is checked as well: a placeholder still in it means the
        // reconnect has not replaced it, whatever the status says.
        if (
          port.status() === 'reconnecting' ||
          port.connectors().some((connector) => !port.isLive(connector))
        ) {
          throw new ReconnectPendingError();
        }
        options.onSettled?.();
      });
    return settled;
  };
  const close = (targets: readonly C[]) =>
    disconnectEvery(targets, ({ connector }) => port.disconnect(connector), {
      onStragglerSettled: options.onStragglerSettled,
      perConnectorTimeoutMs: options.perConnectorTimeoutMs,
    })();
  const group = (reloads: boolean) =>
    port
      .connectors()
      .filter((connector) => port.reloadsOnDisconnect(connector) === reloads);
  return {
    first: async () => {
      await settle();
      const targets = group(false);
      if (targets.length > 0) await close(targets);
    },
    last: async (beforeClosing) => {
      await settle();
      const targets = group(true);
      if (targets.length === 0) return false;
      beforeClosing?.();
      await close(targets);
      return true;
    },
  };
}
