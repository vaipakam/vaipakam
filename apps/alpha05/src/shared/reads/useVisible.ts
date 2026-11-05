import { useEffect, useState } from 'react';

/** Whether the tab is visible: every bounded refresh interval pauses while it
 *  is hidden (RB-REFRESH). */
export function useVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');
  useEffect(() => {
    const on = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return visible;
}
