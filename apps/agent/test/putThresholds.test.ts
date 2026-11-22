/**
 * PUT /thresholds body parser (#2000) — the bands became optional AS
 * A SET, so the parser now carries three load-bearing rules: absent
 * bands parse (meaning "no band change"), a PARTIAL set never parses
 * (three values are one lane state — splicing one into stored values
 * would build a record no client proposed), and a present-but-
 * malformed band is a bad request rather than silently read as
 * absent.
 */
import { describe, it, expect } from 'vitest';
import { buildAlertSettingsMessage } from '@vaipakam/lib/alertsMessage';
import { parsePutThresholds, settingsChangeOf } from '../src/index';

const WALLET = '0x1DAefA360ED370285f003Fa2d92DB75628088282';
const FULL = {
  wallet: WALLET,
  chain_id: 84532,
  warn_hf: 1.5,
  alert_hf: 1.2,
  critical_hf: 1.05,
};

describe('parsePutThresholds (#2000 optional bands)', () => {
  it('parses a full-band body exactly as before', () => {
    const p = parsePutThresholds(FULL);
    expect(p).not.toBeNull();
    expect(p!.warn_hf).toBe(1.5);
  });

  it('parses a BANDLESS body — absent means "no band change"', () => {
    const p = parsePutThresholds({
      wallet: WALLET,
      chain_id: 84532,
      notify_maturity_approaching: false,
    });
    expect(p).not.toBeNull();
    expect(p!.warn_hf).toBeUndefined();
    expect(p!.alert_hf).toBeUndefined();
    expect(p!.critical_hf).toBeUndefined();
    expect(p!.notify_maturity_approaching).toBe(false);
  });

  it('rejects a PARTIAL band set', () => {
    expect(
      parsePutThresholds({ wallet: WALLET, chain_id: 84532, warn_hf: 1.5 }),
    ).toBeNull();
    expect(
      parsePutThresholds({
        wallet: WALLET,
        chain_id: 84532,
        warn_hf: 1.5,
        alert_hf: 1.2,
      }),
    ).toBeNull();
  });

  it('rejects a malformed band rather than reading it as absent', () => {
    expect(parsePutThresholds({ ...FULL, warn_hf: '1.5' })).toBeNull();
    expect(
      parsePutThresholds({ wallet: WALLET, chain_id: 84532, warn_hf: null }),
    ).toBeNull();
  });

  it('still validates the ordering when the bands are present', () => {
    expect(parsePutThresholds({ ...FULL, warn_hf: 1.1 })).toBeNull();
    expect(parsePutThresholds({ ...FULL, critical_hf: 0.9 })).toBeNull();
  });

  it('still rejects a malformed wallet or chain id', () => {
    expect(parsePutThresholds({ ...FULL, wallet: '0x123' })).toBeNull();
    expect(parsePutThresholds({ ...FULL, chain_id: '84532' })).toBeNull();
  });
});

describe('what a settings save is signed over (#2754)', () => {
  it('names exactly the fields the body carries, and nothing it omits', () => {
    expect(settingsChangeOf(parsePutThresholds(FULL)!)).toEqual({
      bands: { warnHf: 1.5, alertHf: 1.2, criticalHf: 1.05 },
    });
    expect(
      settingsChangeOf(
        parsePutThresholds({
          wallet: WALLET,
          chain_id: 84532,
          notify_maturity_approaching: false,
          push_channel: 'subscribed',
        })!,
      ),
    ).toEqual({ dueDateReminders: false, pushAlerts: true });
    expect(settingsChangeOf(parsePutThresholds({ wallet: WALLET, chain_id: 84532 })!)).toEqual({});
  });

  it('rebuilds the message the app signed from the body the app sent', () => {
    // The app signs buildAlertSettingsMessage over its change and sends
    // the same values in the body; the agent must arrive at the same bytes.
    const change = {
      bands: { warnHf: 1.012, alertHf: 1.011, criticalHf: 1.01 },
      dueDateReminders: true,
    };
    const body = JSON.parse(
      JSON.stringify({
        wallet: WALLET,
        chain_id: 84532,
        warn_hf: change.bands.warnHf,
        alert_hf: change.bands.alertHf,
        critical_hf: change.bands.criticalHf,
        notify_maturity_approaching: true,
      }),
    );
    expect(
      buildAlertSettingsMessage(WALLET, 84532, settingsChangeOf(parsePutThresholds(body)!), 1),
    ).toBe(buildAlertSettingsMessage(WALLET, 84532, change, 1));
  });

  it('refuses a Push value other than the opt-in, and non-finite bands', () => {
    expect(parsePutThresholds({ wallet: WALLET, chain_id: 84532, push_channel: 'x' })).toBeNull();
    expect(parsePutThresholds({ ...FULL, warn_hf: Infinity })).toBeNull();
    expect(parsePutThresholds({ ...FULL, chain_id: 1.5 })).toBeNull();
    expect(parsePutThresholds({ ...FULL, chain_id: 0 })).toBeNull();
  });
});
