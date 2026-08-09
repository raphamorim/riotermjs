# benchmark

rioterm vs xterm.js vs wterm on byte-identical workloads. Standalone
package: it does not touch `packages/`; rioterm comes from
`file:../packages/rioterm` (build it first), xterm.js from npm with its
WebGL addon (its fastest renderer), and wterm (`@wterm/dom`) from npm
with its DOM renderer, run on both of its VT cores: the default Zig core
and the libghostty core (`@wterm/ghostty`).

```sh
npm install
npm run bench        # browser matrix via your installed Chrome
npm run bench:parse  # parser-only, no DOM: all three engines headless in Node
```

Every engine gets a fixed 120x40 grid, the same font, the same chunked
input. Every scenario warms up first, then reports the median of three
runs. `results.json` gets the full numbers.

## Scenarios

- **plainThroughput / ansiThroughput**: MB/s from first byte submitted to
  everything parsed and a frame painted (8MB per run).
- **altScreenFps**: a TUI redrawing the whole screen every frame
  (top-style), frame submitted, parsed, painted; reports achieved fps and
  frame-time percentiles.
- **scrollbackScroll**: scrollback navigation with a full buffer.
- **init**: component creation to first rendered frame, fresh page.
- **node-parse**: pure VT engine cost, 32MB through each parser headless.

## Sample results

Apple Silicon, Chrome 143 headless, 2026-08. Medians; run your own.

| metric | xterm.js 6.0 (webgl) | rioterm 0.1.4 (canvas) | rioterm 0.1.4 (dom) | wterm 0.3.2 (zig dom) | wterm 0.3.2 (ghostty dom) |
| --- | --- | --- | --- | --- | --- |
| init | 33.7 ms | 18.6 ms | 19.6 ms | 17.0 ms | 12.1 ms |
| plain throughput | 178 MB/s | 576 MB/s | 501 MB/s | 51 MB/s | 1.6 MB/s |
| ansi throughput | 108 MB/s | 251 MB/s | 247 MB/s | 136 MB/s | 1.2 MB/s |
| altscreen fps | 119.9 (capped) | 119.9 (capped) | 120.0 (capped) | 120.0 (capped) | 120.0 † |
| altscreen frame p95 | 10.0 ms | 8.5 ms | 8.5 ms | 9.0 ms | 9.0 ms † |
| scrollback frame p95 | 9.2 ms | 8.7 ms | 9.1 ms | 9.2 ms | 9.0 ms † |
| JS heap after plain 8MB | 25.0 MB | 4.6 MB | 4.8 MB | 3.7 MB | 4.5 MB |

† The frame scenarios write only ~5 KB per frame, which fits the frame
budget even at 1.5 MB/s, so the libghostty core reads as "keeps up" here.
It does not under real output: at 1-2 MB/s it is throughput-bound (see the
rows above), and these frame numbers should be read as "not measured
against its actual bottleneck," not as a pass.

wterm ships two cores behind the same DOM renderer: its own minimal Zig
core (default) and a libghostty core (`@wterm/ghostty`). The libghostty
core is the real Ghostty VT parser (vendored from source, v1.3.1), but
as published (0.3.2) it is a size-first wasm build — Zig `ReleaseSmall`
with SIMD disabled (`.simd = false`) — so the scalar fallback paths run
and it parses at ~1-2 MB/s, two-plus orders of magnitude below the
others, dominating the frame budget under any real output. That is the
shipped npm build, not Ghostty's native `ReleaseFast`+SIMD speed; it is
included because it is the only way to run wterm on libghostty today.
Both wterm rows use the same renderer; only the VT engine differs.

Parser-only (Node, 32MB): plain 167 / 1095 / 51 / 1.9 MB/s, ansi 101 /
233 / 142 / 1.4 MB/s (xterm/headless, rioterm, wterm zig, wterm
ghostty). The two rioterm renderers share one engine, so the parser-only
row is identical for both.

rioterm's init dropped from ~19 ms to ~11 ms when the web build went on
a diet: kitty image decode and glyph-protocol font parsing are now
feature-gated out of the wasm (2.2 MB to 1.1 MB), which also shrinks
the lazy-compile jitter that used to show up in early frame times.

## Honest caveats

- rioterm and wterm keep their grids in wasm linear memory, which
  `performance.memory.usedJSHeapSize` does not count; the JS-heap row
  overstates both wasm engines' memory advantage over xterm.
- xterm's write path is asynchronous (internal parse queue); rioterm's
  and wterm's are synchronous into their wasm cores. Throughput runs
  measure submit-to-parsed-and-painted for all three, which is the fair
  comparison, but per-call latency profiles differ by design.
- Renderers vary by engine: webgl for xterm, canvas and DOM for rioterm,
  DOM for both wterm cores. Renderer architecture is part of what is
  being measured; the two wterm rows isolate the VT engine by holding
  the renderer fixed.
- The libghostty core is loaded through wterm's documented `core` option
  (`GhosttyCore.load()`); in Node its wasm is handed over as a data: URL
  since Node's fetch has no file:// scheme.
- wterm has no scroll API; the scrollback scenario nudges its native DOM
  scroller by whole rows, which is what a user's wheel does anyway.
- All engines saturate the display refresh in the fps scenarios on this
  hardware; the differentiators there are the percentiles.
