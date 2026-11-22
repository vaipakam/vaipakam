/**
 * The one character rule for free text shown in a bot message (#3346 moved
 * it here from `message.ts`, so the alert phrase and the keeper's free fields
 * share it). Letters, digits, spaces and the few marks an amount or a token
 * label needs; no `/`, `:` or `@`, so no link or handle can be formed.
 * Combining marks (`\p{M}`) are allowed since #3346: Tamil, Hindi and other
 * scripts write vowels with them, so a phrase in those scripts needs them,
 * and a mark cannot form a link.
 */
export const PLAIN = /^[\p{L}\p{M}\p{N} .,#×()_\-…?]{1,96}$/u;

/** A dot before a letter, as in a bare domain (`evil.example`). Telegram makes
 *  a bare domain a link, so a free field shows such a dot as a one-dot leader
 *  (`․`), and the alert phrase refuses it. */
export const DOMAIN_DOT = /\.(?=\p{L})/gu;
