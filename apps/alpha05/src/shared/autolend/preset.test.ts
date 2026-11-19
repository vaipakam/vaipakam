import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeEventTopics, encodeAbiParameters, type Log } from 'viem';
import { PROFILE_ABI, type KeeperSettings } from '../keepers/keepers';
import { autoLendDraft, INTENT, setupCall, setupSteps, type ParsedAutoLend } from './autoLend';
import { lendConsentForm } from './consentForm';
import { openEndedSections } from './autoLendReview';
import { copyEntry } from '../copy/useCopy';
import {
  AUTO_ROLL,
  INSTANT,
  PRESELECTED,
  availabilityFromProbe,
  changeEffective,
  effectivePreset,
  openingPreset,
  parseRemembered,
  presetLogs,
  presetSteps,
  regainKey,
  relendPreselected,
  relendState,
} from './preset';

type Hex = `0x${string}`;
const USDC = '0x1111111111111111111111111111111111111111' as Hex;
const WETH = '0x2222222222222222222222222222222222222222' as Hex;
const ME = '0x3333333333333333333333333333333333333333' as Hex;
const DIAMOND = '0x4444444444444444444444444444444444444444' as Hex;
const KEEPER = '0x5555555555555555555555555555555555555555' as Hex;
const OTHER = '0x6666666666666666666666666666666666666666' as Hex;

const settings = (access: boolean, keepers: { keeper: Hex; actions: number }[]): KeeperSettings => ({ access, keepers, blockNumber: 1n });

describe('relendState (#3761 §3.2)', () => {
  it('approves the platform keeper for the roll alone, and switches access on, where nothing is approved', () => {
    const s = relendState(settings(false, []), KEEPER, false);
    expect(s).toEqual({
      kind: 'grant',
      changes: [
        { kind: 'approve', keeper: KEEPER, actions: AUTO_ROLL },
        { kind: 'access', on: true },
      ],
      regain: [],
    });
    expect(relendPreselected(s, 'running')).toBe(true);
    // #3763 rule 7: the permission is not the run.
    expect(relendPreselected(s, 'not-running')).toBe(false);
    expect(relendPreselected(s, 'unknown')).toBe(false);
  });

  it('adds the roll to what the keeper holds, removing nothing, and leaves access as it is when on', () => {
    const s = relendState(settings(true, [{ keeper: KEEPER, actions: 1 << 6 }]), KEEPER, false);
    expect(s).toEqual({ kind: 'grant', changes: [{ kind: 'actions', keeper: KEEPER, actions: (1 << 6) | AUTO_ROLL }], regain: [] });
    expect(relendPreselected(s, 'running')).toBe(true);
  });

  it('is given when access is on and the keeper already holds the roll', () => {
    expect(relendState(settings(true, [{ keeper: KEEPER, actions: AUTO_ROLL }]), KEEPER, false)).toEqual({ kind: 'given' });
  });

  it('is not pre-selected where access is off and other keepers are approved, and lists them', () => {
    const s = relendState(settings(false, [{ keeper: OTHER, actions: 1 << 0 }]), KEEPER, false);
    expect(s.kind).toBe('grant');
    if (s.kind !== 'grant') return;
    expect(s.regain).toEqual([{ keeper: OTHER, actions: 1 << 0 }]);
    expect(relendPreselected(s, 'running')).toBe(false);
  });

  it('is never offered for the platform token, and unknown when anything is unread', () => {
    expect(relendState(settings(true, []), KEEPER, true)).toEqual({ kind: 'vpfi' });
    expect(relendState(null, KEEPER, false)).toEqual({ kind: 'unknown' });
    expect(relendState(settings(true, []), null, false)).toEqual({ kind: 'no-keeper' });
    expect(relendState(settings(true, []), KEEPER, null)).toEqual({ kind: 'unknown' });
  });

  it('states a full whitelist rather than build a call the protocol refuses', () => {
    const five = ['6', '7', '8', '9', 'a'].map((n) => ({ keeper: `0x${n.repeat(40)}` as Hex, actions: 1 }));
    expect(relendState(settings(true, five), KEEPER, false)).toEqual({ kind: 'full' });
  });
});

describe('openingPreset', () => {
  it('opens on every choice pre-selected', () => {
    expect(openingPreset(null, null)).toEqual(PRESELECTED);
  });
  it('opens on the remembered choices, and never on re-lending where access would bring others back', () => {
    const remembered = { ...PRESELECTED, takeover: false };
    expect(openingPreset(remembered, null)).toEqual(remembered);
    const regain = relendState(settings(false, [{ keeper: OTHER, actions: 1 }]), KEEPER, false);
    expect(openingPreset(null, regain).relend).toBe(false);
  });
  it('opens on re-lending only where the keeper runs the roll step (#3763 rule 7)', () => {
    const grant = relendState(settings(true, []), KEEPER, false);
    expect(openingPreset(null, grant, 'running').relend).toBe(true);
    expect(openingPreset(null, grant, 'not-running').relend).toBe(false);
    expect(openingPreset(null, grant, 'unknown').relend).toBe(false);
    // An existing permission is shown as given, whatever the runner.
    expect(openingPreset(null, { kind: 'given' }, 'not-running').relend).toBe(true);
  });
  it('never opens on renewal until renewal is built (#3763)', () => {
    expect(PRESELECTED.renewal).toBe(false);
    expect(openingPreset({ ...PRESELECTED, renewal: true }, null).renewal).toBe(false);
  });
});

