/**
 * Shared walk used by the en.json template exporter
 * (`scripts/export-i18n-template.ts`) and its vitest drift check —
 * one implementation so the two can't disagree about what counts as
 * a translatable leaf.
 *
 * Keeps string leaves (including array elements, under their numeric
 * keys), recurses into objects/arrays, and DROPS function values
 * (parametrized strings — not yet translatable, see
 * reactiveCopy.ts) plus any branch that ends up empty after the
 * drop.
 */

export type TemplateNode =
  | string
  | { [key: string]: TemplateNode }
  | TemplateNode[];

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
      const built = buildTemplate(value);
      if (built !== undefined) out[key] = built;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  // Functions, numbers, booleans — not translatable leaves.
  return undefined;
}
