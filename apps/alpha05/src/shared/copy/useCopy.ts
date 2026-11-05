/**
 * The copy catalog reached through i18next (RB-A11Y): every entry in
 * `src/content/copy.ts` is addressed by its dotted key, English is the
 * entry's own text (passed as the default value, so there is no second
 * English catalog to drift), and a locale bundle overrides per key. A
 * component never holds a string of its own: it names a key, and the help
 * panel renders the tier-C explanation from the same key its tier-B summary
 * uses (RB-HELP).
 */
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { copy } from '../../content/copy';
import type { Copy } from './tiers';

type Catalog = { readonly [k: string]: Copy | Catalog };

type DotPaths<T> = {
  [K in keyof T & string]: T[K] extends Copy ? K : T[K] extends Catalog ? `${K}.${DotPaths<T[K]>}` : never;
}[keyof T & string];

/** Every key the catalog declares, as a dotted path (`shell.modeBasic`). */
export type CopyKey = DotPaths<typeof copy>;

function isCopy(v: Copy | Catalog): v is Copy {
  return typeof (v as Copy).tier === 'string' && typeof (v as Copy).text === 'string';
}

/** The catalog entry at `key`, in English. Throws on a key the catalog does
 *  not declare: a typo is a programming error, not a blank line. */
export function copyEntry(key: CopyKey): Copy {
  let node: Copy | Catalog = copy;
  for (const part of key.split('.')) {
    if (isCopy(node) || !(part in node)) throw new Error(`copy: no entry at "${key}"`);
    node = node[part]!;
  }
  if (!isCopy(node)) throw new Error(`copy: "${key}" is a group, not an entry`);
  return node;
}

export interface CopyAccess {
  /** The entry's text in the active language (English when untranslated). */
  text: (key: CopyKey) => string;
  /** The entry's text with its `{{name}}` placeholders filled. A value is
   *  inserted verbatim (never escaped): it is a figure, a name or an
   *  address, rendered as text by React, never as markup. */
  format: (key: CopyKey, vars: Readonly<Record<string, string>>) => string;
  /** The entry with its text translated; tier and guide anchor unchanged. */
  entry: (key: CopyKey) => Copy;
}

export function useCopy(): CopyAccess {
  const { t } = useTranslation();
  const text = useCallback((key: CopyKey) => t(key, { defaultValue: copyEntry(key).text }), [t]);
  const format = useCallback(
    (key: CopyKey, vars: Readonly<Record<string, string>>) => t(key, { defaultValue: copyEntry(key).text, interpolation: { escapeValue: false }, ...vars }),
    [t],
  );
  const entry = useCallback((key: CopyKey) => ({ ...copyEntry(key), text: text(key) }), [text]);
  return { text, format, entry };
}
