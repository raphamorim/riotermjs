# benchmark

rioterm vs xterm.js vs wterm on byte-identical workloads. Standalone
package: it does not touch `packages/`; rioterm comes from
`file:../packages/rioterm` (build it first), xterm.js from npm with its
WebGL addon (its fastest renderer), and wterm (`@wterm/dom`, the
Zig-to-wasm engine) from npm with its DOM renderer (the only one it
ships).

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

| metric | xterm.js 6.0 (webgl) | rioterm 0.1.4-dev (canvas) | wterm 0.3.2 (dom) |
| --- | --- | --- | --- |
| init | 30.5 ms | 11.4 ms | 15.3 ms |
| plain throughput | 176 MB/s | 513 MB/s | 48 MB/s |
| ansi throughput | 108 MB/s | 234 MB/s | 129 MB/s |
| altscreen fps | 120.0 (display-capped) | 119.9 (display-capped) | 120.0 (display-capped) |
| altscreen frame p95 | 9.9 ms | 9.2 ms | 9.8 ms |
| scrollback frame p95 | 9.5 ms | 9.1 ms | 9.9 ms |
| JS heap after plain 8MB | 31.2 MB | 4.6 MB | 4.0 MB |

Parser-only (Node, 32MB): plain 168 / 1094 / 51 MB/s, ansi 102 / 236 /
142 MB/s (xterm/headless, rioterm, wterm's `WasmBridge`).

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
- Every engine runs its flagship renderer: webgl for xterm, canvas for
  rioterm, DOM for wterm. Renderer architecture differences are part of
  what is being measured.
- wterm has no scroll API; the scrollback scenario nudges its native DOM
  scroller by whole rows, which is what a user's wheel does anyway.
- All three engines saturate the display refresh in the fps scenarios on
  this hardware; the differentiators there are the percentiles.
