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
import { buildAlertSettingsMessage } from '@vaipakam/lib/alertsMessage';
import {
  DEFAULT_PREFS,
  FLOOR_BANDS,
  addsAlertOptIn,
  saveAlertPrefs,
  unlinkTelegram,
  type AlertPrefs,
} from './alerts';

const prefs = (over: Partial<AlertPrefs> = {}): AlertPrefs => ({
  ...DEFAULT_PREFS,
  ...over,
});

/** A wallet stand-in that records what it was asked to sign. */
function recordingSigner() {
  const signed: string[] = [];
  return {
    signed,
    signMessage: async (message: string) => {
      signed.push(message);
      return `0xsig${signed.length}`;
    },
  };
}

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
      signMessage: recordingSigner().signMessage,
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
      signMessage: recordingSigner().signMessage,
    });
    expect(bodies[0]!.warn_hf).toBe(DEFAULT_PREFS.warnHf);
    expect(bodies[0]!.critical_hf).toBe(DEFAULT_PREFS.criticalHf);
  });

  it('sends the FLOOR bands when the lane was switched off — that IS the opt-out', async () => {
    const bodies = stubAgent();
    await saveAlertPrefs(WALLET, 84532, { ...DEFAULT_PREFS, risky: false }, {
      bandsChanged: true,
      signMessage: recordingSigner().signMessage,
    });
    expect(bodies[0]!.warn_hf).toBe(FLOOR_BANDS.warnHf);
    expect(bodies[0]!.alert_hf).toBe(FLOOR_BANDS.alertHf);
    expect(bodies[0]!.critical_hf).toBe(FLOOR_BANDS.criticalHf);
  });

  it('signs every save over exactly what its body carries (#2754)', async () => {
    // The agent stores nothing unsigned, and rebuilds the message from the
    // body it received: the signed message and the body must describe one
    // save, or every save is refused.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_800_000_000_000));
    try {
      const bodies = stubAgent();
      const wallet = recordingSigner();
      await saveAlertPrefs(WALLET, 84532, { ...DEFAULT_PREFS, risky: false, repayDue: false }, {
        bandsChanged: true,
        dueDateChanged: true,
        signMessage: wallet.signMessage,
      });
      expect(wallet.signed).toEqual([
        buildAlertSettingsMessage(
          WALLET,
          84532,
          { bands: FLOOR_BANDS, dueDateReminders: false },
          1_800_000_000,
        ),
      ]);
      expect(bodies[0]!.issuedAt).toBe(1_800_000_000);
      expect(bodies[0]!.signature).toBe('0xsig1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('signs a save that changes nothing it names, too', async () => {
    // No unsigned path is left: the agent refuses an unsigned body, so the
    // app never sends one, whatever the save carries.
    const bodies = stubAgent();
    const wallet = recordingSigner();
    await saveAlertPrefs(WALLET, 84532, { ...DEFAULT_PREFS }, { signMessage: wallet.signMessage });
    expect(wallet.signed).toHaveLength(1);
    expect(wallet.signed[0]).toContain('Health-factor alerts: unchanged');
    expect(wallet.signed[0]).toContain('Due-date payment reminders: unchanged');
    expect(bodies[0]!.signature).toBe('0xsig1');
  });

  it('names a repeated signature and an unavailable check in plain words', async () => {
    vi.stubEnv('VITE_AGENT_ORIGIN', 'https://agent.test');
    for (const [status, error, words] of [
      [409, 'request-already-used', /already used/],
      [503, 'verification-unavailable', /could not check your signature/],
    ] as const) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify({ error }), { status })),
      );
      await expect(
        saveAlertPrefs(WALLET, 84532, { ...DEFAULT_PREFS }, {
          signMessage: recordingSigner().signMessage,
        }),
      ).rejects.toThrow(words);
    }
  });
});

