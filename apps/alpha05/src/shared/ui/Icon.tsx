/**
 * RB-ICONS: one small icon vocabulary, each icon with ONE meaning, always
 * beside the words that carry it (an icon never carries meaning alone, so it
 * is hidden from assistive technology). Icons take the colour of the text
 * they sit in (`currentColor`), so the shared palette, dark mode and the
 * contrast tests cover them with no colour of their own.
 *
 * Two families, never mixed: MEANINGS mark what a line or button asks of
 * the reader (act, blocked, done, money leaving the wallet, a signature,
 * pending, unknown, why); plain information carries no icon; PLACES mark navigation destinations, on the
 * phone's bottom bar. A new meaning is a rulebook change, not a local
 * decoration.
 *
 * Shapes are Lucide's (https://lucide.dev), drawn on a 24 px grid with a 2 px
 * round stroke, carried here as data so the app adds no dependency.
 * Lucide is ISC licensed. Copyright (c) for portions of Lucide are held by
 * Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for
 * Lucide are held by Lucide Contributors 2022.
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY
 * SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR
 * IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */
import { createElement } from 'react';

type Shape = readonly (readonly [string, Readonly<Record<string, string>>])[];

/** What each meaning stands for; the rulebook (RB-ICONS) carries the same list. */
export const MEANINGS = {
  act: {
    says: 'Something waits on you: an action, a deadline, a shortfall.',
    shape: [
      ['path', { d: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3' }],
      ['path', { d: 'M12 9v4' }],
      ['path', { d: 'M12 17h.01' }],
    ],
  },
  blocked: {
    says: 'The protocol or the page will not let this happen now.',
    shape: [
      ['circle', { cx: '12', cy: '12', r: '10' }],
      ['path', { d: 'M4.929 4.929 19.07 19.071' }],
    ],
  },
  done: {
    says: 'Measured on the chain as done.',
    shape: [
      ['circle', { cx: '12', cy: '12', r: '10' }],
      ['path', { d: 'm9 12 2 2 4-4' }],
    ],
  },
  'money-out': {
    says: 'Money or a token leaves your wallet, or an approval lets it.',
    shape: [
      ['path', { d: 'M7 7h10v10' }],
      ['path', { d: 'M7 17 17 7' }],
    ],
  },
  sign: {
    says: 'The wallet asks for a signature; it costs nothing and moves nothing by itself.',
    shape: [
      [
        'path',
        {
          d: 'm21 17-2.156-1.868A.5.5 0 0 0 18 15.5v.5a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1c0-2.545-3.991-3.97-8.5-4a1 1 0 0 0 0 5c4.153 0 4.745-11.295 5.708-13.5a2.5 2.5 0 1 1 3.31 3.284',
        },
      ],
      ['path', { d: 'M3 21h18' }],
    ],
  },
  pending: {
    says: 'Sent or under way; the outcome is not known yet.',
    shape: [
      ['path', { d: 'M5 22h14' }],
      ['path', { d: 'M5 2h14' }],
      ['path', { d: 'M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22' }],
      ['path', { d: 'M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2' }],
    ],
  },
  unknown: {
    says: 'A figure the app could not read: stated as unknown, never guessed.',
    shape: [
      ['path', { d: 'M10.1 2.182a10 10 0 0 1 3.8 0' }],
      ['path', { d: 'M13.9 21.818a10 10 0 0 1-3.8 0' }],
      ['path', { d: 'M17.609 3.721a10 10 0 0 1 2.69 2.7' }],
      ['path', { d: 'M2.182 13.9a10 10 0 0 1 0-3.8' }],
      ['path', { d: 'M20.279 17.609a10 10 0 0 1-2.7 2.69' }],
      ['path', { d: 'M21.818 10.1a10 10 0 0 1 0 3.8' }],
      ['path', { d: 'M3.721 6.391a10 10 0 0 1 2.7-2.69' }],
      ['path', { d: 'M6.391 20.279a10 10 0 0 1-2.69-2.7' }],
    ],
  },
  why: {
    says: 'The full explanation of the sentence just before it is one tap away (the info button, named Why? for screen readers).',
    shape: [
      ['circle', { cx: '12', cy: '12', r: '10' }],
      ['path', { d: 'M12 16v-4' }],
      ['path', { d: 'M12 8h.01' }],
    ],
  },
} as const satisfies Record<string, { says: string; shape: Shape }>;

export type Meaning = keyof typeof MEANINGS;

/** Navigation destinations, by route path (the page map). */
export const PLACES: Readonly<Record<string, Shape>> = {
  '/': [
    ['path', { d: 'M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8' }],
    ['path', { d: 'M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }],
  ],
  '/borrow': [
    ['path', { d: 'M11 15h2a2 2 0 1 0 0-4h-3c-.6 0-1.1.2-1.4.6L3 17' }],
    ['path', { d: 'm7 21 1.6-1.4c.3-.4.8-.6 1.4-.6h4c1.1 0 2.1-.4 2.8-1.2l4.6-4.4a2 2 0 0 0-2.75-2.91l-4.2 3.9' }],
    ['path', { d: 'm2 16 6 6' }],
    ['circle', { cx: '16', cy: '9', r: '2.9' }],
    ['circle', { cx: '6', cy: '5', r: '3' }],
  ],
  '/lend': [
    ['path', { d: 'M12 18H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5' }],
    ['path', { d: 'M18 12h.01' }],
    ['path', { d: 'M19 22v-6' }],
    ['path', { d: 'm22 19-3-3-3 3' }],
    ['path', { d: 'M6 12h.01' }],
    ['circle', { cx: '12', cy: '12', r: '2' }],
  ],
  '/positions': [
    ['path', { d: 'M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16' }],
    ['rect', { width: '20', height: '14', x: '2', y: '6', rx: '2' }],
  ],
  '/claims': [
    ['polyline', { points: '22 12 16 12 14 15 10 15 8 12 2 12' }],
    ['path', { d: 'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z' }],
  ],
  '/vault': [
    ['rect', { width: '18', height: '18', x: '3', y: '3', rx: '2' }],
    ['circle', { cx: '7.5', cy: '7.5', r: '.5', fill: 'currentColor' }],
    ['path', { d: 'm7.9 7.9 2.7 2.7' }],
    ['circle', { cx: '16.5', cy: '7.5', r: '.5', fill: 'currentColor' }],
    ['path', { d: 'm13.4 10.6 2.7-2.7' }],
    ['circle', { cx: '7.5', cy: '16.5', r: '.5', fill: 'currentColor' }],
    ['path', { d: 'm7.9 16.1 2.7-2.7' }],
    ['circle', { cx: '16.5', cy: '16.5', r: '.5', fill: 'currentColor' }],
    ['path', { d: 'm13.4 13.4 2.7 2.7' }],
    ['circle', { cx: '12', cy: '12', r: '2' }],
  ],
  '/offers': [
    ['path', { d: 'M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z' }],
    ['circle', { cx: '7.5', cy: '7.5', r: '.5', fill: 'currentColor' }],
  ],
  '/rent': [
    [
      'path',
      {
        d: 'M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z',
      },
    ],
    ['circle', { cx: '16.5', cy: '7.5', r: '.5', fill: 'currentColor' }],
  ],
  '/rewards': [
    ['path', { d: 'M12 7v14' }],
    ['path', { d: 'M20 11v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8' }],
    ['path', { d: 'M7.5 7a1 1 0 0 1 0-5A4.8 8 0 0 1 12 7a4.8 8 0 0 1 4.5-5 1 1 0 0 1 0 5' }],
    ['rect', { x: '3', y: '7', width: '18', height: '4', rx: '1' }],
  ],
  '/protection': [
    [
      'path',
      { d: 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z' },
    ],
    ['path', { d: 'm9 12 2 2 4-4' }],
  ],
  '/desk': [
    ['path', { d: 'M15.707 21.293a1 1 0 0 1-1.414 0l-1.586-1.586a1 1 0 0 1 0-1.414l5.586-5.586a1 1 0 0 1 1.414 0l1.586 1.586a1 1 0 0 1 0 1.414z' }],
    ['path', { d: 'm18 13-1.375-6.874a1 1 0 0 0-.746-.776L3.235 2.028a1 1 0 0 0-1.207 1.207L5.35 15.879a1 1 0 0 0 .776.746L13 18' }],
    ['path', { d: 'm2.3 2.3 7.286 7.286' }],
    ['circle', { cx: '11', cy: '11', r: '2' }],
  ],
  '/console': [
    ['path', { d: 'M10 5H3' }],
    ['path', { d: 'M12 19H3' }],
    ['path', { d: 'M14 3v4' }],
    ['path', { d: 'M16 17v4' }],
    ['path', { d: 'M21 12h-9' }],
    ['path', { d: 'M21 19h-5' }],
    ['path', { d: 'M21 5h-7' }],
    ['path', { d: 'M8 10v4' }],
    ['path', { d: 'M8 12H3' }],
  ],
  '/recover': [
    ['path', { d: 'M9 14 4 9l5-5' }],
    ['path', { d: 'M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11' }],
  ],
  '/analytics': [
    ['path', { d: 'M3 3v16a2 2 0 0 0 2 2h16' }],
    ['path', { d: 'M18 17V9' }],
    ['path', { d: 'M13 17V5' }],
    ['path', { d: 'M8 17v-3' }],
  ],
  more: [
    ['circle', { cx: '12', cy: '12', r: '1' }],
    ['circle', { cx: '19', cy: '12', r: '1' }],
    ['circle', { cx: '5', cy: '12', r: '1' }],
  ],
};

function draw(shape: Shape, className: string, size: number) {
  return createElement(
    'svg',
    {
      className,
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
      focusable: false,
    },
    ...shape.map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs })),
  );
}

/** A meaning icon, always placed beside the words that say the same thing. */
export function Icon({ meaning, size = 18 }: { meaning: Meaning; size?: number }) {
  return draw(MEANINGS[meaning].shape, `icon icon-${meaning}`, size);
}

/** A destination icon for the navigation; nothing when the place has none. */
export function PlaceIcon({ place, size = 22 }: { place: string; size?: number }) {
  const shape = PLACES[place];
  return shape ? draw(shape, 'icon icon-place', size) : null;
}
