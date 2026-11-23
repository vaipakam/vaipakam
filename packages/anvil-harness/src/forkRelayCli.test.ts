/**
 * The rehearsal's relay command (#3892 wiring): how it names each fork, where
 * each fork's selector and router come from, and the report section it
 * writes. The relay itself is held by `forkRelay.test.ts` and the stand-in's
 * forge suite; the driver's use of the command by `contracts/script/rehearse.test.sh`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FORK_RELAY_LIMITS, ForkCcipRelay, type ForkRelayedMessage, type SavedForkRelay } from './forkRelay';
import { forkEnd, main, parseForkArg, reportSection, type KnownChain } from './forkRelayCli';

const CHAINS: Record<string, KnownChain> = {
  'base-sepolia': { chainId: 84532, prefix: 'BASE_SEPOLIA', ccipSelector: '10344971235874465080' },
  'arb-sepolia': { chainId: 421614, prefix: 'ARB_SEPOLIA', ccipSelector: '3478487238524512106' },
};
const ROUTER = '0x00000000000000000000000000000000000000a0';

describe('parseForkArg', () => {
  it('reads <slug>=<url>@<forkBlock>', () => {
    expect(parseForkArg('base-sepolia=http://127.0.0.1:8545@123')).toEqual({ name: 'base-sepolia', url: 'http://127.0.0.1:8545', forkBlock: 123n });
  });
  it('refuses anything else', () => {
    expect(() => parseForkArg('base-sepolia=http://127.0.0.1:8545')).toThrow(/not <slug>=<url>@<forkBlock>/);
    expect(() => parseForkArg('Base=http://127.0.0.1:8545@1')).toThrow(/not <slug>/);
  });
  it('refuses a fork that is not on this machine', () => {
    expect(() => parseForkArg('base-sepolia=https://sepolia.base.org@1')).toThrow(/local node/);
  });
});

describe('forkEnd', () => {
  const env = { CCIP_ROUTER_BASE_SEPOLIA: ROUTER };
  const fork = { name: 'base-sepolia', url: 'http://127.0.0.1:1', forkBlock: 100n };

  it('takes the selector from the deploy scripts, the router from the environment, and reads after the fork point', () => {
    expect(forkEnd(fork, 84532, CHAINS, env)).toEqual({
      name: 'base-sepolia',
      url: 'http://127.0.0.1:1',
      chainId: 84532,
      chainSelector: '10344971235874465080',
      router: ROUTER,
      fromBlock: 101n,
    });
  });
  it('refuses a fork that answers another chain id', () => {
    expect(() => forkEnd(fork, 421614, CHAINS, env)).toThrow(/answers chain id 421614, not 84532/);
  });
  it('refuses a chain the deploy scripts do not know', () => {
    expect(() => forkEnd({ ...fork, name: 'mars' }, 84532, CHAINS, env)).toThrow(/not a chain the deploy scripts know/);
  });
  it('refuses a missing or malformed router', () => {
    expect(() => forkEnd(fork, 84532, CHAINS, {})).toThrow(/CCIP_ROUTER_BASE_SEPOLIA/);
    expect(() => forkEnd(fork, 84532, CHAINS, { CCIP_ROUTER_BASE_SEPOLIA: '0x12' })).toThrow(/CCIP_ROUTER_BASE_SEPOLIA/);
  });
  it('matches the deploy scripts’ own chain list', async () => {
    const plan = new URL('../../../contracts/script/deploy-plan.mjs', import.meta.url).href;
    const mod = (await import(/* @vite-ignore */ plan)) as { CHAINS: Record<string, KnownChain> };
    for (const slug of Object.keys(CHAINS)) {
      expect(mod.CHAINS[slug]).toMatchObject(CHAINS[slug]);
    }
  });
});

