// Storage polyfill — MUST run before any module that touches localStorage
// at import time (notably `../src/i18n`, whose LanguageDetector seeds from
// localStorage/cookies at module scope). ESM evaluates imports before the
// importing module's body, so this lives in its own module and is imported
// FIRST in setup.ts (Codex #1088 r1): a body-level guard would run too late.
//
// Some vitest/jsdom environments expose a `localStorage` without a full
// Storage API (no `.clear`/`.getItem`), which makes the afterEach cleanup —
// and any test that reads/writes localStorage — throw, failing the WHOLE
// suite. Install a Map-backed Storage polyfill when it's missing or partial.
if (
  typeof globalThis.localStorage === 'undefined' ||
  typeof globalThis.localStorage.clear !== 'function'
) {
  const store = new Map<string, string>();
  const polyfill: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    key: (index) => Array.from(store.keys())[index] ?? null,
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: polyfill,
    configurable: true,
    writable: true,
  });
}
