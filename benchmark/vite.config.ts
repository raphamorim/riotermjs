import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: {
    // Pre-bundling would break rioterm's `new URL(..., import.meta.url)`
    // wasm resolution.
    exclude: ['rioterm'],
  },
});
