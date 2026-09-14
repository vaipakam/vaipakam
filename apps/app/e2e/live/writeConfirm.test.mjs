import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import { describe, it, expect } from 'vitest';
import { confirmWrite, confirmWriteOrReport, unconfirmedWhy } from './writeConfirm.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The three answers are the point of the module, so each one is pinned
 * here — including the distinction the bug in #2107 collapsed: a state
 * that is WRONG and a state nobody would tell us about are not the same
 * result and must not produce the same verdict.
 */

/** A fake clock: `now` advances only when `sleep` is called, so a test
 *  can exhaust a deadline deterministically without waiting. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
}

const base = (over = {}) => ({
  minBlock: 100n,
  accept: (v) => v === 'done',
  timeoutMs: 30,
  everyMs: 10,
  ...fakeClock(),
  ...over,
});

describe('confirmWrite', () => {
  it('confirms when a node at or after the write answers acceptably', async () => {
    const r = await confirmWrite(
      base({ getBlockNumber: async () => 101n, read: async () => 'done' }),
    );
    expect(r.ok).toBe(true);
    expect(r.blockNumber).toBe(101n);
  });

  it('pins the read to the head it checked, not to some later block', async () => {
    const seen = [];
    // The head is deliberately ABOVE minBlock, so a read pinned to the
    // head and one pinned to minBlock are distinguishable. With the two
    // equal this assertion cannot tell them apart, and reading at
    // minBlock is the wrong one: a node whose head is 105 need not
    // still serve state at 100 on a pruning backend.
    await confirmWrite(
      base({
        minBlock: 100n,
        getBlockNumber: async () => 105n,
        read: async (bn) => {
          seen.push(bn);
          return 'done';
        },
      }),
    );
    expect(seen).toEqual([105n]);
  });

  it('reports a wrong value as a DEFECT, not as unconfirmed', async () => {
    const r = await confirmWrite(
      base({ getBlockNumber: async () => 100n, read: async () => 'still-open' }),
    );
    expect(r.ok).toBe(false);
    expect(r.unconfirmed).toBe(false);
    expect(r.value).toBe('still-open');
  });

  it('does NOT poll a wrong value through — one read decides it', async () => {
    // The chain at or after the write's own block is settled, so a
    // second look is not a second chance. If this ever starts retrying,
    // the helper has become a way to wait out real defects.
    let reads = 0;
    const r = await confirmWrite(
      base({
        getBlockNumber: async () => 100n,
        read: async () => {
          reads += 1;
          return reads > 1 ? 'done' : 'still-open';
        },
      }),
    );
    expect(reads).toBe(1);
    expect(r.ok).toBe(false);
    expect(r.unconfirmed).toBe(false);
  });

  it('retries past a node whose head is behind the write', async () => {
    // This is the #2107 race itself: the first node has not applied the
    // block the receipt came from. It must not answer.
    const heads = [98n, 99n, 101n];
    let i = 0;
    const readAt = [];
    const r = await confirmWrite(
      base({
        getBlockNumber: async () => heads[i++],
        read: async (bn) => {
          readAt.push(bn);
          return 'done';
        },
      }),
    );
    expect(r.ok).toBe(true);
    // The stale nodes were never read from — that is what stops the
    // pre-write value being mistaken for the post-write one.
    expect(readAt).toEqual([101n]);
  });

  it('retries a read that throws, and confirms on a later attempt', async () => {
    let calls = 0;
    const r = await confirmWrite(
      base({
        getBlockNumber: async () => 100n,
        read: async () => {
          calls += 1;
          if (calls === 1) throw new Error('header not found');
          return 'done';
        },
      }),
    );
    expect(r.ok).toBe(true);
  });

  it('returns UNCONFIRMED when no node ever reaches the block', async () => {
    const r = await confirmWrite(
      base({
        getBlockNumber: async () => 99n,
        read: async () => {
          throw new Error('must not be read from a stale node');
        },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.unconfirmed).toBe(true);
    expect(r.why).toMatch(/COULD NOT CONFIRM/);
    // The message must not be readable as a claim about the chain.
    expect(r.why).toMatch(/says nothing about whether the write took effect/);
  });

  it('returns UNCONFIRMED when every read errors', async () => {
    const r = await confirmWrite(
      base({
        getBlockNumber: async () => 100n,
        read: async () => {
          throw new Error('rate limited');
        },
      }),
    );
    expect(r.unconfirmed).toBe(true);
    expect(r.why).toMatch(/rate limited/);
  });

  it('lets a throwing predicate propagate rather than blaming the endpoint', async () => {
    // A predicate that throws is a bug in the caller — a field that
    // moved, a shape it did not expect. Retrying it to the deadline and
    // then reporting "no node would answer" would report the drive's own
    // mistake as an infrastructure problem.
    await expect(
      confirmWrite(
        base({
          getBlockNumber: async () => 100n,
          read: async () => ({}),
          accept: (v) => v.missing.field === 1,
        }),
      ),
    ).rejects.toThrow(TypeError);
  });

  it('propagates a failure the classifier calls deterministic', async () => {
    // A getter that reverted fails identically on every node, so
    // retrying it to the deadline and reporting "no node would answer"
    // would blame the endpoint for a contract or ABI regression.
    const revert = new Error('execution reverted');
    await expect(
      confirmWrite(
        base({
          getBlockNumber: async () => 100n,
          read: async () => {
            throw revert;
          },
          retryable: (e) => e !== revert,
        }),
      ),
    ).rejects.toThrow('execution reverted');
  });

  it('still retries a failure the classifier calls retryable', async () => {
    let calls = 0;
    const r = await confirmWrite(
      base({
        getBlockNumber: async () => 100n,
        read: async () => {
          calls += 1;
          if (calls === 1) throw new Error('socket hang up');
          return 'done';
        },
        retryable: () => true,
      }),
    );
    expect(r.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('retries everything when no classifier is supplied', async () => {
    // The default must not tighten behaviour behind a caller's back —
    // an unrecognised error is no worse off than before the classifier
    // existed.
    const r = await confirmWrite(
      base({
        getBlockNumber: async () => 100n,
        read: async () => {
          throw new Error('execution reverted');
        },
      }),
    );
    expect(r.unconfirmed).toBe(true);
  });

  it('asks once even with no budget at all', async () => {
    let asked = 0;
    const r = await confirmWrite(
      base({
        timeoutMs: 0,
        getBlockNumber: async () => {
          asked += 1;
          return 100n;
        },
        read: async () => 'done',
      }),
    );
    expect(asked).toBe(1);
    expect(r.ok).toBe(true);
  });

  it('never starts an attempt after the deadline', async () => {
    // The wait used to be a full `everyMs` regardless of what was left,
    // so a loop could sleep past the deadline and then run a whole
    // further attempt. viem's HTTP transport times out at 10 s and
    // retries, so that attempt can carry a nominal 90 s confirmation
    // tens of seconds beyond it — or return a success the caller was
    // told could not arrive that late (#2107 round 2).
    const attemptsAt = [];
    const clock = fakeClock();
    await confirmWrite({
      minBlock: 100n,
      accept: () => false,
      timeoutMs: 25,
      everyMs: 10,
      ...clock,
      getBlockNumber: async () => {
        attemptsAt.push(clock.now());
        return 99n; // always behind, so the loop runs to the deadline
      },
    });
    expect(attemptsAt.every((t) => t < 25)).toBe(true);
    expect(clock.now()).toBeLessThanOrEqual(25);
  });

  it('caps the final wait to what is left of the budget', async () => {
    const clock = fakeClock();
    await confirmWrite({
      minBlock: 100n,
      accept: () => false,
      timeoutMs: 25, // not a multiple of everyMs, so the cap has to bite
      everyMs: 10,
      ...clock,
      getBlockNumber: async () => 99n,
    });
    // 10 + 10 + 5 — the last wait trimmed rather than overshooting to 30.
    expect(clock.now()).toBe(25);
  });

  it('decodes OUTSIDE the retry — a decode failure is never waited out', async () => {
    // Rounds 2 and 3 each produced another viem error class for a reply
    // that arrived and would not decode. Classifying that set is
    // unbounded; taking decoding out of the retry makes "never worth a
    // retry" true by construction, so this is the assertion that
    // replaces the list.
    let reads = 0;
    await expect(
      confirmWrite(
        base({
          getBlockNumber: async () => 100n,
          read: async () => {
            reads += 1;
            return '0xdeadbeef';
          },
          decode: () => {
            throw new Error('InvalidBytesBooleanError: bytes are not canonical');
          },
          // Even told that EVERYTHING is retryable, the decode must not be.
          retryable: () => true,
        }),
      ),
    ).rejects.toThrow(/InvalidBytesBooleanError/);
    expect(reads).toBe(1);
  });

  it('hands the decoded value to accept, not the raw reply', async () => {
    const seen = [];
    const r = await confirmWrite(
      base({
        getBlockNumber: async () => 100n,
        read: async () => '0x64',
        decode: (raw) => BigInt(raw),
        accept: (v) => {
          seen.push(v);
          return v === 100n;
        },
      }),
    );
    expect(seen).toEqual([100n]);
    expect(r.ok).toBe(true);
    expect(r.value).toBe(100n);
  });

  it('bounds an attempt that is already in flight when the deadline passes', async () => {
    // Gating the START of an attempt is not enough: `getBlockNumber` can
    // consume its own transport timeout and retries, and `read` then
    // begins after the deadline (#2107 round 3). The whole attempt races
    // the remaining budget.
    let readStarted = false;
    const r = await confirmWrite(
      base({
        timeoutMs: 50,
        // A budget timer that fires immediately, standing in for an
        // attempt that outlives the deadline.
        deadlineTimer: () => ({ promise: Promise.resolve(), cancel: () => {} }),
        getBlockNumber: () => new Promise(() => {}), // never settles
        read: async () => {
          readStarted = true;
          return 'done';
        },
      }),
    );
    expect(r.unconfirmed).toBe(true);
    expect(readStarted).toBe(false);
  });

  it('does not let a late result win after the budget fired', async () => {
    // The attempt resolves, but only after the timer did. Its answer
    // must not be returned as though it arrived in time.
    const r = await confirmWrite(
      base({
        timeoutMs: 50,
        deadlineTimer: () => ({ promise: Promise.resolve(), cancel: () => {} }),
        getBlockNumber: async () => {
          await new Promise((res) => setTimeout(res, 5));
          return 100n;
        },
        read: async () => 'done',
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.unconfirmed).toBe(true);
  });

  it('cancels the budget timer when an attempt wins the race', async () => {
    // A timer left running holds the process open, which in a live drive
    // is a hang at exit rather than a visible failure.
    let cancelled = 0;
    await confirmWrite(
      base({
        deadlineTimer: () => ({ promise: new Promise(() => {}), cancel: () => { cancelled += 1; } }),
        getBlockNumber: async () => 100n,
        read: async () => 'done',
      }),
    );
    expect(cancelled).toBe(1);
  });

  it('gives up rather than looping forever', async () => {
    let asked = 0;
    const r = await confirmWrite(
      base({
        timeoutMs: 100,
        everyMs: 10,
        getBlockNumber: async () => {
          asked += 1;
          return 1n;
        },
      }),
    );
    expect(r.unconfirmed).toBe(true);
    expect(asked).toBeGreaterThan(1);
    expect(asked).toBeLessThan(50);
  });
});

describe('unconfirmedWhy', () => {
  it('names a stale-node run and an erroring run differently', () => {
    const stale = unconfirmedWhy({ what: 'x', minBlock: 7n, behind: 3, lastErr: null, timeoutMs: 1000 });
    const erroring = unconfirmedWhy({
      what: 'x',
      minBlock: 7n,
      behind: 0,
      lastErr: new Error('boom'),
      timeoutMs: 1000,
    });
    expect(stale).toMatch(/3 attempts reached a node still behind/);
    expect(erroring).toMatch(/last error: boom/);
    expect(stale).not.toEqual(erroring);
  });

  it('reports BOTH causes when a run hit both', () => {
    const s = unconfirmedWhy({
      what: 'x',
      minBlock: 7n,
      behind: 2,
      lastErr: new Error('boom'),
      timeoutMs: 1000,
    });
    expect(s).toMatch(/behind/);
    expect(s).toMatch(/boom/);
  });

  it('keeps a multi-line error to its first line', () => {
    const s = unconfirmedWhy({
      what: 'x',
      minBlock: 7n,
      behind: 0,
      lastErr: new Error('short reason\nstack frame\nstack frame'),
      timeoutMs: 1000,
    });
    expect(s).toMatch(/short reason/);
    expect(s).not.toMatch(/stack frame/);
  });
});

describe('confirmWriteOrReport', () => {
  it('turns a failure of the confirmation itself into the unconfirmed verdict', async () => {
    // Every call site sits inside a cleanup catch that says the position
    // may still rest and tells the operator to send the cancel again. A
    // throw reaching that catch re-creates the false funds alarm this PR
    // removes, by a longer route (#2107 round 2).
    const r = await confirmWriteOrReport(
      base({
        what: 'the fill ledger',
        getBlockNumber: async () => 100n,
        read: async () => {
          throw new Error('execution reverted: FunctionDoesNotExist');
        },
        retryable: () => false,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.unconfirmed).toBe(true);
    // The error is NAMED, not swallowed — that is what makes this more
    // informative than the catch it replaces, not less.
    expect(r.why).toMatch(/FunctionDoesNotExist/);
    expect(r.why).toMatch(/THE CONFIRMATION ITSELF FAILED/);
    expect(r.why).toMatch(/the fill ledger/);
    // And it must not read as a claim that the write did not happen.
    expect(r.why).toMatch(/receipt already reported as mined and successful/);
  });

  it('reports a predicate bug the same way rather than crashing the cleanup', async () => {
    const r = await confirmWriteOrReport(
      base({
        getBlockNumber: async () => 100n,
        read: async () => ({}),
        accept: (v) => v.missing.field === 1,
      }),
    );
    expect(r.unconfirmed).toBe(true);
    expect(r.why).toMatch(/THE CONFIRMATION ITSELF FAILED/);
  });

  it('passes every other verdict through untouched', async () => {
    const ok = await confirmWriteOrReport(
      base({ getBlockNumber: async () => 100n, read: async () => 'done' }),
    );
    expect(ok.ok).toBe(true);
    const wrong = await confirmWriteOrReport(
      base({ getBlockNumber: async () => 100n, read: async () => 'still-open' }),
    );
    expect(wrong.ok).toBe(false);
    expect(wrong.unconfirmed).toBe(false);
    expect(wrong.value).toBe('still-open');
  });
});

/**
 * The `cacheTime: 0` on every head read is invisible in behaviour — a
 * cached head produces a plausible UNCONFIRMED rather than an error —
 * so nothing would notice it being dropped. This asks the tree instead
 * of the runtime (#2107 round 1 P2).
 */
