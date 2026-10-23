/** Types for `cspScriptHashes.mjs`, imported by `vite.config.ts` and its test. */

export const SCRIPT_HASHES_PLACEHOLDER: string;
export function inlineScriptBodies(html: string): string[];
export function sha256Source(body: string): string;
export function scriptHashSources(html: string): string[];
export function applyScriptHashes(headers: string, sources: string[]): string;
