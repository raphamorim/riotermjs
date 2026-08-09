import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: {
    // Pre-bundling would break the `new URL(..., import.meta.url)` wasm
    // resolution these packages use, and on-the-fly re-optimization
    // reloads the page mid-benchmark. @wterm/ghostty ships its libghostty
    // binary this way; rioterm ships librio the same way.
    exclude: ['rioterm', '@wterm/ghostty'],
  },
});
