import { defineConfig } from 'vite';

export default defineConfig({
  // Served from GitHub Pages under the repository path.
  base: process.env.PAGES_BASE ?? '/riotermjs/',
  optimizeDeps: {
    // Prebundling would break the glue's `new URL(..., import.meta.url)`
    // reference to the wasm binary.
    exclude: ['rioterm'],
  },
  esbuild: {
    jsx: 'automatic',
  },
});
