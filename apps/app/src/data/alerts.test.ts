/**
 * The alerts save's enrolment direction (#1961, review round 9 P1).
 *
 * The Terms gate holds enrolment and never holds an opt-out, so this
 * predicate is the whole of what it can hold on this card. Both
 * directions of getting it wrong are here: refusing a user the ability
 * to switch a lane OFF (the round-8 defect — a gate trapping somebody
 * in a subscription), and permitting a held wallet to switch one on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PREFS,
  FLOOR_BANDS,
  addsAlertOptIn,
  saveAlertPrefs,
  type AlertPrefs,
} from './alerts';

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

describe('saveAlertPrefs wire shape (#2000)', () => {
  // The defect this closes: the whole record travelled with every
  // save, so a fresh device's DEFAULT risky-lane state rode along
  // with an unrelated change and overwrote a floor-band opt-out made
  // elsewhere. Bands now travel ONLY on a save that changed the
  // risky lane, the same omission rule the due-date flag already
  // carries; the agent preserves stored values on absence.
  const WALLET = '0x1DAefA360ED370285f003Fa2d92DB75628088282' as const;

  function stubAgent(): Array<Record<string, unknown>> {
    vi.stubEnv('VITE_AGENT_ORIGIN', 'https://agent.test');
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
    return bodies;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('omits every band unless this save changed the risky lane', async () => {
    const bodies = stubAgent();
    // A first opt-out from a fresh device: the due-date toggle only.
    await saveAlertPrefs(WALLET, 84532, { ...DEFAULT_PREFS, repayDue: true }, {
      dueDateChanged: true,
    });
    expect(bodies[0]!.warn_hf).toBeUndefined();
    expect(bodies[0]!.alert_hf).toBeUndefined();
    expect(bodies[0]!.critical_hf).toBeUndefined();
    expect(bodies[0]!.notify_maturity_approaching).toBe(true);
  });

  it('sends the REAL bands when the lane was switched on or tuned', async () => {
    const bodies = stubAgent();
    await saveAlertPrefs(WALLET, 84532, { ...DEFAULT_PREFS, risky: true }, {
      bandsChanged: true,
    });
    expect(bodies[0]!.warn_hf).toBe(DEFAULT_PREFS.warnHf);
    expect(bodies[0]!.critical_hf).toBe(DEFAULT_PREFS.criticalHf);
  });

  it('sends the FLOOR bands when the lane was switched off — that IS the opt-out', async () => {
    const bodies = stubAgent();
    await saveAlertPrefs(WALLET, 84532, { ...DEFAULT_PREFS, risky: false }, {
      bandsChanged: true,
    });
    expect(bodies[0]!.warn_hf).toBe(FLOOR_BANDS.warnHf);
    expect(bodies[0]!.alert_hf).toBe(FLOOR_BANDS.alertHf);
    expect(bodies[0]!.critical_hf).toBe(FLOOR_BANDS.criticalHf);
  });

  it('retries ONCE with bands when an old agent refuses the bandless body', async () => {
    // Rollout shim (#2005 round 1 P2): the app and agent deploy
    // independently, and an app deployed first would send bandless
    // saves to a parser that requires all three — every due-date and
    // push save 400ing, a held user unable to mute a reminder being
    // the worst of it. A bandless save refused as `invalid-payload`
    // is retried with the lane's current bands (the pre-#2000 wire,
    // no worse than before); any other failure is not.
    vi.stubEnv('VITE_AGENT_ORIGIN', 'https://agent.test');
    const bodies: Array<Record<string, unknown>> = [];
    let first = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (first) {
          first = false;
          return new Response(JSON.stringify({ error: 'invalid-payload' }), {
            status: 400,
          });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
    await saveAlertPrefs(WALLET, 84532, { ...DEFAULT_PREFS }, {
      dueDateChanged: true,
    });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.warn_hf).toBeUndefined();
    expect(bodies[1]!.warn_hf).toBe(DEFAULT_PREFS.warnHf);
    // The retry keeps the rest of the body intact — the opt-in flag
    // still travels.
    expect(bodies[1]!.notify_maturity_approaching).toBe(true);
  });
});
