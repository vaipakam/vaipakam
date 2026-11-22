import { describe, expect, it } from 'vitest';
import { alertMessages, delivered, dueAlerts, MAX_PENDING, parseAlertState, REPEAT_SECONDS } from '../src/alerts';
import { ALERT_MESSAGE_CHARS } from '../src/pass';
import type { Finding } from '../src/pass';

const alert = (key: string, text = key): Finding => ({ chainId: 84532, level: 'alert', key, text });

describe('operator alert state', () => {
  it('keeps a one-shot alert pending across runs until a message carrying it is accepted', () => {
    const empty = parseAlertState(undefined);
    // Run 1 raises a one-shot alert; the chat is down, so nothing is delivered.
    const r1 = dueAlerts(empty, [alert('audit-missed-0xab')], 1000);
    expect(r1.due.map((a) => a.key)).toEqual(['audit-missed-0xab']);
    const stored = parseAlertState(JSON.stringify(r1.state));
    // Run 2 does not raise it again, but it is still due.
    const r2 = dueAlerts(stored, [], 1300);
    expect(r2.due.map((a) => a.key)).toEqual(['audit-missed-0xab']);
    // Delivered now: it leaves the pending list.
    const after = delivered(r2.state, r2.due, 1300, false);
    expect(after.pending).toEqual([]);
    expect(dueAlerts(after, [], 1600).due).toEqual([]);
  });

  it('repeats a standing condition only every REPEAT_SECONDS, and forgets one that cleared', () => {
    let s = delivered(dueAlerts(parseAlertState(undefined), [alert('behind')], 0).state, [alert('behind')], 0, false);
    expect(dueAlerts(s, [alert('behind')], REPEAT_SECONDS - 1).due).toEqual([]);
    expect(dueAlerts(s, [alert('behind')], REPEAT_SECONDS).due.map((a) => a.key)).toEqual(['behind']);
    s = dueAlerts(s, [], 10).state; // cleared
    expect(dueAlerts(s, [alert('behind')], 20).due.map((a) => a.key)).toEqual(['behind']);
  });

  it('keeps at most MAX_PENDING undelivered alerts, oldest giving way, and counts the dropped ones until reported', () => {
    const many = Array.from({ length: MAX_PENDING + 5 }, (_, i) => alert(`k${i}`));
    const r = dueAlerts(parseAlertState(undefined), many, 1);
    expect(r.due).toHaveLength(MAX_PENDING);
    expect(r.due[0]!.key).toBe('k5');
    expect(r.state.dropped).toBe(5);
    expect(delivered(r.state, r.due.slice(0, 1), 2, false).dropped).toBe(5);
    expect(delivered(r.state, r.due.slice(0, 1), 2, true).dropped).toBe(0);
  });

  it('reads the older stored shape (a bare map of delivery times)', () => {
    const s = parseAlertState(JSON.stringify({ '84532:behind': 100 }));
    expect(s).toEqual({ sent: { '84532:behind': 100 }, pending: [], dropped: 0 });
    expect(parseAlertState('not json')).toEqual({ sent: {}, pending: [], dropped: 0 });
  });

  it('sizes messages with the dropped-alert report counted, so none exceeds the chat limit', () => {
    const due = [alert('a', 'a'.repeat(3500)), alert('b', 'b'.repeat(470))];
    const msgs = alertMessages(due, 7);
    expect(msgs[0]!.reportsDropped).toBe(true);
    expect(msgs[0]!.text).toContain('7 earlier alert(s)');
    for (const m of msgs) expect(m.text.length).toBeLessThanOrEqual(ALERT_MESSAGE_CHARS);
    expect(msgs.flatMap((m) => m.batch.map((a) => a.key))).toEqual(['a', 'b']);
    expect(msgs.slice(1).every((m) => !m.reportsDropped && !m.text.includes('earlier alert'))).toBe(true);
  });
});