describe('saveAlertPrefs and a refused Push opt-in (#2251)', () => {
  const WALLET = '0x1DAefA360ED370285f003Fa2d92DB75628088282' as const;
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function stubAgent(first: { status: number; body: unknown }) {
    vi.stubEnv('VITE_AGENT_ORIGIN', 'https://agent.test');
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        const answer = bodies.length === 1 ? first : { status: 200, body: { ok: true } };
        return new Response(JSON.stringify(answer.body), { status: answer.status });
      }),
    );
    return bodies;
  }

  // Codex #2665 r1 — the agent refuses a NEW opt-in it cannot honour with a
  // 409 that stores nothing (an older bundle reads that as a failure). This
  // client says Push is off and sends the same save again WITHOUT the
  // opt-in, so everything else in it still lands.
  it('reports the refusal and repeats the save without the opt-in', async () => {
    const bodies = stubAgent({
      status: 409,
      body: { error: 'push-unavailable', push: 'unavailable' },
    });
    const wallet = recordingSigner();
    const out = await saveAlertPrefs(WALLET, 84532, { ...DEFAULT_PREFS, pushEnabled: true }, {
      dueDateChanged: true,
      signMessage: wallet.signMessage,
    });
    expect(out).toBe('unavailable');
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.push_channel).toBe('subscribed');
    expect(bodies[1]!.push_channel).toBeUndefined();
    expect(bodies[1]!.notify_maturity_approaching).toBe(true);
    // The repeat is a different change, so it is signed again (#2753:
    // each signed request is accepted once).
    expect(wallet.signed).toHaveLength(2);
    expect(wallet.signed[0]).toContain('Push alerts: switch on');
    expect(wallet.signed[1]).toContain('Push alerts: unchanged');
    expect(bodies[1]!.signature).toBe('0xsig2');
  });

  it('reads an opt-in the agent kept or stored as stored', async () => {
    stubAgent({ status: 200, body: { ok: true, push: 'kept' } });
    expect(
      await saveAlertPrefs(WALLET, 84532, { ...DEFAULT_PREFS, pushEnabled: true }, {
        signMessage: recordingSigner().signMessage,
      }),
    ).toBe('stored');
  });

  it('still fails on any other 409', async () => {
    stubAgent({ status: 409, body: { error: 'something-else' } });
    await expect(
      saveAlertPrefs(WALLET, 84532, { ...DEFAULT_PREFS, pushEnabled: true }, {
        signMessage: recordingSigner().signMessage,
      }),
    ).rejects.toThrow(/409/);
  });
});

describe('unlinkTelegram scope (#2013 r4)', () => {
  // A smart account's chain-verified signature buys a chain-scoped
  // clear; an ordinary key's buys the wallet-wide one. The service
  // reports which applied, and the confirmation the card shows must
  // match — so this mapping is load-bearing for not announcing a
  // wallet-wide disconnect that did not happen.
  const WALLET = '0x1DAefA360ED370285f003Fa2d92DB75628088282' as const;

  function stubUnlink(body: unknown) {
    vi.stubEnv('VITE_AGENT_ORIGIN', 'https://agent.test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("maps the service's scope through, defaulting a pre-scope agent to wallet-wide", async () => {
    stubUnlink({ ok: true, scope: 'chain' });
    expect(await unlinkTelegram(WALLET, 84532, async () => `0x${'ab'.repeat(65)}`)).toBe(
      'chain',
    );
    stubUnlink({ ok: true, scope: 'wallet' });
    expect(await unlinkTelegram(WALLET, 84532, async () => `0x${'ab'.repeat(65)}`)).toBe(
      'wallet',
    );
    // An agent from before the scoped response: the old behaviour
    // WAS wallet-wide, so that is what the confirmation must say.
    stubUnlink({ ok: true });
    expect(await unlinkTelegram(WALLET, 84532, async () => `0x${'ab'.repeat(65)}`)).toBe(
      'wallet',
    );
  });
});