describe('every confirmWrite call site reads a fresh head', () => {
  const walk = (n, fn) => {
    if (!n || typeof n.type !== 'string') return;
    fn(n);
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => walk(c, fn));
      else if (v && typeof v.type === 'string') walk(v, fn);
    }
  };
  const named = (p) =>
    p.type === 'Property' && !p.computed
      ? p.key.type === 'Identifier'
        ? p.key.name
        : p.key.value
      : null;

  /** Every `confirmWrite({ … })` in the live directory, by file. */
  function confirmWriteCalls() {
    const found = [];
    for (const f of fs.readdirSync(HERE).filter((n) => n.endsWith('.mjs'))) {
      if (f.startsWith('writeConfirm')) continue; // the module and its own suite
      const src = fs.readFileSync(path.join(HERE, f), 'utf8');
      let ast;
      try {
        ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' });
      } catch {
        continue; // a file this suite cannot parse is not this test's subject
      }
      walk(ast, (n) => {
        if (n.type !== 'CallExpression') return;
        // Either entry point: a drive uses the reporting wrapper, but a
        // future caller outside a funds-alarm catch may use the raw one,
        // and both take the same options object.
        if (n.callee.type !== 'Identifier') return;
        if (n.callee.name !== 'confirmWrite' && n.callee.name !== 'confirmWriteOrReport') return;
        found.push({ file: f, arg: n.arguments[0] });
      });
    }
    return found;
  }

  it('finds the call sites at all', () => {
    // An empty set would satisfy every assertion below by accident.
    const calls = confirmWriteCalls();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect([...new Set(calls.map((c) => c.file))].sort()).toEqual([
      'live-rate-desk.mjs',
      'live-signed-book.mjs',
    ]);
  });

  it('passes cacheTime: 0 to every head read, and a retryability classifier', () => {
    for (const { file, arg } of confirmWriteCalls()) {
      expect(arg?.type, `${file}: confirmWrite takes an object literal`).toBe('ObjectExpression');

      const getHead = arg.properties.find((p) => named(p) === 'getBlockNumber');
      expect(getHead, `${file}: confirmWrite is given a getBlockNumber`).toBeTruthy();

      let reads = 0;
      let fresh = 0;
      walk(getHead.value, (n) => {
        if (n.type !== 'CallExpression') return;
        const c = n.callee;
        const isHead =
          (c.type === 'MemberExpression' &&
            !c.computed &&
            c.property.type === 'Identifier' &&
            c.property.name === 'getBlockNumber') ||
          (c.type === 'Identifier' && c.name === 'getBlockNumber');
        if (!isHead) return;
        reads += 1;
        const opts = n.arguments[0];
        if (opts?.type !== 'ObjectExpression') return;
        const ct = opts.properties.find((p) => named(p) === 'cacheTime');
        if (ct?.value.type === 'Literal' && ct.value.value === 0) fresh += 1;
      });
      expect(reads, `${file}: getBlockNumber actually reads a head`).toBeGreaterThan(0);
      expect(fresh, `${file}: every head read passes cacheTime: 0`).toBe(reads);

      // viem caches this action for the client's pollingInterval, which
      // is LONGER than the retry interval, so consecutive attempts would
      // reuse one answer. Without the classifier, a reverting getter is
      // retried to the deadline and reported as an endpoint problem.
      const retryable = arg.properties.find((p) => named(p) === 'retryable');
      expect(retryable, `${file}: confirmWrite is given a retryable classifier`).toBeTruthy();
    }
  });
});
