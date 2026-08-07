/**
 * The word the user must type to arm the vault-recovery signature.
 *
 * UI friction, not copy: `VaultRecover` compares the typed input
 * against this literal, so it is untranslatable — a locale that
 * translated the PROMPT would tell the user to type a word that can
 * never match, permanently disabling recovery signing for every
 * speaker of that language, with no error message because from the
 * app's side they simply haven't typed it yet.
 *
 * One definition, three consumers: the gate, the input placeholder,
 * and `src/i18n/translation-policy.json` (cross-checked against this
 * constant by the translate script). Held as separate copies they can
 * drift, and the drift is silent in the worst direction — a policy
 * still protecting the OLD word would pass every check while the live
 * gate wants the new one (Codex #1563 r19).
 */
export const RECOVERY_CONFIRM_WORD = 'CONFIRM';
