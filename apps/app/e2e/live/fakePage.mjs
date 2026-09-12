/**
 * Minimal stand-ins for a Playwright Page's EVENT surface, for unit tests of
 * the helpers that only ever subscribe to it.
 *
 * `watchPageRpc` (driver.mjs) and the page-head tracker (`pageHead.mjs`,
 * #2120) both take a page and call nothing on it but `on(...)`; everything
 * they learn arrives through the events. A fake that records the handlers
 * and lets a test emit is therefore the whole page, as far as they can tell.
 *
 * One definition, shared by the suites, for #2102's reason: the first copy
 * lived inline in `watchPageRpc.test.mjs`, and a second suite needing the
 * same eight lines is where a second copy starts.
 */
export class FakePage {
  constructor() {
    this.handlers = {};
  }
  on(event, fn) {
    (this.handlers[event] ??= []).push(fn);
  }
  emit(event, arg) {
    for (const fn of this.handlers[event] ?? []) fn(arg);
  }
}

/** A Playwright WebSocket's event surface — the same shape, one level down. */
export class FakeWebSocket extends FakePage {}
