import { useEffect, useState } from 'react';

/** The current time in unix milliseconds, re-read every `everyMs`, so a
 *  stated age or a deadline stage moves on while the page stays open
 *  without reading the clock during render. */
export function useNow(everyMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}
