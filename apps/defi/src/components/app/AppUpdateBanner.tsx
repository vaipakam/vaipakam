/**
 * "A new version is available — Reload" banner.
 *
 * Stale-bundle protection: a SPA tab left open across a deploy keeps
 * running the old JS, and even a plain reload can serve a cached
 * `index.html` referencing the old content-hashed chunks (browser HTTP
 * cache + the service-worker's Cache Storage, which "unregister" does
 * not delete). The symptom downstream is e.g. `loadLoanIndex`'s
 * "chain config not resolved (deployBlock=0)" guard firing because the
 * stale bundle predates a `deployments.json` update.
 *
 * This banner detects the mismatch and offers a one-click reload:
 *   - On mount, every CHECK_INTERVAL_MS, and on tab-focus it does ONE
 *     `fetch('/index.html', { cache: 'no-store' })` (cheap; no chain
 *     RPC) and pulls out the deployed entry-chunk filename
 *     (`/assets/index-<hash>.js`).
 *   - It compares that with the chunk THIS page actually loaded (read
 *     off the `<script type="module">` tag). Vite content-hashes the
 *     filename, so a different hash ⇒ a newer build is deployed.
 *   - On "Reload": nudge any controlling service worker to update
 *     (so its Cache Storage refreshes), then `location.reload()` — the
 *     deployed `index.html` is served `Cache-Control: max-age=0,
 *     must-revalidate` (see `public/_headers`), so a normal reload
 *     then picks up the fresh chunks.
 *
 * Mounted in AppLayout (every connected-app page). Silent until a
 * mismatch is detected; if the loaded-chunk can't be determined it
 * disables itself entirely (no false positives).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import './AppUpdateBanner.css';

/** Re-check cadence. The check is a single conditional GET of
 *  `/index.html`; 5 min is plenty for "you've been on a stale tab". */
const CHECK_INTERVAL_MS = 5 * 60_000;

const ENTRY_CHUNK_RE = /\/assets\/index-[\w-]+\.js/;

/** The main entry chunk this page loaded — `/assets/index-<hash>.js` —
 *  read off the module script tag Vite injected into `index.html`. */
function loadedEntryChunk(): string | null {
  for (const s of Array.from(document.scripts)) {
    const m = s.src.match(ENTRY_CHUNK_RE);
    if (m) return m[0];
  }
  return null;
}

/** The entry chunk the currently-deployed `index.html` references, or
 *  `null` on a network blip / parse miss (caller retries next tick). */
async function deployedEntryChunk(): Promise<string | null> {
  try {
    const res = await fetch('/index.html', { cache: 'no-store' });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(ENTRY_CHUNK_RE);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

export function AppUpdateBanner() {
  const { t } = useTranslation();
  const [stale, setStale] = useState(false);
  const [reloading, setReloading] = useState(false);
  const loadedChunkRef = useRef<string | null>(null);

  useEffect(() => {
    loadedChunkRef.current = loadedEntryChunk();
    // If we can't tell which chunk loaded this page, disable the
    // feature — better silent than crying wolf.
    if (!loadedChunkRef.current) return;

    let cancelled = false;
    const check = async () => {
      const deployed = await deployedEntryChunk();
      if (cancelled) return;
      if (deployed && deployed !== loadedChunkRef.current) setStale(true);
    };
    void check();
    const id = setInterval(() => void check(), CHECK_INTERVAL_MS);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const onReload = useCallback(async () => {
    if (reloading) return;
    setReloading(true);
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      await reg?.update();
    } catch {
      /* no service worker, or update failed — the reload below still
         re-fetches index.html (must-revalidate) and the new chunks. */
    }
    window.location.reload();
  }, [reloading]);

  if (!stale) return null;

  return (
    <div className="app-update-banner" role="status" aria-live="polite">
      <RefreshCw size={15} aria-hidden="true" />
      <span>
        {t('appUpdate.message', {
          defaultValue: 'A new version of Vaipakam is available.',
        })}
      </span>
      <button
        type="button"
        className="app-update-reload"
        onClick={onReload}
        disabled={reloading}
      >
        {reloading
          ? t('appUpdate.reloading', { defaultValue: 'Reloading…' })
          : t('appUpdate.reload', { defaultValue: 'Reload' })}
      </button>
    </div>
  );
}
