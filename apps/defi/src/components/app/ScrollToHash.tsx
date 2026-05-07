import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Scrolls to the element matching `location.hash` whenever the route or hash
 * changes. Needed because React Router suppresses the browser's native
 * hash-anchor behavior on cross-route navigation (e.g. /buy-vpfi → /#features)
 * — the target element does not exist until the new route mounts, so we wait
 * a frame before locating it.
 */
export function ScrollToHash() {
  const { pathname, hash } = useLocation();

  useEffect(() => {
    if (!hash) {
      window.scrollTo({ top: 0 });
      return;
    }
    const id = hash.slice(1);
    const scroll = () => {
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return true;
      }
      return false;
    };
    // Target may not exist on first paint after a route change.
    if (scroll()) return;
    let tries = 0;
    const handle = window.setInterval(() => {
      tries += 1;
      if (scroll() || tries > 20) window.clearInterval(handle);
    }, 50);
    return () => window.clearInterval(handle);
  }, [pathname, hash]);

  return null;
}
