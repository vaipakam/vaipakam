import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { SHELL_CACHE_PREFIX, serviceWorkerSource, shellFiles } from './serviceWorkerSource';

type Handler = (event: Record<string, unknown>) => void;

/** Runs the generated worker against a stand-in for the worker's globals. */
function boot(shell: string[], contentType: (url: string) => string = (u) => (u.endsWith('.css') ? 'text/css' : 'text/javascript')) {
  const handlers: Record<string, Handler> = {};
  const stores = new Map<string, Map<string, { body: string }>>([
    [`${SHELL_CACHE_PREFIX}old`, new Map()],
    ['someone-else', new Map()],
  ]);
  const fetched: string[] = [];
  const store = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name)!;
    return { match: async (k: string) => m.get(k), put: async (k: string, v: { body: string }) => void m.set(k, v) };
  };
  const self = {
    location: { origin: 'https://app.example' },
    addEventListener: (type: string, h: Handler) => (handlers[type] = h),
    skipWaiting: () => undefined,
    clients: { claim: async () => undefined },
  };
  const caches = { keys: async () => [...stores.keys()], delete: async (k: string) => stores.delete(k), open: async (k: string) => store(k) };
  const fetch = async (r: { url: string }) => {
    fetched.push(r.url);
    const kind = contentType(r.url);
    return { ok: true, type: 'basic', body: `net:${r.url}`, headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? kind : null) }, clone() { return this; } };
  };
  runInNewContext(serviceWorkerSource('abc123', shell), { self, caches, fetch, URL, Set, Promise });
  /** What the worker answered with, or null when it let the browser go to the network. */
  const request = async (url: string, init: { method?: string; mode?: string } = {}) => {
    const answered: Promise<{ body: string }>[] = [];
    handlers.fetch!({ request: { url, method: init.method ?? 'GET', mode: init.mode ?? 'cors' }, respondWith: (p: Promise<{ body: string }>) => answered.push(p) });
    return answered.length === 0 ? null : (await answered[0]!).body;
  };
  return { handlers, stores, fetched, request };
}

describe('the service worker', () => {
  const shell = shellFiles(['index.html', 'assets/index-1.js', 'assets/index-1.css', 'sw.js']);
  it("lists only the build's hashed files", () => {
    expect(shell).toEqual(['/assets/index-1.css', '/assets/index-1.js']);
  });
  it('keeps a listed file once asked for, and answers from the copy after', async () => {
    const w = boot(shell);
    expect(await w.request('https://app.example/assets/index-1.js')).toBe('net:https://app.example/assets/index-1.js');
    expect(await w.request('https://app.example/assets/index-1.js')).toBe('net:https://app.example/assets/index-1.js');
    expect(w.fetched).toHaveLength(1);
    expect(w.stores.get(`${SHELL_CACHE_PREFIX}abc123`)?.size).toBe(1);
  });
  it('passes on, but never keeps, a page sent in place of a listed file', async () => {
    const w = boot(shell, () => 'text/html; charset=utf-8');
    expect(await w.request('https://app.example/assets/index-1.js')).toBe('net:https://app.example/assets/index-1.js');
    expect(await w.request('https://app.example/assets/index-1.js')).toBe('net:https://app.example/assets/index-1.js');
    expect(w.fetched).toHaveLength(2);
    expect(w.stores.get(`${SHELL_CACHE_PREFIX}abc123`)?.size ?? 0).toBe(0);
  });
  it('never answers a page load, another origin, an unlisted file or a write', async () => {
    const w = boot(shell);
    expect(await w.request('https://app.example/assets/index-1.js', { mode: 'navigate' })).toBeNull();
    expect(await w.request('https://app.example/')).toBeNull();
    expect(await w.request('https://rpc.example/assets/index-1.js')).toBeNull();
    expect(await w.request('https://app.example/assets/old-0.js')).toBeNull();
    expect(await w.request('https://app.example/assets/index-1.js?x=1')).toBeNull();
    expect(await w.request('https://app.example/assets/index-1.js', { method: 'POST' })).toBeNull();
    expect(w.fetched).toHaveLength(0);
  });
  it("deletes earlier builds' stores on activation and leaves others alone", async () => {
    const w = boot(shell);
    let done: Promise<unknown> = Promise.resolve();
    w.handlers.activate!({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
    expect([...w.stores.keys()]).toEqual(['someone-else']);
  });
  it('refuses a build id that could break out of the string', () => {
    expect(() => serviceWorkerSource("a'b", [])).toThrow();
  });
});
