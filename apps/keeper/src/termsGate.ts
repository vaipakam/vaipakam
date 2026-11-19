// apps/keeper/src/termsGate.ts
//
// #3734 — the keeper's side of the Terms rule in its fill passes.
//
// The contracts refuse a new position for a wallet that has not accepted the
// Terms of Service in force (`LibTerms`, hosted by `LegalFacet`), and the
// match and intent previews report that refusal as
// `MatchError.TermsNotAccepted`. The keeper records no acceptance for anyone
// and sends nothing the rule refuses. What it adds here:
//
//   - the REASON: the first pair a wallet's refusal stops is followed by a
//     read of which party is not current (`isTermsCurrent`), and the run log
//     names that wallet once, with the reason;
//   - no repeated previews: every later pair naming a wallet found not
//     current is passed over for the rest of the run, since its answer
//     cannot change within a run unless the wallet accepts, which the next
//     run sees.
//
// A wallet whose standing cannot be read is not marked: the pair was still
// refused (nothing is sent), and the line says the party was not read.

import { type Abi, type Address, type PublicClient } from 'viem';
import { LegalFacetABI } from '@vaipakam/contracts/abis';

/** `LibOfferMatch.MatchError.TermsNotAccepted` (#3734), reported by
 *  `previewMatch` and, as `matchError`, by `previewIntent`. Appended last to
 *  the enum, so it never moves. */
export const MATCH_ERR_TERMS_NOT_ACCEPTED = 27;

/** Reads whether `wallet` is current on the Terms; null when it cannot be read. */
export type TermsCurrentRead = (wallet: Address) => Promise<boolean | null>;

/** The read over a Diamond. */
export function termsCurrentReader(client: Pick<PublicClient, 'readContract'>, diamond: Address): TermsCurrentRead {
  return async (wallet) => {
    try {
      return (await client.readContract({
        address: diamond,
        abi: LegalFacetABI as Abi,
        functionName: 'isTermsCurrent',
        args: [wallet],
      })) as boolean;
    } catch {
      return null;
    }
  };
}

/** One run's record of the wallets the Terms rule stopped. */
export class TermsGate {
  private readonly blocked = new Set<string>();
  private readonly checked = new Set<string>();

  constructor(
    private readonly read: TermsCurrentRead,
    private readonly log: (line: string) => void,
  ) {}

  /** Whether `wallet` was found not current this run. */
  blocks(wallet: Address): boolean {
    return this.blocked.has(wallet.toLowerCase());
  }

  /** How many wallets this run found not current. */
  get count(): number {
    return this.blocked.size;
  }

  /**
   * A preview refused `what` for the Terms. Reads each party not read yet
   * this run, marks those not current and names each once. Returns the
   * wallets marked by this call.
   */
  async refused(what: string, parties: readonly Address[]): Promise<Address[]> {
    const marked: Address[] = [];
    let unread = 0;
    for (const p of parties) {
      const key = p.toLowerCase();
      if (this.blocked.has(key)) continue;
      if (this.checked.has(key)) continue;
      // eslint-disable-next-line no-await-in-loop
      const current = await this.read(p);
      if (current === null) {
        unread += 1;
        continue;
      }
      this.checked.add(key);
      if (!current) {
        this.blocked.add(key);
        marked.push(p);
        this.log(
          `terms: ${what} refused: wallet ${p} has not accepted the Terms in force, so nothing is filled for it this run (no acceptance is recorded for a wallet but by its own transaction)`,
        );
      }
    }
    if (marked.length === 0 && !parties.some((p) => this.blocked.has(p.toLowerCase()))) {
      this.log(
        `terms: ${what} refused for the Terms; ${unread > 0 ? `${unread} party standing(s) not read` : 'no party reads as not current now'}, nothing sent`,
      );
    }
    return marked;
  }
}
