/**
 * #3734 — what the visitor ticked before the wallet list opened: the Terms
 * version and fingerprint in force on one network. The step that follows a
 * connection reads it to know which Terms the visitor has already read, so
 * the signature it asks for names the same pair. It is a note in memory for
 * this page only: it is not an acceptance, it is never stored, and a reload
 * starts again from the Terms.
 */
type Hex = `0x${string}`;

export interface TermsTicked {
  chainId: number;
  version: number;
  hash: Hex;
  at: number;
}

let ticked: TermsTicked | null = null;

export function noteTermsTicked(t: Omit<TermsTicked, 'at'>): void {
  ticked = { ...t, at: Date.now() };
}

/** The pair ticked for this network, when it is the one now asked for. */
export function tickedFor(chainId: number, version: number, hash: Hex): TermsTicked | null {
  return ticked && ticked.chainId === chainId && ticked.version === version && ticked.hash === hash ? ticked : null;
}

export function clearTermsTicked(): void {
  ticked = null;
}
