/** Types for `cspConnectSources.mjs`, imported by the web surfaces' builds and its test. */

export const CONNECT_SOURCES_PLACEHOLDER: string;
export const ENFORCED_HEADER: 'Content-Security-Policy';
export const REPORT_ONLY_HEADER: 'Content-Security-Policy-Report-Only';
export type PolicyHeader = typeof ENFORCED_HEADER | typeof REPORT_ONLY_HEADER;
export function connectSource(url: string): string;
export function policyConnectSources(headers: string, header?: PolicyHeader): string[];
export function applyConnectSources(headers: string, sources: string[], header?: PolicyHeader): string;
/** Structurally a Vite plugin; typed loosely so this package needs no Vite. */
export function cspConnectSourcesPlugin(options: {
  sources: () => string[];
  header?: PolicyHeader;
  missingHeadersHint?: string;
}): {
  name: string;
  apply: 'build';
  writeBundle(this: { error(message: string): never }, output: { dir?: string }): void;
};
