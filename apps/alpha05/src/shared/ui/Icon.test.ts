import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NAV_ADVANCED, PAGES } from '../../routes/pageMap';
import { Icon, MEANINGS, PLACES, PlaceIcon, type Meaning } from './Icon';

/** RB-ICONS: one closed vocabulary, every destination drawn, never read aloud. */
describe('RB-ICONS', () => {
  it('has exactly the closed list of meanings, and no plain-information icon', () => {
    expect(Object.keys(MEANINGS).sort()).toEqual(['act', 'blocked', 'done', 'money-out', 'pending', 'sign', 'unknown', 'why']);
    expect('info' in MEANINGS).toBe(false);
  });

  it('gives each meaning its own shape (one meaning, one icon)', () => {
    const shapes = Object.values(MEANINGS).map((m) => JSON.stringify(m.shape));
    expect(new Set(shapes).size).toBe(shapes.length);
  });

  it('draws every navigation destination, plus More', () => {
    for (const p of NAV_ADVANCED) expect(PLACES[p.path], p.path).toBeDefined();
    expect(PLACES.more).toBeDefined();
    // No place icon for a path the page map does not have.
    const paths = new Set(PAGES.map((p) => p.path));
    for (const key of Object.keys(PLACES)) if (key !== 'more') expect(paths.has(key), key).toBe(true);
  });

  it('hides every icon from assistive technology and draws it in the text colour', () => {
    for (const m of Object.keys(MEANINGS) as Meaning[]) {
      const svg = renderToStaticMarkup(createElement(Icon, { meaning: m }));
      expect(svg).toContain('aria-hidden="true"');
      expect(svg).toContain('focusable="false"');
      expect(svg).toContain('stroke="currentColor"');
      expect(svg).toContain(`icon-${m}`);
    }
    expect(renderToStaticMarkup(createElement(PlaceIcon, { place: '/borrow' }))).toContain('aria-hidden="true"');
    expect(renderToStaticMarkup(createElement(PlaceIcon, { place: '/nowhere' }))).toBe('');
  });
});
