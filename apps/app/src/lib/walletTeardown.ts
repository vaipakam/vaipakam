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
 * 3. CLOSE ONLY THE REQUEST'S CONNECTIONS, AND SAY WHETHER ANY WERE CLOSED
 *    (Codex #2670 r3, r6). The targets are the connections the map held AT
 *    THE REQUEST — with a placeholder that was restoring then standing for
 *    the live connection its restore installed — and nothing connected
 *    afterwards, during the restore wait included: the erasure runs for
 *    seconds with the Connect control live, and a session the user creates in
 *    that time is theirs, not the request's. And each teardown resolves
 *    whether it closed anything, so a teardown that found nothing left is
 *    never reported as a sign-out.
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
  /**
   * Which wallet a connector is, the same for a restoring placeholder and the
   * live connection its restore installs (wagmi's connector `id`). A
   * connection map holds at most one connection per identity.
   */
  readonly identify: (connector: C) => string;
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
  /**
   * Closes every connection that does not reload the page. Resolves `true`
   * if it closed any, `false` if there were none to close.
   */
  readonly first?: () => Promise<boolean>;
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
 * Decided by the CONNECTION MAP, not the status (Codex #2670 r3). Supplies
 * NOTHING when the map is empty (#1862 Part 2 round 2 P2): a teardown
 * resolving over nothing would be reported as a sign-out that never
 * happened. The status cannot stand in for that: `connecting` is the state of
 * an open wallet modal (round 8), but wagmi keeps the existing connections
 * while a further one is being made, so a status gate left a live wallet
 * attached through an erasure. A connection still being MADE cannot be
 * stopped; completing it is a sign-in after the request, which the erasure's
 * late cleanups already decline to undo.
 *
 * The targets are FROZEN HERE, to the wallets the map held when the plan was
 * made (rule 3 in the header; Codex #2670 r6). A placeholder restoring then
 * stands for the live connection its restore installs, matched by identity,
 * because that live connection is the very session being erased; a wallet of
 * any OTHER identity that appears while the restore settles was connected
 * after the request and is left alone. One that a failed reconnect dropped is
 * no longer asked to close. The settle starts HERE too, not when a teardown
 * first runs (Codex #2670 r4): a caller may hold a plan while it waits its
 * turn, and the request is what the map held when it was made, not when the
 * turn came. Each teardown closes
 * those of its targets still in the map when it runs, and resolves `false`
 * when there are none: the session that was being restored at the request
 * is gone either way, and the erasure removed what would have restored it,
 * but no wallet was signed out and the report must not say one was.
 */
export function planWalletTeardown<C>(
  port: WalletPort<C>,
  options: WalletTeardownOptions = {},
): WalletTeardownPlan {
  const atRequest = port.connectors();
  if (atRequest.length === 0) return {};
  const requested = new Set(atRequest.map((connector) => port.identify(connector)));
  const request = port
    .whenSettled(options.settleTimeoutMs ?? RECONNECT_SETTLE_TIMEOUT_MS)
    .then(() => {
      // The status is re-read rather than trusting the boolean, and the map
      // is checked as well: a placeholder still in it means the reconnect has
      // not replaced it, whatever the status says.
      const connected = port.connectors();
      if (
        port.status() === 'reconnecting' ||
        connected.some((connector) => !port.isLive(connector))
      ) {
        throw new ReconnectPendingError();
      }
      options.onSettled?.();
      return connected.filter((connector) =>
        requested.has(port.identify(connector)),
      );
    });
  // Each teardown awaits it and meets the error there; this only keeps a
  // plan nobody runs from surfacing an unhandled rejection.
  request.catch(() => {});
  const settle = () => request;
  const close = (targets: readonly C[]) =>
    disconnectEvery(targets, ({ connector }) => port.disconnect(connector), {
      onStragglerSettled: options.onStragglerSettled,
      perConnectorTimeoutMs: options.perConnectorTimeoutMs,
    })();
  // The request's connections of one kind that are still connected now.
  const group = (request: readonly C[], reloads: boolean) => {
    const now = new Set(port.connectors());
    return request.filter(
      (connector) =>
        now.has(connector) && port.reloadsOnDisconnect(connector) === reloads,
    );
  };
  return {
    first: async () => {
      const targets = group(await settle(), false);
      if (targets.length === 0) return false;
      await close(targets);
      return true;
    },
    last: async (beforeClosing) => {
      const targets = group(await settle(), true);
      if (targets.length === 0) return false;
      beforeClosing?.();
      await close(targets);
      return true;
    },
  };
}
