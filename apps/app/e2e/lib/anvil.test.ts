/**
 * `childHasExited` decides whether a PID stays in the teardown list.
 *
 * The fork-usability probe and its error classifier (#1979) were tested here
 * too; they went with the fork itself in #2334, since the e2e chain no longer
 * has an upstream RPC to fail.
 */
import { describe, expect, it } from 'vitest';
import { childHasExited } from './anvil';

describe('childHasExited', () => {
  // Decides whether a PID is dropped from the teardown list. The
  // dangerous direction is claiming a LIVE child is dead — its PID
  // leaves the file, teardown never kills it, and the orphan squats the
  // port for every later run. The other mistake costs a stale signal
  // that lands on ESRCH.
  it('reports a running child as running', () => {
    expect(childHasExited({ exitCode: null, signalCode: null })).toBe(false);
  });

  it('reports an exited child, by code or by signal', () => {
    expect(childHasExited({ exitCode: 0, signalCode: null })).toBe(true);
    expect(childHasExited({ exitCode: 1, signalCode: null })).toBe(true);
    expect(childHasExited({ exitCode: null, signalCode: 'SIGKILL' })).toBe(true);
  });

  it('treats exit code 0 as exited — not as a falsy \u201cno code\u201d', () => {
    // The obvious `if (child.exitCode)` spelling reads a clean exit as
    // still-running, which is precisely the dangerous direction.
    expect(childHasExited({ exitCode: 0, signalCode: null })).toBe(true);
  });
});
