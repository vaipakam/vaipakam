import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Minimal Vite config for the labs marketing SPA. Stage 4
// population may add SEO plumbing (sitemap generator + meta
// injection — same shape as apps/defi's postbuild scripts) once
// real pages land. For the stub, defaults are fine.
export default defineConfig({
  plugins: [react()],
});