describe('effectivePreset (#3761 §3.1)', () => {
  const grant = relendState(settings(false, []), KEEPER, false);

  it('carries every choice where the market takes the pair', () => {
    const e = effectivePreset(PRESELECTED, grant, 'available', null);
    expect(e).toMatchObject({ fills: true, renewal: false, takeover: true, relend: 'granted' });
    // Renewal is never sent until it is built, whatever was chosen.
    expect(effectivePreset({ ...PRESELECTED, renewal: true }, grant, 'available', null).renewal).toBe(false);
    expect(e.keeper).toHaveLength(2);
  });

  it('switches the instant-market consents off with interest by time, and restores them with it', () => {
    const off = effectivePreset({ ...PRESELECTED, proRata: false }, grant, 'available', null);
    expect(off).toMatchObject({ fills: false, renewal: false, takeover: false, relend: 'granted' });
    expect(effectivePreset({ ...PRESELECTED, renewal: false }, grant, 'available', null)).toMatchObject({ fills: true, renewal: false, takeover: true });
  });

  it('sets no instant consent where the market is off, the pair is not eligible, or it is not known', () => {
    for (const a of ['market-off', 'pair-not-eligible', 'unknown'] as const)
      expect(effectivePreset(PRESELECTED, grant, a, null)).toMatchObject({ fills: false, renewal: false, takeover: false });
  });

  it('sends no keeper change when switched off, given, or unconfirmed', () => {
    expect(effectivePreset({ ...PRESELECTED, relend: false }, grant, 'available', null)).toMatchObject({ keeper: [], relend: 'off' });
    expect(effectivePreset(PRESELECTED, { kind: 'given' }, 'available', null)).toMatchObject({ keeper: [], relend: 'given' });
    const regain = relendState(settings(false, [{ keeper: OTHER, actions: 1 }]), KEEPER, false);
    expect(effectivePreset(PRESELECTED, regain, 'available', null)).toMatchObject({ keeper: [], relend: 'unconfirmed' });
    if (regain.kind !== 'grant') throw new Error('grant');
    expect(effectivePreset(PRESELECTED, regain, 'available', regainKey(regain.regain))).toMatchObject({ relend: 'granted' });
    // A list that moved after the confirmation is not the list confirmed.
    expect(effectivePreset(PRESELECTED, regain, 'available', regainKey([{ keeper: OTHER, actions: 3 }]))).toMatchObject({ relend: 'unconfirmed' });
  });
});

describe('changeEffective (#3761 §3.4)', () => {
  const rec = { fills: true, renewal: false, takeover: true, setAt: 1n };
  it('sends the consents the slot had again with the new terms', () => {
    expect(changeEffective(rec, true, 'available', { kind: 'given' })).toEqual({
      effective: { proRata: true, fills: true, renewal: false, takeover: true, keeper: [], relend: 'given' },
      cleared: false,
    });
  });
  it('states them cleared where the new terms cannot carry them', () => {
    expect(changeEffective(rec, false, 'available', { kind: 'unknown' }).cleared).toBe(true);
    expect(changeEffective(rec, true, 'market-off', { kind: 'unknown' }).cleared).toBe(true);
    expect(changeEffective({ ...rec, fills: false, takeover: false }, true, 'available', { kind: 'unknown' }).cleared).toBe(false);
  });
});

describe('availabilityFromProbe', () => {
  it('names the two cases and reads anything else as not known', () => {
    expect(availabilityFromProbe({ kind: 'reverted', name: 'InstantMarketDisabled' })).toBe('market-off');
    expect(availabilityFromProbe({ kind: 'reverted', name: 'InstantPairNotEligible' })).toBe('pair-not-eligible');
    expect(availabilityFromProbe({ kind: 'reverted', name: 'InstantSlotInactive' })).toBe('available');
    expect(availabilityFromProbe({ kind: 'reverted', name: 'SanctionedAddress' })).toBe('unknown');
    expect(availabilityFromProbe({ kind: 'reverted', name: null })).toBe('unknown');
    expect(availabilityFromProbe({ kind: 'unreadable' })).toBe('unknown');
  });
});

const parsed: ParsedAutoLend = {
  fund: 1000n,
  maxExposure: null,
  minRateBps: 500n,
  maxInitLtvBps: 6000,
  maxDurationDays: 30,
  minFill: null,
  lendUntilDate: null,
  acceptsProRata: true,
};

