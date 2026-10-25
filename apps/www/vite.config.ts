import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { cspScriptHashesPlugin } from '@vaipakam/lib/cspScriptHashes';

// Minimal Vite config for the marketing SPA.
//
// #43 (ET-017) — the Content-Security-Policy allows inline scripts only by
// hash. The shared plugin writes the hashes of the BUILT page's inline
// scripts into the built `_headers`, replacing the placeholder
// `public/_headers` carries in `script-src`, and throws rather than ship a
// policy it could not complete. The prerender then refuses any snapshot
// whose inline scripts that policy does not allow. See
// packages/lib/src/cspScriptHashes.mjs.
export default defineConfig({
  plugins: [react(), cspScriptHashesPlugin() as Plugin],
});
