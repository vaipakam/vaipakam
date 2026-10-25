/** Types for `cspConnectSources.mjs`, imported by the web surfaces' builds and its test. */

export const CONNECT_SOURCES_PLACEHOLDER: string;
export function connectSource(url: string): string;
export function policyConnectSources(headers: string): string[];
export function applyConnectSources(headers: string, sources: string[]): string;
/** Structurally a Vite plugin; typed loosely so this package needs no Vite. */
export function cspConnectSourcesPlugin(options: { sources: () => string[]; missingHeadersHint?: string }): {
  name: string;
  apply: 'build';
  writeBundle(this: { error(message: string): never }, output: { dir?: string }): void;
};
