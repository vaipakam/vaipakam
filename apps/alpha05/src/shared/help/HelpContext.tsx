import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { CopyKey } from '../copy/useCopy';

/**
 * RB-HELP — one help system. A "Why?" link anywhere on a page asks the
 * provider to open the panel with a copy KEY (never a string), so the panel
 * renders the tier-C explanation and the guide link from the same catalog
 * entry the inline summary came from, in the active language. One panel
 * per app: opening a second request replaces the first.
 */
export interface HelpRequest {
  /** The tier-B summary the link sat beside; the panel's heading. */
  summaryKey: CopyKey;
  /** Placeholder values the summary was rendered with, if any. */
  vars?: Readonly<Record<string, string>>;
  /** The tier-C explanation (and its guide anchor). */
  detailKey: CopyKey;
  /** The element to return focus to when the panel closes. */
  returnTo: HTMLElement | null;
}

interface HelpContextValue {
  request: HelpRequest | null;
  open: (request: HelpRequest) => void;
  close: () => void;
}

const HelpContext = createContext<HelpContextValue | null>(null);

export function HelpProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<HelpRequest | null>(null);
  const open = useCallback((r: HelpRequest) => setRequest(r), []);
  const close = useCallback(() => setRequest(null), []);
  const value = useMemo(() => ({ request, open, close }), [request, open, close]);
  return <HelpContext.Provider value={value}>{children}</HelpContext.Provider>;
}

export function useHelp(): HelpContextValue {
  const ctx = useContext(HelpContext);
  if (!ctx) throw new Error('useHelp outside HelpProvider');
  return ctx;
}
