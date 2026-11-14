/**
 * RW-76 — every setting the readers publish has a group, a format and a
 * label; every switch has a name and an effect; and values are written by
 * name, with "unset" or "off" where a zero means none set.
 */
import { describe, expect, it } from 'vitest';
import { LABELLED_KNOB_KEYS, PRICE_GUARD_KNOB_GETTERS, PROTOCOL_KNOB_GETTERS } from '@vaipakam/lib/protocolKnobs';
import { copyEntry } from '../copy/useCopy';
import { BUNDLE_KEYS } from './direct';
import { BUNDLE_SETTING_KEYS, SETTINGS, settingLabel, writeValue } from './catalogue';
import { SWITCHES, switchEffect, switchName, switchState } from './switches';

const w = {
  text: (k: string) => copyEntry(k as never).text,
  format: (k: string, v: Readonly<Record<string, string>>) => copyEntry(k as never).text.replace(/\{\{(\w+)\}\}/g, (_, n: string) => v[n] ?? ''),
};

describe('catalogue', () => {
  it('lists the settings bundle exactly as this build’s ABI names it', () => {
    expect([...BUNDLE_SETTING_KEYS]).toEqual([...BUNDLE_KEYS]);
  });
  it('covers every published setting, and nothing else', () => {
    const published = [
      ...BUNDLE_SETTING_KEYS,
      ...PROTOCOL_KNOB_GETTERS.map((k) => k.key),
      ...PRICE_GUARD_KNOB_GETTERS.map((k) => k.key),
      ...LABELLED_KNOB_KEYS,
    ];
    expect(Object.keys(SETTINGS).sort()).toEqual([...new Set(published)].sort());
  });
  it('labels every setting from the copy catalog', () => {
    for (const key of Object.keys(SETTINGS)) expect(copyEntry(settingLabel(key as never)).text.length).toBeGreaterThan(0);
  });
  it('names every switch and what it blocks', () => {
    for (const sw of SWITCHES) {
      expect(copyEntry(switchName(sw)).text.length).toBeGreaterThan(0);
      expect(copyEntry(switchEffect(sw)).text.length).toBeGreaterThan(0);
      if (sw.setting) expect(SETTINGS[sw.setting].format).toBe('switch');
    }
  });
  it('names no third-party provider in a label', () => {
    for (const key of Object.keys(SETTINGS))
      expect(copyEntry(settingLabel(key as never)).text).not.toMatch(/pyth|pancake|sushi|uniswap|chainlink|redstone|tellor/i);
  });
});

describe('writeValue', () => {
  it('writes rates, spans, amounts and health factors', () => {
    expect(writeValue('treasuryFeeBps', '200', w)).toBe('2%');
    expect(writeValue('autoPauseDurationSeconds', '1800', w)).toBe('30 min (1,800 seconds)');
    expect(writeValue('maxOfferDurationDays', '365', w)).toBe('365 days');
    expect(writeValue('minHealthFactor', '1500000000000000000', w)).toBe('1.5');
    expect(writeValue('partialLiqTargetHfCeilingBps', '12000', w)).toBe('1.2');
    expect(writeValue('minIntentFillNumeraire', '100000000000000000000', w)).toBe('100 numeraire units');
    expect(writeValue('notificationFeeVpfi', '500000000000000000', w)).toBe('0.5 VPFI');
    expect(writeValue('tierThresholds', ['100000000000000000000', '1000000000000000000000'], w)).toBe('100 VPFI, 1,000 VPFI');
    expect(writeValue('tierDiscountBps', ['1000', '2400'], w)).toBe('10%, 24%');
  });
  it('never writes 0 for a value whose zero means none set', () => {
    expect(writeValue('partialLiqDustFloorNumeraire', '0', w)).toBe('Off');
    expect(writeValue('rateModel', '0x0000000000000000000000000000000000000000', w)).toBe('Unset');
    expect(writeValue('numeraireSymbol', `0x${'0'.repeat(64)}`, w)).toBe('Unset');
    expect(writeValue('pythCrossCheckFeedId', `0x${'0'.repeat(64)}`, w)).toBe('Unset');
    expect(writeValue('autoPauseAvailableAt', '0', w)).toBe('Never: no automatic pause has frozen the protocol');
    expect(writeValue('graceBuckets', [], w)).toBe('None set: the built-in schedule applies (default)');
  });
  it('writes the grace schedule and a stored symbol', () => {
    expect(writeValue('graceBuckets', [{ maxDurationDays: '30', graceSeconds: '86400' }], w)).toBe('loans up to 30 days: 24 h grace');
    expect(writeValue('numeraireSymbol', `0x${Buffer.from('USD').toString('hex').padEnd(64, '0')}`, w)).toBe('USD');
  });
  it('writes a value of the wrong kind raw, never coerced', () => {
    expect(writeValue('treasuryFeeBps', true, w)).toBe('Unreadable value: true');
    expect(writeValue('treasury', '0x12', w)).toBe('Unreadable value: "0x12"');
    expect(writeValue('partialFillEnabled', '1', w)).toBe('Unreadable value: "1"');
  });
});

describe('switchState', () => {
  const sw = (id: string) => SWITCHES.find((s) => s.id === id)!;
  it('reads a feature switch and a pause switch from the settings', () => {
    expect(switchState(sw('partialFill'), { partialFillEnabled: true })).toBe('on');
    expect(switchState(sw('autoLend'), { autoLendEnabled: false })).toBe('off');
    expect(switchState(sw('keepersPaused'), { keepersPaused: true })).toBe('paused');
    expect(switchState(sw('keepersPaused'), { keepersPaused: false })).toBe('running');
  });
  it('states an unanswered, unread or unknown switch as such', () => {
    expect(switchState(sw('partialFill'), {})).toBe('unanswered');
    expect(switchState(sw('fullTariff'), { partialFillEnabled: true })).toBe('notRead');
    expect(switchState(sw('partialFill'), null)).toBe('unknown');
  });
});