describe('reportSection', () => {
  const saved: SavedForkRelay = {
    relayerKey: `0x${'11'.repeat(32)}`,
    ends: [],
    lanes: [
      { from: 'base-sepolia', to: 'arb-sepolia', onRamp: '0x00000000000000000000000000000000000000a1', offRamp: '0x00000000000000000000000000000000000000b1', otherOffRamps: [] },
      {
        from: 'arb-sepolia',
        to: 'base-sepolia',
        onRamp: '0x00000000000000000000000000000000000000a2',
        offRamp: '0x00000000000000000000000000000000000000b2',
        otherOffRamps: [{ address: '0x00000000000000000000000000000000000000c2', version: 'OffRamp 1.6.0' }],
      },
    ],
  };

  it('lists every lane, every delivered message and what is not rehearsed, never the key', () => {
    const row = JSON.stringify({ messageId: '0xm1', from: 'base-sepolia', to: 'arb-sepolia', fee: '42', feeToken: '0xfe', gasLimit: '200000', gasUsed: '51234', receiverCalled: true, sourceTx: '0xs', destinationTx: '0xd' });
    const out = reportSection(saved, [row, '']);
    expect(out).toContain('| base-sepolia → arb-sepolia | 0x00000000000000000000000000000000000000a1 | 0x00000000000000000000000000000000000000b1 | none |');
    expect(out).toContain('0x00000000000000000000000000000000000000c2 (OffRamp 1.6.0)');
    expect(out).toContain('| 0xm1 | base-sepolia → arb-sepolia | 42 (0xfe) | 200000 | 51234 | yes | 0xs | 0xd |');
    for (const limit of FORK_RELAY_LIMITS) expect(out).toContain(`- ${limit}`);
    expect(out).not.toContain('11'.repeat(32));
  });
  it('says so when nothing was delivered', () => {
    expect(reportSection(saved, [])).toContain('No message was delivered.');
  });
});

describe('main', () => {
  it('needs a run folder', async () => {
    await expect(main(['report'])).rejects.toThrow(/--state is required/);
  });
  it('refuses a step before the relay is installed', async () => {
    await expect(main(['deliver', '--state', '/nonexistent/relay', 'base-sepolia', 'arb-sepolia'])).rejects.toThrow(/no relay installed for this run/);
  });
  it('refuses an unknown command', async () => {
    await expect(main(['launch', '--state', '/tmp/x'])).rejects.toThrow(/unknown command "launch"/);
  });
  it('records each delivery as it lands, so a later failure never hides it', async () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-cli-'));
    const saved: SavedForkRelay = {
      relayerKey: `0x${'22'.repeat(32)}`,
      ends: [
        { name: 'base-sepolia', url: 'http://127.0.0.1:1', chainId: 84532, chainSelector: '1', router: ROUTER, fromBlock: '1' },
        { name: 'arb-sepolia', url: 'http://127.0.0.1:2', chainId: 421614, chainSelector: '2', router: ROUTER, fromBlock: '1' },
      ],
      lanes: [],
    };
    fs.writeFileSync(path.join(state, 'relay.json'), JSON.stringify(saved));
    const first = { messageId: '0xm1', from: 'base-sepolia', to: 'arb-sepolia', fee: 1n, gasLimit: 2n, gasUsed: 3n, destinationTx: '0xd1' } as unknown as ForkRelayedMessage;
    const spy = vi.spyOn(ForkCcipRelay, 'attach').mockResolvedValue({
      deliver: async (_f: number, _t: number, onDelivered?: (m: ForkRelayedMessage) => void) => {
        onDelivered?.(first);
        throw new Error('relay: the second message reverted');
      },
    } as unknown as ForkCcipRelay);
    try {
      await expect(main(['deliver', '--state', state, 'base-sepolia', 'arb-sepolia'])).rejects.toThrow(/second message reverted/);
      const rows = fs.readFileSync(path.join(state, 'messages.jsonl'), 'utf8').trim().split('\n');
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0])).toMatchObject({ messageId: '0xm1', fee: '1', gasUsed: '3' });
    } finally {
      spy.mockRestore();
      fs.rmSync(state, { recursive: true, force: true });
    }
  });
});
