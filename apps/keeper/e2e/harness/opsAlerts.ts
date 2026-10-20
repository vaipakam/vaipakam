/**
 * What the keeper would have told its operators. A scenario runs with no ops
 * bot configured, so every alert or notice a pass raises is logged as "NOT
 * delivered" (`src/opsAlert.ts`) and nothing leaves the machine; this
 * collects those lines so a scenario can assert on them — a pass that did its
 * job raises no fault alert, and one that moved value states the amounts.
 */
import { vi } from 'vitest';

const MARKER = '[keeper] ops alert NOT delivered';

export interface OpsAlertLog {
  /** The alert texts, in order. */
  readonly texts: string[];
  /** Drop what has been collected so far. */
  clear(): void;
}

export function collectOpsAlerts(): OpsAlertLog {
  const texts: string[] = [];
  const original = console.warn.bind(console);
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (line.startsWith(MARKER)) texts.push(line.slice(line.indexOf('):') + 2).trim());
    original(...args);
  });
  return {
    texts,
    clear() {
      texts.length = 0;
    },
  };
}
