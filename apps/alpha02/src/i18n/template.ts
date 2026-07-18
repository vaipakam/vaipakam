/**
 * Shared walk used by the en.json template exporter
 * (`scripts/export-i18n-template.ts`) and its vitest drift check —
 * one implementation so the two can't disagree about what counts as
 * a translatable leaf.
 *
 * Keeps string leaves (including array elements, under their numeric
 * keys), recurses into objects/arrays, and emits `tmpl(...)` entries
 * as their raw `{{}}` template — with i18next `_one` / `_other` plural
 * siblings when the entry is a count-plural. PLAIN functions (not yet
 * migrated to `tmpl`) are still dropped (not translatable), along with
 * any branch that ends up empty after the drop.
 */
import { isTmpl, TMPL } from './tmpl';

export type TemplateNode =
  | string
  | { [key: string]: TemplateNode }
  | TemplateNode[];

/** Emit a `tmpl` entry's key(s) into the parent object. A simple
 *  template lands under `key`; a count-plural lands as the i18next
 *  `key_one` / `key_other` sibling pair the locale bundles mirror. */
function emitTmpl(
  out: { [key: string]: TemplateNode },
  key: string,
  meta: { template: string; plurals?: Record<string, string | undefined> },
): void {
  if (meta.plurals) {
    for (const [cat, form] of Object.entries(meta.plurals)) {
      if (form !== undefined) out[`${key}_${cat}`] = form;
    }
    out[`${key}_other`] = meta.template;
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
