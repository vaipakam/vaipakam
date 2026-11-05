/**
 * The own rail's signals (RB-REFRESH): a confirmed action of the user's
 * own, or a push hint naming the account, tells every own-state read for
 * that identity to re-read now, in EVERY open tab of this app (a
 * BroadcastChannel carries it across tabs; the in-process list carries it
 * within one). A signal carries the identity and the cause, never a
 * balance: a receipt triggers reconciliation, it does not carry figures.
 */
export interface OwnSignal {
  chainId: number;
  account: `0x${string}`;
  cause: 'receipt' | 'push';
}

export const OWN_SIGNAL_CHANNEL = 'vaipakam-alpha05-own';

type Listener = (signal: OwnSignal) => void;
const listeners = new Set<Listener>();

let channel: BroadcastChannel | null = null;
function openChannel(): BroadcastChannel | null {
  if (channel !== null) return channel;
  if (typeof BroadcastChannel === 'undefined') return null;
  try {
    channel = new BroadcastChannel(OWN_SIGNAL_CHANNEL);
    channel.onmessage = (ev) => {
      const s = ev.data as OwnSignal;
      if (s && typeof s.chainId === 'number' && typeof s.account === 'string') {
        for (const l of listeners) l(s);
      }
    };
  } catch {
    channel = null;
  }
  return channel;
}

export function announceOwnChange(signal: OwnSignal): void {
  for (const l of listeners) l(signal);
  try {
    openChannel()?.postMessage(signal);
  } catch {
    /* another tab is a bonus, not a requirement */
  }
}

export function subscribeOwnChanges(listener: Listener): () => void {
  listeners.add(listener);
  openChannel();
  return () => {
    listeners.delete(listener);
  };
}

export function matchesIdentity(signal: OwnSignal, chainId: number, account: `0x${string}`): boolean {
  return signal.chainId === chainId && signal.account.toLowerCase() === account.toLowerCase();
}