describe('the one batch (#3761 §3.4)', () => {
  const draft = autoLendDraft(USDC, WETH, parsed, false, 0, PRESELECTED, null);
  const e = effectivePreset(PRESELECTED, relendState(settings(false, []), KEEPER, false), 'available', null);

  it('sets the terms, funds them, then the consents and the keeper permission, every step required', () => {
    const names = setupSteps(draft, 100n, true, 99n, null, e).map((s) => s.functionName);
    expect(names).toEqual(['setLenderIntent', 'fundLenderIntent', 'setInstantSlot', 'approveKeeper', 'setKeeperAccess']);
    const call = setupCall(draft, 100n, 99n, null, false, e);
    expect(call.functionName).toBe('multicall');
    const calls = (call.args as unknown as [{ callData: Hex; allowFailure: boolean }[]])[0];
    expect(calls.every((c) => c.allowFailure === false)).toBe(true);
    const instant = decodeFunctionData({ abi: INSTANT, data: calls[2]!.callData });
    expect(instant.args).toEqual([USDC, WETH, 0, true, false, true, true, 99n]);
    const approve = decodeFunctionData({ abi: PROFILE_ABI, data: calls[3]!.callData });
    expect(approve.args).toEqual([KEEPER, AUTO_ROLL]);
  });

  it('dry-runs everything but the funding while the approval does not cover it', () => {
    const call = setupCall(draft, 100n, 99n, null, true, e);
    const calls = (call.args as unknown as [{ callData: Hex }[]])[0];
    const abi = [...INTENT, ...INSTANT, ...PROFILE_ABI];
    const names = calls.map((c) => decodeFunctionData({ abi, data: c.callData }).functionName);
    expect(names).toEqual(['setLenderIntent', 'setInstantSlot', 'approveKeeper', 'setKeeperAccess']);
    expect(names).not.toContain('fundLenderIntent');
    expect(calls).toHaveLength(4);
  });

  it('adds nothing for choices that are off', () => {
    const none = effectivePreset({ ...PRESELECTED, relend: false, proRata: false }, { kind: 'given' }, 'available', null);
    expect(presetSteps(none, USDC, WETH, 0, 99n)).toEqual([]);
  });
});

describe('presetLogs', () => {
  it('reads the consents and the keeper changes from the batch logs', () => {
    const log = (abi: typeof INSTANT, eventName: string, args: Record<string, unknown>, data: Hex): Log =>
      ({ address: DIAMOND, topics: encodeEventTopics({ abi, eventName, args } as never), data }) as unknown as Log;
    const logs = [
      log(
        INSTANT,
        'InstantSlotSet',
        { owner: ME, lendingAsset: USDC, collateralAsset: WETH },
        encodeAbiParameters([{ type: 'uint8' }, { type: 'bool' }, { type: 'bool' }, { type: 'bool' }], [0, true, false, true]),
      ),
      log(PROFILE_ABI, 'KeeperActionsUpdated', { user: ME, keeper: KEEPER }, encodeAbiParameters([{ type: 'uint16' }, { type: 'uint16' }], [AUTO_ROLL, 0])),
      log(PROFILE_ABI, 'KeeperAccessUpdated', { user: ME }, encodeAbiParameters([{ type: 'bool' }], [true])),
    ];
    expect(presetLogs(logs, DIAMOND, ME, USDC, WETH, 0, KEEPER)).toEqual({ instant: { fills: true, renewal: false, takeover: true }, keeperActions: AUTO_ROLL, access: true });
  });
});

describe('remembered choice and the consent form', () => {
  it('reads back only a well-formed choice', () => {
    expect(parseRemembered(JSON.stringify({ runs: 'once', preset: PRESELECTED }))).toEqual({ runs: 'once', preset: PRESELECTED });
    expect(parseRemembered('{"runs":"sometimes"}')).toBeNull();
    expect(parseRemembered('not json')).toBeNull();
    expect(parseRemembered(null)).toBeNull();
  });
  it('opens pre-selected unless the deployment asks for the choose-one form', () => {
    expect(lendConsentForm(undefined)).toBe('preselected');
    expect(lendConsentForm('choose')).toBe('choose');
    expect(lendConsentForm('other')).toBe('preselected');
  });
});

describe('openEndedSections (#3763 §3.6)', () => {
  const copy = { text: (k: string) => k, format: (k: string, v: Record<string, string>) => `${k}#${v.date ?? ''}` } as never;
  const parsedWith = (lendUntilDate: string | null) => ({ ...autoLendDraft(USDC, WETH, parsed, false, 0, PRESELECTED, null), parsed: { ...parsed, lendUntilDate } });
  it('states no end date, then how funds come back, never promising a date of return', () => {
    const s = openEndedSections(parsedWith(null), true, copy);
    expect(s.map((x) => x.title)).toEqual(['autoLend.openEndedTitle', 'autoLend.fundsBackTitle']);
    expect(s[1]!.body).toEqual(['autoLend.fundsBackBody', 'autoLend.fundsBackSooner', 'autoLend.fundsBackNoPromise']);
  });
  it('names the set period where chosen, and leaves the handover out where the takeover is not deployed', () => {
    const s = openEndedSections(parsedWith('2027-03-01'), false, copy);
    expect(s[0]!.title).toBe('autoLend.setPeriodTitle#2027-03-01');
    expect(s[1]!.body).toContain('autoLend.fundsBackSoonerSale');
    expect(copyEntry('autoLend.fundsBackSoonerSale').text).not.toMatch(/handover/);
  });
});
