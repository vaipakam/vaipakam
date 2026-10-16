/**
 * TEST SUPPORT ONLY — query server-rendered markup by `data-testid`.
 *
 * WHY THIS EXISTS. The app's vitest suite runs in a `node` environment with
 * no DOM library (vitest.config.ts: "no jsdom/React-Testing-Library
 * harness"), and adding one is a dependency change this surface does not
 * warrant. The analytics sections are split into a pure view (props in,
 * markup out) precisely so they can be rendered with
 * `react-dom/server`'s `renderToStaticMarkup` — and that output is
 * well-formed, entity-escaped HTML, which a few dozen lines can walk.
 *
 * Deliberately small: it understands exactly what React's static renderer
 * emits (escaped attribute values, explicit close tags, `/>` for void
 * elements, no comments) and nothing more. It is imported by tests only;
 * nothing in the app bundle references it.
 */
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

interface Node {
  tag: string;
  attrs: Record<string, string>;
  children: (Node | string)[];
}

const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'source', 'track', 'wbr',
]);

const decode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');

function parse(html: string): Node {
  const root: Node = { tag: '#root', attrs: {}, children: [] };
  const stack: Node[] = [root];
  let last = 0;
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/g)) {
    const start = m.index ?? 0;
    if (start > last) {
      stack[stack.length - 1].children.push(decode(html.slice(last, start)));
    }
    last = start + m[0].length;
    const [, closing, tag, rawAttrs, selfClosing] = m;
    if (closing) {
      const top = stack.pop();
      if (!top || top.tag !== tag) {
        throw new Error(`staticMarkup: unbalanced </${tag}>`);
      }
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of rawAttrs.matchAll(/([^\s=/]+)(?:="([^"]*)")?/g)) {
      attrs[a[1]] = decode(a[2] ?? '');
    }
    const node: Node = { tag, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing && !VOID.has(tag)) stack.push(node);
  }
  if (last < html.length) root.children.push(decode(html.slice(last)));
  if (stack.length !== 1) throw new Error('staticMarkup: unclosed element');
  return root;
}

const textOfNode = (n: Node | string): string =>
  typeof n === 'string' ? n : n.children.map(textOfNode).join('');

function find(n: Node, pred: (n: Node) => boolean): Node | null {
  if (pred(n)) return n;
  for (const c of n.children) {
    if (typeof c === 'string') continue;
    const hit = find(c, pred);
    if (hit) return hit;
  }
  return null;
}

function findAll(n: Node, pred: (n: Node) => boolean, out: Node[] = []): Node[] {
  if (pred(n)) out.push(n);
  for (const c of n.children) if (typeof c !== 'string') findAll(c, pred, out);
  return out;
}

/** A rendered element, queried the way the retired suite queried the DOM. */
export interface Rendered {
  /** The raw markup, for negative "appears nowhere" assertions. */
  html: string;
  /** Text content of the whole render. */
  text: string;
  /** Is an element with this test id present? */
  has(testId: string): boolean;
  /** Text content of the element with this test id; throws when absent. */
  textOf(testId: string): string;
  /** An attribute of the element with this test id; throws when absent. */
  attr(testId: string, name: string): string | undefined;
  /** Text content of every element whose `data-testid` matches `re`. */
  textsMatching(re: RegExp): string[];
  /** Is there an element with this tag carrying this class? */
  hasClass(tag: string, cls: string): boolean;
  /** Does any element carry this `id`? */
  hasId(id: string): boolean;
}

export function renderMarkup(el: ReactElement): Rendered {
  const html = renderToStaticMarkup(el);
  const root = parse(html);
  const byId = (id: string) => find(root, (n) => n.attrs['data-testid'] === id);
  const must = (id: string) => {
    const n = byId(id);
    if (!n) throw new Error(`staticMarkup: no element with data-testid="${id}"`);
    return n;
  };
  return {
    html,
    text: textOfNode(root),
    has: (id) => byId(id) !== null,
    textOf: (id) => textOfNode(must(id)),
    attr: (id, name) => must(id).attrs[name],
    textsMatching: (re) =>
      findAll(root, (n) => re.test(n.attrs['data-testid'] ?? '')).map(textOfNode),
    hasClass: (tag, cls) =>
      find(
        root,
        (n) => n.tag === tag && (n.attrs.class ?? '').split(/\s+/).includes(cls),
      ) !== null,
    hasId: (id) => find(root, (n) => n.attrs.id === id) !== null,
  };
}
