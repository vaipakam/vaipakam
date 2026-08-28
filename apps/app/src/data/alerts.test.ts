/**
 * The alerts save's enrolment direction (#1961, review round 9 P1).
 *
 * The Terms gate holds enrolment and never holds an opt-out, so this
 * predicate is the whole of what it can hold on this card. Both
 * directions of getting it wrong are here: refusing a user the ability
 * to switch a lane OFF (the round-8 defect — a gate trapping somebody
 * in a subscription), and permitting a held wallet to switch one on.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, addsAlertOptIn, type AlertPrefs } from './alerts';

const prefs = (over: Partial<AlertPrefs> = {}): AlertPrefs => ({
  ...DEFAULT_PREFS,
  ...over,
});

describe('addsAlertOptIn', () => {
  it('does not call switching a lane off an enrolment', () => {
    // The round-8 defect exactly: fresh preferences have BOTH lanes on,
    // so turning one off leaves the other on. Classifying by what
    // remains enabled read that as enrolment and refused it, locking
    // every held user out of disabling either reminder.
    const both = prefs({ repayDue: true, risky: true });
    expect(addsAlertOptIn(both, prefs({ repayDue: false, risky: true }))).toBe(false);
    expect(addsAlertOptIn(both, prefs({ repayDue: true, risky: false }))).toBe(false);
    expect(addsAlertOptIn(both, prefs({ repayDue: false, risky: false }))).toBe(false);
  });

  it('lets an established user disable one channel among several', () => {
    const many = prefs({
      repayDue: true,
      risky: true,
      telegramLinked: true,
      pushEnabled: true,
    });
    expect(addsAlertOptIn(many, { ...many, pushEnabled: false })).toBe(false);
    expect(addsAlertOptIn(many, { ...many, telegramLinked: false })).toBe(false);
  });

  it('holds a save that turns a lane on', () => {
    const off = prefs({ repayDue: false, risky: false });
    expect(addsAlertOptIn(off, { ...off, repayDue: true })).toBe(true);
    expect(addsAlertOptIn(off, { ...off, risky: true })).toBe(true);
    expect(addsAlertOptIn(off, { ...off, pushEnabled: true })).toBe(true);
    expect(addsAlertOptIn(off, { ...off, telegramLinked: true })).toBe(true);
  });

  it('holds a save that turns one on while turning another off', () => {
    // A net-neutral swap is still new enrolment in the lane it adds;
    // the opt-out half does not buy it.
    const one = prefs({ repayDue: true, risky: false });
    expect(addsAlertOptIn(one, prefs({ repayDue: false, risky: true }))).toBe(true);
  });

  it('does not treat band tuning as enrolment', () => {
    // The advanced form only renders once `risky` is on, so its saves
    // adjust an opt-in the user already made. Holding them would let a
    // paperwork rule freeze somebody's risk thresholds while a position
    // drifts.
    const on = prefs({ risky: true });
    expect(addsAlertOptIn(on, { ...on, warnHf: 1.4, alertHf: 1.15 })).toBe(false);
    // ...and an unchanged save is not enrolment either.
    expect(addsAlertOptIn(on, { ...on })).toBe(false);
  });

  it('treats an untouched default lane as already enrolled', () => {
    // Review round 10 P1. On a device with no saved record the
    // baseline IS the defaults, so a first opt-out is judged against
    // them. Failing closed here instead would re-create the round-9
    // lock-out, since the untouched default lane is what would trip
    // it. Pinned so the choice is deliberate rather than incidental —
    // and bounded by the case below.
    const fresh = DEFAULT_PREFS;
    expect(addsAlertOptIn(fresh, { ...fresh, repayDue: false })).toBe(false);
  });

  it('never lets a defaults-derived save enrol a delivery channel', () => {
    // What bounds the case above: the two flags that establish where a
    // message would actually GO are false in the defaults, so a save
    // derived from them is held the moment it turns either on.
    expect(DEFAULT_PREFS.telegramLinked).toBe(false);
    expect(DEFAULT_PREFS.pushEnabled).toBe(false);
    expect(
      addsAlertOptIn(DEFAULT_PREFS, { ...DEFAULT_PREFS, pushEnabled: true }),
    ).toBe(true);
    expect(
      addsAlertOptIn(DEFAULT_PREFS, { ...DEFAULT_PREFS, telegramLinked: true }),
    ).toBe(true);
  });
});
