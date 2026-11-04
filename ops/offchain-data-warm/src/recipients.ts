/**
 * The recipient public keys the nightly encrypts to (#1463; design §3.3).
 *
 * They are committed in `../backup-recipients/recipients.json` and bundled at
 * build time, so a change of recipient is a reviewed commit, never a
 * dashboard edit, and nothing about them is a Worker secret. The file lists
 * every set the Worker has ever used, each with the time it took effect; the
 * run uses the set in force when it starts. The backup watcher reads the same
 * file to judge each archive against the set in force when it was written.
 */

import recipientsJson from '../backup-recipients/recipients.json';
import { parseRecipientsFile, recipientSetAt, type RecipientSet } from './archiveFormat';

/** The set this run writes to. Throws before any export when none is in force. */
export function recipientSetForRun(nowMs: number): RecipientSet {
  const set = recipientSetAt(parseRecipientsFile(recipientsJson), nowMs);
  if (!set) {
    throw new Error(
      `BACKUP ABORT: no recipient set in backup-recipients/recipients.json is in force at ${new Date(nowMs).toISOString()}`,
    );
  }
  return set;
}
