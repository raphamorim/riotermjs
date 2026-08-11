# docs site

The rioterm docs site (riotermjs.pages.dev). Built with
[oj](https://github.com/raphamorim/oj), a Rust-native build tool, instead of
Vite. Configuration lives in `oj.config.ts`: `base`, and the COOP/COEP
`server.headers`/`preview.headers` needed for the SharedArrayBuffer bash. The
`?url` asset import (the v86 wasm) and `import.meta.env` work out of the box.

## Prerequisites

`oj` must be on your `PATH`:

```sh
cargo install oj
```

## Commands

```sh
npm run dev -w docs      # oj dev server (fetches VM assets first)
npm run build -w docs    # oj build into docs/dist
npm run preview -w docs  # serve the build
```

The `predev`/`prebuild` steps fetch the Linux image, build the v86 snapshot,
and fetch the wasix bash webc before the tool runs.
