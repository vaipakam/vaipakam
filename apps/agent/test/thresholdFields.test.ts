/**
 * #3434 — the app learns from the agent which optional alert-settings
 * fields a signed save carries, so it never offers a choice the agent would
 * rebuild out of the signed message.
 */
import { describe, expect, it } from 'vitest';
import { buildAlertSettingsMessage, ALERT_SETTINGS_OPTIONAL_FIELDS } from '@vaipakam/lib/alertsMessage';
import { callerBudgetFor, handleThresholdFields } from '../src/index';

const ORIGIN = 'https://app.vaipakam.com';

describe('GET /thresholds/fields', () => {
  it('names the vault outflow field, with CORS and no caching', async () => {
    const res = handleThresholdFields(ORIGIN);
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ fields: ['vault-outflow'] });
  });

  it('names only fields the signed message actually carries', () => {
    const wallet = '0x1111111111111111111111111111111111111111';
    expect(ALERT_SETTINGS_OPTIONAL_FIELDS).toContain('vault-outflow');
    expect(buildAlertSettingsMessage(wallet, 84532, { vaultOutflowAlerts: 'on' }, 1)).toContain('Vault outflow');
  });

  it('spends no caller budget', () => {
    expect(callerBudgetFor('GET', '/thresholds/fields')).toBeNull();
  });
});
