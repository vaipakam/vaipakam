/**
 * The alert seam's Push half (#2248): the keeper sends through the shared
 * `@vaipakam/push` rail, and since that rail is silent when it cannot send at
 * all, the pass says so ONCE, with the rail's reason and a count, instead of
 * once per subscriber.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AlertDelivery, pushRailConfigOf } from '../src/alertDelivery';
import type { ChainConfig, Env } from '../src/env';
import { disarmEpochFence } from '../src/epochFence';
import { armHeldFence } from './helpers/epochFence';

const CHAIN = { id: 84532, diamond: '0x' + 'd'.repeat(40) } as unknown as ChainConfig;
const alert = (subscriber: string | null) => ({
  tgChatId: null,
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
