/**
 * Types for `visibility.mjs`, so the TypeScript fixture suite
 * (`e2e/tests/31-observer-visibility.spec.ts`) can import the one
 * predicate definition instead of slicing the drive's source (#2102).
 */

/** The helper family an evaluate body receives as `V`. Browser-side. */
export interface VisibilityHelpers {
  notClipped: (node: Element | null) => boolean;
  paintsText: (node: Element | null) => boolean;
  shownBox: (node: Element | null) => boolean;
  visible: (node: Element | null) => boolean;
  /** The text the lender can read under `root`. The unresolved-generated
   *  flag rides on the function (round 116). */
  visibleTextOf: ((root: Element | null) => string) & {
    sawUnresolvedGenerated?: boolean;
  };
}

/** Defines the helpers. Runs in the browser; never call it in Node. */
export function visibilityHelpers(): VisibilityHelpers;

/**
 * Compose an evaluate body with the helpers into a plain function for
 * `page.evaluate` / `locator.evaluate` / `page.waitForFunction`. The
 * composition happens in Node; the page runs plain code.
 */
export function withVisibility<A = unknown, B = unknown, R = unknown>(
  body: (V: VisibilityHelpers, a: A, b: B) => R,
): (a: A, b: B) => R;

/** `visibilityHelpers`'s source text: `(${VISIBILITY_SOURCE})()` yields the family. */
export const VISIBILITY_SOURCE: string;
