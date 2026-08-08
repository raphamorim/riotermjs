import { defineConfig } from 'vite';

// Cross-origin isolation enables SharedArrayBuffer for the wasix bash;
// docs/public/_headers does the same on Cloudflare Pages.
const coi = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  // Served from Pages under the repository path.
  base: process.env.PAGES_BASE ?? '/riotermjs/',
  optimizeDeps: {
    // Prebundling would break the glue's `new URL(..., import.meta.url)`
    // reference to the wasm binaries.
    exclude: ['rioterm', '@wasmer/sdk'],
  },
  server: { headers: coi },
  preview: { headers: coi },
  esbuild: {
    jsx: 'automatic',
  },
});
