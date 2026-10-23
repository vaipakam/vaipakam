/**
 * #2039 / #2035 — how an erasure closes wallet connections. Driven through a
 * plain-value port, so no wagmi config is needed: the rules under test are
 * "never touch a placeholder", "wait for a restore, bounded", and "reload-
 * prone connections go last".
 */
import { describe, expect, it } from 'vitest';
import { ReconnectPendingError } from './dataRights';
import { planWalletTeardown, type WalletPort } from './walletTeardown';

interface FakeConnector {
  id: string;
  live: boolean;
}

function fakePort(init: {
  status: string;
  connectors: FakeConnector[];
  /** What `whenSettled` does: settle into a new state, or time out. */
  settle?: { status: string; connectors: FakeConnector[] } | 'timeout';
}) {
  let status = init.status;
  let connectors = init.connectors;
  const closed: string[] = [];
  const port: WalletPort<FakeConnector> = {
    status: () => status,
    connectors: () => connectors,
    identify: (c) => c.id,
    isLive: (c) => c.live,
    reloadsOnDisconnect: (c) => c.id === 'coinbaseWalletSDK',
    disconnect: async (c) => {
      if (!c.live) throw new TypeError('connector.disconnect is not a function');
      closed.push(c.id);
      connectors = connectors.filter((x) => x !== c);
      if (connectors.length === 0) status = 'disconnected';
    },
    whenSettled: async () => {
      if (init.settle === 'timeout') return false;
      if (init.settle) {
        status = init.settle.status;
        connectors = init.settle.connectors;
      }
      return true;
    },
  };
  /** A connection the user makes while the teardown is under way. */
  const connectMeanwhile = (c: FakeConnector) => {
    connectors = [...connectors, c];
    status = 'connected';
  };
  return { port, closed, connectMeanwhile };
}

describe('planWalletTeardown', () => {
  it('supplies nothing when the connection map is empty', () => {
    for (const status of ['disconnected', 'connecting', 'reconnecting']) {
      const { port } = fakePort({ status, connectors: [] });
      expect(planWalletTeardown(port)).toEqual({});
    }
    const { port } = fakePort({
      status: 'connected',
      connectors: [],
    });
    expect(planWalletTeardown(port)).toEqual({});
  });

  it('waits for a restore and closes the LIVE connector, never the placeholder (#2039)', async () => {
    const live = { id: 'walletConnect', live: true };
    const { port, closed } = fakePort({
      status: 'reconnecting',
      connectors: [{ id: 'walletConnect', live: false }],
      settle: { status: 'connected', connectors: [live] },
    });
    let settledCalls = 0;
    const plan = planWalletTeardown(port, {
      onSettled: () => {
        settledCalls += 1;
      },
    });
    await plan.first!();
    await plan.last!();
    expect(closed).toEqual(['walletConnect']);
    // Once, however many teardowns ask.
    expect(settledCalls).toBe(1);
  });

  it('raises ReconnectPendingError when the restore outlives the wait, closing nothing', async () => {
    const { port, closed } = fakePort({
      status: 'reconnecting',
      connectors: [{ id: 'walletConnect', live: false }],
      settle: 'timeout',
    });
    const plan = planWalletTeardown(port);
    await expect(plan.first!()).rejects.toBeInstanceOf(ReconnectPendingError);
    await expect(plan.last!()).rejects.toBeInstanceOf(ReconnectPendingError);
    expect(closed).toEqual([]);
  });

  it('treats a placeholder still in the map as not settled, whatever the status says', async () => {
    const { port, closed } = fakePort({
      status: 'reconnecting',
      connectors: [{ id: 'walletConnect', live: false }],
      settle: {
        status: 'connected',
        connectors: [{ id: 'walletConnect', live: false }],
      },
    });
    await expect(planWalletTeardown(port).first!()).rejects.toBeInstanceOf(
      ReconnectPendingError,
    );
    expect(closed).toEqual([]);
  });

  it('resolves when a failed restore left nothing to close', async () => {
    const { port, closed } = fakePort({
      status: 'reconnecting',
      connectors: [{ id: 'metaMask', live: false }],
      settle: { status: 'disconnected', connectors: [] },
    });
    const plan = planWalletTeardown(port);
    // Neither teardown claims a sign-out it did not make (Codex #2670 r3).
    await expect(plan.first!()).resolves.toBe(false);
    await expect(plan.last!()).resolves.toBe(false);
    expect(closed).toEqual([]);
  });

  it('closes a live wallet while another connection is still being made (Codex #2670 r3)', async () => {
    // wagmi reports `connecting` and keeps the existing connections while a
    // further wallet is being connected.
    const { port, closed } = fakePort({
      status: 'connecting',
      connectors: [{ id: 'metaMask', live: true }],
    });
    const plan = planWalletTeardown(port);
    await expect(plan.first!()).resolves.toBe(true);
    expect(closed).toEqual(['metaMask']);
  });

  it('never closes a connection made after the request settled (Codex #2670 r3)', async () => {
    const metaMask = { id: 'metaMask', live: true };
    const { port, closed, connectMeanwhile } = fakePort({
      status: 'connected',
      connectors: [metaMask],
    });
    const plan = planWalletTeardown(port);
    await expect(plan.first!()).resolves.toBe(true);
    // While the erasure clears, the user connects Coinbase from the header.
    connectMeanwhile({ id: 'coinbaseWalletSDK', live: true });
    let before = false;
    await expect(
      plan.last!(() => {
        before = true;
      }),
    ).resolves.toBe(false);
    expect(before).toBe(false);
    expect(closed).toEqual(['metaMask']);
  });

  it('never closes a wallet connected while the restore was settling (Codex #2670 r6)', async () => {
    const restored = { id: 'walletConnect', live: true };
    const meanwhile = { id: 'metaMask', live: true };
    const { port, closed } = fakePort({
      status: 'reconnecting',
      connectors: [{ id: 'walletConnect', live: false }],
      // The restore installs the session being erased, and the user connects
      // a second wallet before it settles.
      settle: { status: 'connected', connectors: [restored, meanwhile] },
    });
    const plan = planWalletTeardown(port);
    await expect(plan.first!()).resolves.toBe(true);
    await expect(plan.last!()).resolves.toBe(false);
    expect(closed).toEqual(['walletConnect']);
    expect(port.connectors()).toEqual([meanwhile]);
  });

  it('closes reload-prone connections only in the LAST teardown (#2035)', async () => {
    const { port, closed } = fakePort({
      status: 'connected',
      connectors: [
        { id: 'coinbaseWalletSDK', live: true },
        { id: 'metaMask', live: true },
      ],
    });
    const plan = planWalletTeardown(port);
    await expect(plan.first!()).resolves.toBe(true);
    expect(closed).toEqual(['metaMask']);
    const before: string[] = [];
    await expect(plan.last!(() => before.push([...closed].join(',')))).resolves.toBe(
      true,
    );
    // `beforeClosing` ran before the reload-prone connector was asked.
    expect(before).toEqual(['metaMask']);
    expect(closed).toEqual(['metaMask', 'coinbaseWalletSDK']);
  });

  it('calls beforeClosing only when there is a reload-prone connection', async () => {
    const { port } = fakePort({
      status: 'connected',
      connectors: [{ id: 'metaMask', live: true }],
    });
    const plan = planWalletTeardown(port);
    await plan.first!();
    let called = false;
    await expect(
      plan.last!(() => {
        called = true;
      }),
    ).resolves.toBe(false);
    expect(called).toBe(false);
  });
});
