/** Types for `cspScriptHashes.mjs`, imported by the web surfaces' builds and its test. */

export const SCRIPT_HASHES_PLACEHOLDER: string;
export function inlineScriptBodies(html: string): string[];
export function sha256Source(body: string): string;
export function scriptHashSources(html: string): string[];
export function applyScriptHashes(headers: string, sources: string[]): string;
export function policyScriptSources(headers: string): string[];
export function uncoveredScripts(html: string, allowed: string[]): string[];
/** Structurally a Vite plugin; typed loosely so this package needs no Vite. */
export function cspScriptHashesPlugin(options?: { missingHeadersHint?: string }): {
  name: string;
  apply: 'build';
  writeBundle(this: { error(message: string): never }, output: { dir?: string }): void;
};
