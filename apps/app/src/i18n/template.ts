/**
 * Shared walk used by the en.json template exporter
 * (`scripts/export-i18n-template.ts`) and its vitest drift check —
 * one implementation so the two can't disagree about what counts as
 * a translatable leaf.
 *
 * Keeps string leaves (including array elements, under their numeric
 * keys), recurses into objects/arrays, and emits `tmpl(...)` entries
 * as their raw `{{}}` template — with the full CLDR plural-category
 * sibling set when the entry is a count-plural (so many-category locales
 * like Arabic have every form to fill). PLAIN functions (not yet
 * migrated to `tmpl`) are still dropped (not translatable), along with
 * any branch that ends up empty after the drop.
 */
import { isTmpl, TMPL } from './tmpl';

export type TemplateNode =
  | string
  | { [key: string]: TemplateNode }
  | TemplateNode[];

/** The full CLDR plural-category set, `other` last. English uses only
 *  `one` / `other`, but a supported locale (Arabic) uses all six, so a
 *  count template must expose EVERY category as a fill slot — otherwise a
 *  regenerated `ar.json` has no `_zero` / `_two` / `_few` / `_many` keys
 *  and i18next silently falls back to the English `_other` for those
 *  counts (Codex #1345 r5). Emitting the widest set is a safe superset:
 *  a locale that doesn't use a category never requests its key, and
 *  English at runtime reads copy.ts, not this template. */
const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;

/** Emit a `tmpl` entry's key(s) into the parent object. A simple
 *  template lands under `key`; a count-plural lands as the i18next
 *  per-category sibling set the locale bundles mirror — categories the
 *  English metadata doesn't define fall back to the base template as a
 *  translator placeholder (so ar/etc. have every form to localize). */
function emitTmpl(
  out: { [key: string]: TemplateNode },
  key: string,
  meta: {
    template: string;
    plurals?: Partial<Record<'zero' | 'one' | 'two' | 'few' | 'many', string>>;
  },
): void {
  if (meta.plurals) {
    for (const cat of PLURAL_CATEGORIES) {
      out[`${key}_${cat}`] =
        cat === 'other' ? meta.template : (meta.plurals[cat] ?? meta.template);
    }
  } else {
    out[key] = meta.template;
  }
}

export function buildTemplate(node: unknown): TemplateNode | undefined {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) {
    const items = node
      .map((item) => buildTemplate(item))
      .filter((item): item is TemplateNode => item !== undefined);
    return items.length > 0 ? items : undefined;
  }
  if (node !== null && typeof node === 'object') {
    const out: { [key: string]: TemplateNode } = {};
    for (const [key, value] of Object.entries(node)) {
      if (isTmpl(value)) {
        emitTmpl(out, key, value[TMPL]);
        continue;
      }
      const built = buildTemplate(value);
      if (built !== undefined) out[key] = built;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  // Plain functions, numbers, booleans — not translatable leaves.
  return undefined;
}
