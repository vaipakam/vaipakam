/**
 * A minimal `renderHook` for unit tests that must drive a React hook
 * directly (#2090) — mount, re-render, unmount, and `act` around anything
 * that moves its state.
 *
 * Written here rather than taken from `@testing-library/react` because the
 * app's test runner is deliberately framework-light (`vitest.config.ts`),
 * and this is the whole of what a hook test needs: React's own `act` and a
 * root. A test using it opts into the DOM per file with
 * `// @vitest-environment jsdom`; the rest of the suite stays on `node`.
 *
 * Not imported by the app, so it never reaches a bundle.
 */
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

// React only flushes effects synchronously inside `act` when it is told
// it is running under a test harness.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface RenderedHook<P, R> {
  /** The hook's latest return value. */
  readonly result: { current: R };
  rerender: (props: P) => Promise<void>;
  unmount: () => Promise<void>;
}

export async function renderHook<P, R>(
  hook: (props: P) => R,
  options: {
    initialProps: P;
    wrapper?: (children: ReactNode) => ReactNode;
  },
): Promise<RenderedHook<P, R>> {
  const result = { current: undefined as R };
  function Probe({ props }: { props: P }) {
    result.current = hook(props);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  const render = (props: P) => {
    const probe = createElement(Probe, { props });
    root.render(options.wrapper ? options.wrapper(probe) : probe);
  };
  await act(async () => render(options.initialProps));
  return {
    result,
    rerender: (props) => act(async () => render(props)),
    unmount: () => act(async () => root.unmount()),
  };
}

/** Let pending promises, the effects they schedule and TanStack's
 *  batched notifications (delivered on a zero-delay timer) all run,
 *  inside `act`. */
export async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}
