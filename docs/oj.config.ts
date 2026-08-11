import { defineConfig } from "oj";

// Cross-origin isolation enables SharedArrayBuffer for the wasix bash;
// docs/public/_headers does the same on Cloudflare Pages.
const coi = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  // Served from Pages under the repository path.
  base: process.env.PAGES_BASE ?? "/riotermjs/",
  server: { headers: coi },
  preview: { headers: coi },
});
