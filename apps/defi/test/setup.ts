// Storage polyfill FIRST — before ../src/i18n touches localStorage at
// import time (Codex #1088 r1). Import order = side-effect order in ESM.
import './setup-storage';
import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

// #1076: initialise i18next exactly as the app does (`main.tsx` does
// `import './i18n'`). Without this, `t('riskGauge.ltvWarning')` returns
// the raw KEY in tests, so every assertion on user-visible copy failed.
// Eager English bundles → `t()` resolves synchronously after import.
import '../src/i18n';

configure({ asyncUtilTimeout: 5_000 });

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

// jsdom lacks matchMedia
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}

// jsdom lacks ResizeObserver used by some libs
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).ResizeObserver = (globalThis as any).ResizeObserver ?? RO;
