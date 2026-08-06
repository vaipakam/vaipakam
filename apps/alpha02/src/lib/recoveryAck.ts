/**
 * The canonical recovery declaration — the single definition of the
 * string the user signs on `/recover`.
 *
 * It is byte-for-byte the literal whose keccak256 is
 * `VaultFactoryFacet`'s `RECOVERY_ACK_TEXT_HASH` (the concatenated
 * literal at VaultFactoryFacet.sol ~line 717). `Recover` shows it
 * verbatim on the review card so the user reads EXACTLY what the
 * signature commits to, and re-hashes it against the live on-chain
 * value before every signature — a mismatch blocks signing.
 *
 * **Why it lives here rather than in the page.** The copy catalog also
 * needs it: `copy.recover.ackTextTranslation` is the reading aid shown
 * beside it for non-English readers, and its English source has to BE
 * this declaration — that is what makes the nine translations
 * translations OF the signed text rather than of some other sentence.
 * Held as two independent copies (which is how it started, and what
 * Codex #1563 r11 caught) they can silently diverge: nothing binds the
 * page's literal to the catalog's, so a contract update that changes
 * the declaration leaves the aid explaining the OLD one while the user
 * signs the new. One definition, imported by both, removes that
 * possibility for the English side entirely.
 *
 * The nine TRANSLATIONS still have to be re-authored when this string
 * changes — nothing can derive those. `check-locale-coverage.ts` pins
 * this text's hash for exactly that reason: change the declaration and
 * the guard fails until the translations are refreshed, so a stale
 * reading aid cannot ship.
 *
 * DELIBERATELY not itself a translatable catalog entry: translating or
 * rewording it would break the hash equality, so the signed bytes stay
 * contract-fixed English in every locale.
 */
export const RECOVERY_ACK_TEXT =
  // Segment boundaries mirror the Solidity literal one-for-one so a
  // side-by-side diff against the contract is trivial. ASCII
  // apostrophe ("protocol's"), NOT the typographic one the rest of
  // the catalog uses — the hash is byte-sensitive.
  'I am declaring that the source address belongs to a wallet I' +
  ' control or authorized. If the source is later determined to' +
  ' be on the sanctions list, my vault will be locked under the' +
  " protocol's sanctions policy until the address is de-listed." +
  ' I have read and understood the Advanced User Guide section' +
  ' on stuck-token recovery.';

/**
 * The word the user must type to arm the recovery sign button.
 *
 * UI friction, not copy: `Recover` compares the typed input against
 * this literal, so it is untranslatable for the same reason the
 * declaration is — a locale that translated the PROMPT would tell the
 * user to type a word that can never match, permanently disabling
 * signing for every speaker of that language, with no error message
 * because from the app's side they simply haven't typed it yet.
 *
 * `check-locale-coverage.ts` enforces that every translated
 * `copy.recover.confirmPrompt` still contains this token, and imports
 * it from here rather than restating it. A guard holding its own copy
 * of the value it guards can go green while the gate it protects has
 * moved (Codex #1563 r14) — the same duplication that put the
 * declaration in two places above.
 */
export const CONFIRM_WORD = 'CONFIRM';
