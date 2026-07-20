import { describe, expect, it, beforeAll } from 'vitest';
import i18n from 'i18next';
import { tmpl, interpolate, isTmpl, TMPL } from './tmpl';
import { createTranslatedCopy } from './reactiveCopy';
import { buildTemplate } from './template';

describe('interpolate', () => {
  it('substitutes {{var}} and leaves unknown placeholders intact', () => {
    expect(interpolate('Hi {{name}}', { name: 'Ada' })).toBe('Hi Ada');
    expect(interpolate('Due in {{n}} days', { n: 3 })).toBe('Due in 3 days');
    expect(interpolate('Hi {{name}}', { other: 'x' })).toBe('Hi {{name}}');
  });
});

describe('tmpl (positional args → named params)', () => {
  it('is a callable tagged with its template meta', () => {
    const t = tmpl('You’re on {{chainName}}', ['chainName']);
    expect(isTmpl(t)).toBe(true);
    expect(t[TMPL].template).toBe('You’re on {{chainName}}');
    // Called positionally (pre-init / SSR / test path) → English.
    expect(t('Base')).toBe('You’re on Base');
  });

  it('maps multiple positional args in declared order', () => {
    const t = tmpl('{{amount}} {{symbol}}', ['amount', 'symbol']);
    expect(t('5', 'ETH')).toBe('5 ETH');
  });

  it('selects the English plural variant by count', () => {
    const t = tmpl('You have {{count}} positions.', ['count'], {
      one: 'You have {{count}} position.',
    });
    expect(t(1)).toBe('You have 1 position.');
    expect(t(3)).toBe('You have 3 positions.');
  });
});

describe('buildTemplate emits tmpl entries', () => {
  it('emits a simple template under its key', () => {
    const out = buildTemplate({ nudge: tmpl('On {{chain}}', ['chain']) }) as Record<
      string,
      string
    >;
    expect(out).toEqual({ nudge: 'On {{chain}}' });
  });

  it('emits the full CLDR category set for a plural (superset for ar etc.)', () => {
    const out = buildTemplate({
      active: tmpl('You have {{count}} positions.', ['count'], {
        one: 'You have {{count}} position.',
      }),
    }) as Record<string, string>;
    // English defines only `one`; every other category falls back to the
    // base (`_other`) template as a fill slot so many-category locales
    // (Arabic: zero/two/few/many) have every key to translate (#1345 r5).
    expect(out).toEqual({
      active_zero: 'You have {{count}} positions.',
      active_one: 'You have {{count}} position.',
      active_two: 'You have {{count}} positions.',
      active_few: 'You have {{count}} positions.',
      active_many: 'You have {{count}} positions.',
      active_other: 'You have {{count}} positions.',
    });
  });
});

describe('createTranslatedCopy translates tmpl leaves', () => {
  beforeAll(async () => {
    if (!i18n.isInitialized) {
      await i18n.init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: {} } } });
    }
  });

  const source = {
    home: {
      testnetNudge: tmpl('You’re on {{chainName}}, a test network.', ['chainName']),
      activePositions: tmpl('You have {{count}} active positions.', ['count'], {
        one: 'You have {{count}} active position.',
      }),
    },
  };

  it('serves the interpolated English default when no bundle carries the key', async () => {
    await i18n.changeLanguage('en');
    const copy = createTranslatedCopy(source);
    expect(copy.home.testnetNudge('Base Sepolia')).toBe(
      'You’re on Base Sepolia, a test network.',
    );
    expect(copy.home.activePositions(1)).toBe('You have 1 active position.');
    expect(copy.home.activePositions(5)).toBe('You have 5 active positions.');
  });

  it('resolves a translated bundle and interpolates the value', async () => {
    i18n.addResourceBundle('es', 'translation', {
      copy: {
        home: {
          testnetNudge: 'Estás en {{chainName}}, una red de prueba.',
          activePositions_one: 'Tienes {{count}} posición activa.',
          activePositions_other: 'Tienes {{count}} posiciones activas.',
        },
      },
    });
    await i18n.changeLanguage('es');
    const copy = createTranslatedCopy(source);
    expect(copy.home.testnetNudge('Base')).toBe('Estás en Base, una red de prueba.');
    expect(copy.home.activePositions(1)).toBe('Tienes 1 posición activa.');
    expect(copy.home.activePositions(4)).toBe('Tienes 4 posiciones activas.');
    await i18n.changeLanguage('en');
  });

  it('returns a stable function identity across reads', () => {
    const copy = createTranslatedCopy(source);
    expect(copy.home.testnetNudge).toBe(copy.home.testnetNudge);
  });
});
