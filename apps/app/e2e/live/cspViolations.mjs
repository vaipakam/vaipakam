/**
 * Content-policy violations seen by a live drive (#43 / ET-017).
 *
 * The connected app's `connect-src` is narrowed in two steps: the narrow
 * list is first sent as a REPORT-ONLY policy, so a request outside it is
 * reported and still made, and it is enforced only once a deployed build
 * has been driven clean under it. "Driven clean" has to be a verdict, not
 * a reading of the console: a report-only refusal changes nothing the page
 * does, so a drive that only checks what the page does passes over it.
 *
 * So every browser context a drive opens carries one listener for the
 * document's `securitypolicyviolation` event, which the browser fires for
 * an enforced refusal and for a report-only one alike, and every report
 * reaches this process through a binding. The driver applies the verdict
 * at process exit, once for every drive (`driver.mjs`): any violation
 * turns a PASS or a BLOCKED into a FAIL that names it. That is how a host
 * missing from the narrow list is found before the list can block it.
 *
 * The event, not the console message, is the signal: its fields say which
 * directive refused what and under which disposition, where the console
 * text is a sentence whose wording the browser may change.
 *
 * What it cannot see, stated: a request made from a service worker (it
 * has no document), and a report the page fires in the instant before the
 * browser closes, whose binding call is cut off.
 */

/** The binding the page reports through. */
export const CSP_VIOLATION_BINDING = '__vaipakamCspViolation';

/**
 * Install the watch on a browser context: every page opened in it, and
 * every navigation, reports its violations to `record`.
 *
 * @param {import('@playwright/test').BrowserContext} ctx
 * @param {(v: CspViolation) => void} record
 */
export async function installCspViolationWatch(ctx, record) {
  await ctx.exposeBinding(CSP_VIOLATION_BINDING, (_source, v) => record(v));
  await ctx.addInitScript((binding) => {
    document.addEventListener('securitypolicyviolation', (e) => {
      const report = window[binding];
      if (typeof report !== 'function') return;
      void report({
        directive: e.effectiveDirective,
        blocked: e.blockedURI,
        disposition: e.disposition,
        page: location.pathname,
      });
    });
  }, CSP_VIOLATION_BINDING);
}

/**
 * @typedef {{ directive: string, blocked: string, disposition: string, page: string }} CspViolation
 */

/** One line naming a violation. */
export function describeViolation(v) {
  const how = v.disposition === 'report' ? 'reported (report-only)' : 'refused';
  return `${v.directive} ${how} ${v.blocked || '(inline)'} on ${v.page}`;
}

/**
 * The exit verdict for a drive that saw `violations`.
 *
 * `null` when there are none. Otherwise a FAIL (1): a PASS reached with a
 * violation on the page did not show the build clean, and a BLOCKED one
 * had already seen a finding, which outranks the block. A FAIL code
 * stands as it is, with the violations named beside it. Each distinct
 * violation is named once, however many routes or reloads repeated it.
 *
 * @param {number} code
 * @param {CspViolation[]} violations
 * @returns {null | { code: number, message: string }}
 */
export function cspViolationVerdict(code, violations) {
  if (violations.length === 0) return null;
  const lines = [...new Set(violations.map(describeViolation))];
  const body = lines.map((l) => `  - ${l}`).join('\n');
  if (code === 1) {
    return { code: 1, message: `\n(the page also reported content-policy violations:\n${body})` };
  }
  const was = code === 0 ? 'PASS' : `exit ${code}`;
  return {
    code: 1,
    message:
      `\nFAIL: the page reported content-policy violations (the drive's own ${was} is withdrawn):\n${body}` +
      '\n  A report-only line here is a host the narrow connect-src would refuse once enforced.',
  };
}
