/**
 * #3769 — the link to one loan that its borrower-position holder shares
 * with whoever will repay it. A loan number is only unique on one network,
 * so the link names the network, and a page opened on another network says
 * so instead of showing a different loan with the same number.
 */
export const LOAN_LINK_CHAIN_PARAM = 'chain';

export function loanLink(origin: string, loanId: bigint, chainId: number): string {
  return `${origin}/positions/${loanId.toString()}?${LOAN_LINK_CHAIN_PARAM}=${chainId}`;
}

/** The network a link names: `undefined` when it names none (an older
 *  link, or the app's own navigation), `null` when what it names is not a
 *  network id. */
export function linkChainId(raw: string | null): number | null | undefined {
  if (raw === null) return undefined;
  if (!/^[1-9][0-9]{0,15}$/.test(raw)) return null;
  return Number(raw);
}
