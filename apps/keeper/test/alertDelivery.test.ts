/**
 * The alert seam's Push half (#2248): the keeper sends through the shared
 * `@vaipakam/push` rail, and since that rail is silent when it cannot send at
 * all, the pass says so ONCE, with the rail's reason and a count, instead of
 * once per subscriber.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generatePrivateKey } from 'viem/accounts';
import { readPublishedRail, type PublishedRailRow } from '@vaipakam/push';
import { AlertDelivery, publishRailStatus, pushRailConfigOf, type Alert } from '../src/alertDelivery';
import { AgentDiamondMismatch, AgentRequestFailed, type AgentClient } from '../src/agentClient';
import type { AddressedAlert } from '@vaipakam/lib/telegramAlerts/message';
import type { ChainConfig, Env } from '../src/env';
import { disarmEpochFence } from '../src/epochFence';
import { armHeldFence } from './helpers/epochFence';
import { createSharedD1 } from './helpers/schemas';
import { createSqliteD1 } from './helpers/sqliteD1';

const CHAIN = { id: 84532, diamond: '0x' + 'd'.repeat(40) } as unknown as ChainConfig;
const alert = (subscriber: string | null) => ({
  pushSubscriber: subscriber,
  text: 'hi',
  pushTitle: 't',
  deepLinkUrl: '',
});

afterEach(() => {
  vi.restoreAllMocks();
  disarmEpochFence();
});

describe('AlertDelivery — Push through the shared rail', () => {
  it('reads both Push settings from the env in one place', () => {
    expect(pushRailConfigOf({ PUSH_CHANNEL_PK: 'k', PUSH_CHANNEL_ADDRESS: '0xabc' } as Env)).toEqual({
      channelPk: 'k',
      channelAddress: '0xabc',
    });
  });

  it('discloses an unusable rail once per pass, with its reason and a count', async () => {
    armHeldFence([CHAIN]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const alerts = new AlertDelivery({ PUSH_CHANNEL_PK: undefined } as unknown as Env);
    await alerts.deliver(alert('0x' + '1'.repeat(40)));
    await alerts.deliver(alert('0x' + '2'.repeat(40)));
    await alerts.deliver(alert(null)); // no Push subscription: not counted
    expect(warn).not.toHaveBeenCalled();
    alerts.disclose('watcher');
    expect(warn.mock.calls.map((c) => c[0])).toEqual([
      '[watcher] Push rail unavailable (signer-unset): 2 alert(s) not sent by Push this pass',
    ]);
  });

  it('names a malformed channel setting as the reason', async () => {
    armHeldFence([CHAIN]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const alerts = new AlertDelivery({
      PUSH_CHANNEL_PK: '0x' + '11'.repeat(32),
      PUSH_CHANNEL_ADDRESS: 'not-an-address',
    } as unknown as Env);
    await alerts.deliver(alert('0x' + '1'.repeat(40)));
    alerts.disclose('preGraceWatcher');
    expect(warn.mock.calls.map((c) => c[0])).toEqual([
      '[preGraceWatcher] Push rail unavailable (channel-malformed): 1 alert(s) not sent by Push this pass',
    ]);
  });

  it('prints nothing for a pass with no Push alerts', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    new AlertDelivery({} as unknown as Env).disclose('watcher');
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('AlertDelivery — Telegram through the agent (#1722)', () => {
  const WALLET = '0x' + 'a'.repeat(40);
  const message: AddressedAlert = { chainId: 84532, wallet: WALLET, alert: { kind: 'hf', band: 'alert', loanId: 7, hf: 1.2 } };
  const tgAlert: Alert = { telegram: { diamond: CHAIN.diamond as string, message }, text: 'push body', pushTitle: 't', deepLinkUrl: '' };
  const agentWith = (send: AgentClient['sendAlerts']): AgentClient & { sent: unknown[][] } => {
    const sent: unknown[][] = [];
    return {
      sent,
      lockPoll: async () => [],
      lockPending: async () => [],
      lockHandled: async () => ({ recorded: true, telegram: 'off' }),
      sendAlerts: async (...args) => {
        sent.push(args);
        return send(...args);
      },
    };
  };

  it('posts the alert as data, with the chain and the Diamond, and returns what the agent did', async () => {
    armHeldFence([CHAIN]);
    const agent = agentWith(async () => ['sent']);
    const out = await new AlertDelivery({} as unknown as Env, agent).deliver(tgAlert);
    expect(out).toEqual({ telegram: 'sent', push: 'off' });
    expect(agent.sent).toEqual([[84532, CHAIN.diamond, [message]]]);
  });

  it('reads an unlinked wallet (the agent answers off) as no channel', async () => {
    armHeldFence([CHAIN]);
    const out = await new AlertDelivery({} as unknown as Env, agentWith(async () => ['off'])).deliver(tgAlert);
    expect(out.telegram).toBe('off');
  });

  it('with no agent configured sends nothing on Telegram and says so once, with the reason', async () => {
    armHeldFence([CHAIN]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const alerts = new AlertDelivery({ KEEPER_AGENT_TOKEN: 'tok' } as unknown as Env);
    expect((await alerts.deliver(tgAlert)).telegram).toBe('off');
    expect((await alerts.deliver(tgAlert)).telegram).toBe('off');
    alerts.disclose('watcher');
    expect(warn.mock.calls.map((c) => c[0])).toEqual(['[watcher] Telegram unavailable (AGENT_ORIGIN is unset): 2 alert(s) not sent by Telegram this pass']);
  });

  it('reads a refusal that will repeat as refused, and anything else as worth another try', async () => {
    armHeldFence([CHAIN]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const permanent = new AlertDelivery({} as unknown as Env, agentWith(async () => { throw new AgentRequestFailed('/keeper/alerts', 401, 'unauthorized'); }));
    expect((await permanent.deliver(tgAlert)).telegram).toBe('refused');
    const passing = new AlertDelivery({} as unknown as Env, agentWith(async () => { throw new AgentRequestFailed('/keeper/alerts', 0, 'TimeoutError'); }));
    expect((await passing.deliver(tgAlert)).telegram).toBe('retry');
    const limited = new AlertDelivery({} as unknown as Env, agentWith(async () => { throw new AgentRequestFailed('/keeper/alerts', 429, 'slow down'); }));
    expect((await limited.deliver(tgAlert)).telegram).toBe('retry');
    permanent.disclose('watcher');
    expect(String(warn.mock.calls[0][0])).toMatch(/^\[watcher\] 1 Telegram alert\(s\) not taken by the agent this pass \(last: .*answered 401/);
  });

  it('throws when the agent serves another Diamond, like the epoch fence', async () => {
    armHeldFence([CHAIN]);
    const alerts = new AlertDelivery({} as unknown as Env, agentWith(async () => { throw new AgentDiamondMismatch(84532, '0x' + 'e'.repeat(40)); }));
    await expect(alerts.deliver(tgAlert)).rejects.toBeInstanceOf(AgentDiamondMismatch);
  });
});

describe('the keeper publishes its Push rail status for the agent (#2667)', () => {
  const CHANNEL = '0x6F5847A0CA1F2cB1bbEf944124cE5995988a1D6b';
  const rowOf = (h: ReturnType<typeof createSharedD1>) =>
    h.db.prepare(`SELECT sender, usable, reason, channel, observed_at FROM push_rail_status`).all();

  it('writes one row, replaced on each run, in the encoding the agent reads back', async () => {
    const shared = createSharedD1();
    const DB = shared.d1 as Env['DB'];
    await publishRailStatus({ DB, PUSH_CHANNEL_PK: undefined, PUSH_CHANNEL_ADDRESS: undefined }, 100);
    expect(rowOf(shared)).toEqual([{ sender: 'keeper', usable: 0, reason: 'signer-unset', channel: null, observed_at: 100 }]);
    const key = generatePrivateKey();
    await publishRailStatus({ DB, PUSH_CHANNEL_PK: key, PUSH_CHANNEL_ADDRESS: CHANNEL }, 160);
    const rows = rowOf(shared) as unknown as PublishedRailRow[];
    expect(rows).toEqual([{ sender: 'keeper', usable: 1, reason: null, channel: CHANNEL, observed_at: 160 }]);
    expect(readPublishedRail(rows[0])).toEqual({ status: { usable: true, channel: CHANNEL }, observedAt: 160 });
    expect(JSON.stringify(rows)).not.toContain(key.slice(2, 18));
  });

  it('logs and carries on when the write fails, as on a database the migration has not reached', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bare = createSqliteD1([]);
    await expect(publishRailStatus({ DB: bare.d1 as Env['DB'] }, 1)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Push rail status not published this run'));
  });
});
