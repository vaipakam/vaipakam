import { describe, expect, it } from 'vitest';
import { applyFrameAncestors, confirmFrameOrigin, frameState, safeOriginPatterns, type FrameMessage, type FrameWindow } from './safeOrigins';

const SAFE = 'https://app.safe.global';
const HEADERS = "frame-ancestors 'self' __SAFE_APP_ORIGINS__;\nAccess-Control-Allow-Origin: __SAFE_APP_CORS_ORIGIN__";

function win(framed: boolean, ancestors: string[] | undefined) {
  const top = {};
  const parent = { sent: [] as unknown[], postMessage(m: unknown) { this.sent.push(m); } };
  const listeners = new Set<(e: FrameMessage) => void>();
  const w = {
    self: framed ? {} : top,
    top,
    parent,
    location: ancestors === undefined ? {} : { ancestorOrigins: { length: ancestors.length, item: (i: number) => ancestors[i] ?? null } },
    addEventListener: (_: 'message', fn: (e: FrameMessage) => void) => void listeners.add(fn),
    removeEventListener: (_: 'message', fn: (e: FrameMessage) => void) => void listeners.delete(fn),
  } satisfies FrameWindow;
  const deliver = (e: FrameMessage) => listeners.forEach((fn) => fn(e));
  return { w, parent, deliver };
}

describe('the Safe origin list', () => {
  it('is exact: the connector matches only the listed origin', () => {
    const [p] = safeOriginPatterns();
    expect(p!.test(SAFE)).toBe(true);
    expect(p!.test('https://evil.app.safe.global')).toBe(false);
    expect(p!.test('https://app.safe.global.evil.example')).toBe(false);
    expect(p!.test('https://app-safe.global')).toBe(false);
    expect(p!.test('http://app.safe.global')).toBe(false);
  });
  it('fails the build on a wildcard or an http entry', () => {
    expect(() => applyFrameAncestors(HEADERS, ['https://*.safe.global'])).toThrow();
    expect(() => applyFrameAncestors(HEADERS, ['http://app.safe.global'])).toThrow();
  });
  it('writes both headers from the list and fails the build without a placeholder', () => {
    expect(applyFrameAncestors(HEADERS)).toBe(`frame-ancestors 'self' ${SAFE};\nAccess-Control-Allow-Origin: ${SAFE}`);
    expect(() => applyFrameAncestors("frame-ancestors 'self';\nAccess-Control-Allow-Origin: __SAFE_APP_CORS_ORIGIN__")).toThrow();
    expect(() => applyFrameAncestors("frame-ancestors 'self' __SAFE_APP_ORIGINS__;")).toThrow();
  });
});

describe('frameState', () => {
  it('is top when not framed', () => expect(frameState(win(false, []).w)).toBe('top'));
  it('mounts under a frame whose every ancestor is listed', () => expect(frameState(win(true, [SAFE]).w)).toBe('allowed'));
  it('refuses a subdomain, a look-alike or any unlisted ancestor', () => {
    expect(frameState(win(true, ['https://evil.app.safe.global']).w)).toBe('refused');
    expect(frameState(win(true, ['https://app.safe.global.evil.example']).w)).toBe('refused');
    expect(frameState(win(true, [SAFE, 'https://evil.example']).w)).toBe('refused');
  });
  it('stays unconfirmed when the browser hides the ancestors', () => expect(frameState(win(true, undefined).w)).toBe('unconfirmed'));
});

describe('confirmFrameOrigin', () => {
  it('resolves only on a successful answer from the parent at a listed origin', async () => {
    const { w, parent, deliver } = win(true, undefined);
    let done = false;
    const p = confirmFrameOrigin(w, 'h1').then(() => (done = true));
    expect(parent.sent).toHaveLength(1);
    deliver({ origin: 'https://evil.app.safe.global', source: parent, data: { id: 'h1', success: true } });
    deliver({ origin: SAFE, source: {}, data: { id: 'h1', success: true } });
    deliver({ origin: SAFE, source: parent, data: { id: 'other', success: true } });
    deliver({ origin: SAFE, source: parent, data: { id: 'h1', success: false } });
    await Promise.resolve();
    expect(done).toBe(false);
    deliver({ origin: SAFE, source: parent, data: { id: 'h1', success: true } });
    await p;
    expect(done).toBe(true);
  });
});
