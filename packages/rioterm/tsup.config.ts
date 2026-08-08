import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  // The wasm-bindgen glue ships as plain files in ./wasm so that
  // `new URL('librio_wasm_bg.wasm', import.meta.url)` keeps pointing at
  // the binary; bundling it would break that resolution.
  external: [/librio_wasm/],
});
