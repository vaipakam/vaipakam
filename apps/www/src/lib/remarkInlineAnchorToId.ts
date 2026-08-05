/**
 * Remark plugin: turn a guide file's inline `<a id="…"></a>` marker
 * into the following heading's id.
 *
 * SHARED by every long-form documentation page — User Guide, Overview,
 * Whitepaper — not just the guide it was written for. The two id
 * schemes those pages carry serve different readers and only one of
 * them survives translation:
 *
 *  - The heading SLUG (derived from the heading's own words) is what
 *    the page's in-page contents list links to. It changes when the
 *    heading is translated, which is fine — the TOC is generated from
 *    the same translated text.
 *  - The hand-authored ANCHOR is what links arriving from OUTSIDE
 *    target, including the connected app's recovery declaration, which
 *    asks the user to attest they have read a named guide section. It
 *    is identical in every localized edition, which is the whole point.
 *
 * Living in UserGuide.tsx meant Overview and Whitepaper passed only
 * `remarkGfm`, so an author-supplied anchor in either produced nothing
 * at all and the stable-link scheme silently didn't apply there
 * (Codex #1561 r2).
 */
/**
 * The user-guide files attach stable ids to headings via inline HTML
 * anchors of the form `<a id="…"></a>`. CommonMark wraps inline-only
 * HTML tags (and `<a>` is inline-only) inside a `paragraph` node even
 * when the tag sits on its own blank-line-padded line in the source.
 * So `<a id="X"></a>` doesn't become a top-level html block — it ends
 * up nested inside a paragraph as the paragraph's only child.
 *
 * This plugin walks the top-level mdast children. For each one that is
 * either (a) a paragraph whose only child is an `<a id="X"></a>`
 * inline-html node, or (b) the rarer case of a top-level html block
 * containing the anchor, it copies `X` onto `data.hProperties.id` of
 * the next non-anchor heading sibling and removes the anchor node
 * entirely. Subsequent rehype passes turn `data.hProperties.id` into
 * a real `id` attribute on the rendered heading, so deep links land
 * precisely on the heading and no `<a id>` text is ever rendered.
 */
export function remarkInlineAnchorToId() {
  const ANCHOR_RE = /^<a id="([^"]+)"><\/a>\s*$/;

  type Node = {
    type: string;
    value?: string;
    children?: Node[];
    data?: { hProperties?: { id?: string } };
  };

  function readAnchorId(node: Node): string | null {
    // Case A — paragraph wrapping the anchor as inline-html. CommonMark
    // splits `<a id="X"></a>` into two separate inline-html nodes
    // (opening + closing tag) inside the paragraph, so we concatenate
    // all html children before matching. The paragraph must contain
    // ONLY html children — any text would mean the paragraph carries
    // real content and we shouldn't strip it.
    if (
      node.type === 'paragraph' &&
      Array.isArray(node.children) &&
      node.children.length > 0 &&
      node.children.every((c) => c.type === 'html')
    ) {
      const joined = node.children
        .map((c) => c.value ?? '')
        .join('')
        .trim();
      const m = ANCHOR_RE.exec(joined);
      if (m) return m[1];
    }
    // Case B — top-level html block (rare for inline-only `<a>` but
    // possible in some markdown variants).
    if (node.type === 'html' && typeof node.value === 'string') {
      const m = ANCHOR_RE.exec(node.value.trim());
      if (m) return m[1];
    }
    return null;
  }

  return (tree: { children: unknown[] }) => {
    const children = tree.children as Node[];
    if (!Array.isArray(children)) return;
    let i = 0;
    while (i < children.length) {
      const id = readAnchorId(children[i]);
      if (id) {
        // Walk forward looking for the heading this id should land on.
        // Skip any back-to-back anchor-paragraphs (rare but tolerated).
        for (let j = i + 1; j < children.length; j++) {
          const next = children[j];
          if (next.type === 'heading') {
            next.data = next.data ?? {};
            next.data.hProperties = next.data.hProperties ?? {};
            next.data.hProperties.id = id;
            break;
          }
          if (readAnchorId(next) === null) break;
        }
        // Drop the anchor node from the tree and re-check at the same
        // index since splice shifts everything left.
        children.splice(i, 1);
        continue;
      }
      i++;
    }
  };
}
