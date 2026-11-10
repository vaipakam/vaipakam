/**
 * ACC-11 — installing the app, and the service worker that keeps this
 * build's files (serviceWorkerSource.ts states what it keeps and what it
 * never touches).
 *
 * The browser offers installation through a `beforeinstallprompt` event that
 * fires once, early, and only where it will install this site; the app keeps
 * the event so Settings can offer the browser's own prompt later. Where no
 * event comes (Safari, Firefox, a browser that judges the site not
 * installable, or an app already installed) Settings says which case it is,
 * never a button that would do nothing.
 */
import { useSyncExternalStore } from 'react';
import { OWN_WORKER_PATH, removeForeignWorkers } from './foreignWorkers';

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type WorkerState = { kind: 'off' } | { kind: 'unsupported' } | { kind: 'registering' } | { kind: 'active' } | { kind: 'failed'; reason: string };

export interface InstallState {
  /** The browser offered its install prompt and it has not been used. */
  canPrompt: boolean;
  /** This page runs as the installed app, or the browser reported it installed. */
  installed: boolean;
  /** An iPhone or iPad browser, which installs only through Share › Add to Home Screen. */
  ios: boolean;
  worker: WorkerState;
}

let deferred: InstallPromptEvent | null = null;
let state: InstallState = { canPrompt: false, installed: false, ios: false, worker: { kind: 'off' } };
const listeners = new Set<() => void>();

function set(next: Partial<InstallState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function standalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia?.('(display-mode: standalone)').matches === true || nav.standalone === true;
}

/** Starts listening for the browser's offer, and registers the worker in a
 *  production build. Called once, before the first render. */
export function startInstall(): void {
  set({ installed: standalone(), ios: /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) });
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    set({ canPrompt: true });
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    set({ canPrompt: false, installed: true });
  });
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) {
    set({ worker: { kind: 'unsupported' } });
    return;
  }
  set({ worker: { kind: 'registering' } });
  const container = navigator.serviceWorker;
  // Foreign workers go first (foreignWorkers.ts); a failed check never stops
  // this build's own worker being registered.
  removeForeignWorkers(container, window.location.origin)
    .then(
      ({ found, removed }) => {
        if (found > 0) console.warn(`[sw] removed ${removed} of ${found} service worker(s) this app did not install`);
      },
      (e: unknown) => console.warn('[sw] could not check for foreign service workers', e),
    )
    .then(() => container.register(OWN_WORKER_PATH, { scope: '/' }))
    .then(
      () => set({ worker: { kind: 'active' } }),
      (e: unknown) => set({ worker: { kind: 'failed', reason: e instanceof Error && e.message ? e.message : 'the browser refused it' } }),
    );
}

/** Opens the browser's own install prompt; the answer is the browser's. */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const e = deferred;
  if (!e) return 'unavailable';
  deferred = null;
  set({ canPrompt: false });
  await e.prompt();
  const { outcome } = await e.userChoice;
  return outcome;
}

export function useInstall(): InstallState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}
