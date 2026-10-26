import { describe, expect, it, vi } from 'vitest';
import { callerKey, slotRefusalStatus, takeCallerSlot, takeSlot, type RateLimitBinding } from './rateLimit';

const answer = (success: boolean): RateLimitBinding => ({ limit: async () => ({ success }) });

describe('takeSlot', () => {
  it('is taken only when the binding exists and said yes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await takeSlot(answer(true), 'k')).toBe('taken');
    expect(await takeSlot(answer(false), 'k')).toBe('refused');
    expect(await takeSlot(undefined, 'k')).toBe('unconfigured');
    const throwing: RateLimitBinding = {
      limit: async () => {
        throw new Error('down');
      },
    };
    expect(await takeSlot(throwing, 'k')).toBe('unavailable');
  });
});

describe('slotRefusalStatus', () => {
  it('names each refusal apart, and none as a missing key', () => {
    expect(slotRefusalStatus('taken')).toBeNull();
    expect(slotRefusalStatus('refused')).toEqual({ status: 429, error: 'rate-limited' });
    expect(slotRefusalStatus('refused', 'upstream-quota')).toEqual({ status: 429, error: 'upstream-quota' });
    expect(slotRefusalStatus('unconfigured')).toEqual({ status: 503, error: 'rate-limit-binding-missing' });
    expect(slotRefusalStatus('unavailable')).toEqual({ status: 503, error: 'rate-limit-unavailable' });
    for (const o of ['unconfigured', 'unavailable'] as const) {
      expect(slotRefusalStatus(o)!.error.endsWith('-not-configured')).toBe(false);
    }
  });
});

describe('caller budgets', () => {
  it('key by the client IP, and share one bucket when there is none', async () => {
    const keys: string[] = [];
    const binding: RateLimitBinding = {
      limit: async ({ key }) => {
        keys.push(key);
        return { success: true };
      },
    };
    await takeCallerSlot(new Request('https://w.example/', { headers: { 'CF-Connecting-IP': '203.0.113.9' } }), binding);
    await takeCallerSlot(new Request('https://w.example/'), binding);
    expect(keys).toEqual(['203.0.113.9', 'unknown']);
    expect(callerKey(new Request('https://w.example/'))).toBe('unknown');
  });
});
